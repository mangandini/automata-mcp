import type { AppInstance } from './app-db'
import { evolutionClientForInstance } from './evolution'
import type { MessageKey } from './evolution-db'
// Imported for `getInstanceStatus` only, called after a failure. `instances.ts`
// imports this module back (`deleteInstance` evicts the cache), a cycle that is
// harmless because neither side uses the other at load time.
import { getInstanceStatus } from './instances'
import { parseEvolutionMediaBody, readBodyCapped, readBodyPrefix, sha256Matches } from './media-body.ts'
import type { EvolutionMedia } from './media-body.ts'
import { cacheBytesFrom, linkCapFrom, MEDIA_READ_CAP_BYTES, maxResponseBodyBytes } from './media-budget.ts'
import { classifyEvolutionFailure, evolutionErrorText, MediaError, mediaFailureMessage } from './media-errors.ts'
import type { MediaFailureKind } from './media-errors.ts'
import { createCooldown, createInflight, createMediaCache, createSemaphore, mediaCacheKey } from './media-memory.ts'
import type { MediaCacheEntry } from './media-memory.ts'
import type { JsonRecord } from './message-payload.ts'

/**
 * The one place a WhatsApp attachment is fetched from Evolution. The MCP tool
 * and the public download link both come through `downloadVerifiedMedia`, so
 * the size cap, the checksum, the cache, the cooldown and the concurrency gate
 * exist once.
 *
 * What it does NOT do is authorize. See `downloadVerifiedMedia`.
 */

/** Evolution's re-upload request to the phone has no timeout of its own, so we bound it. */
const DOWNLOAD_TIMEOUT_MS = 30_000
/** After a timeout the phone's re-upload is still pending in Evolution; asking again only queues behind it. */
const COOLDOWN_MS = 2 * 60_000
/** Absolute from the moment the entry was stored; a read never extends it. */
const CACHE_TTL_MS = 10 * 60_000
/** Downloads and attachment processing together, per process. */
const MAX_CONCURRENT = 2
const SLOT_WAIT_MS = 20_000
/** How much of an Evolution error body is read, for the server log. */
const ERROR_TEXT_BYTES = 64 * 1024
/** The account-state read after a failure is a courtesy and must not hold the answer. */
const STATE_READ_MS = 5_000

/** Read cap fixed; the other two from runtimeConfig, parsed by `linkCapFrom` and `cacheBytesFrom` (media-budget.ts). */
export function mediaLimits(): { readCap: number, linkCap: number, cacheBytes: number } {
  const config = useRuntimeConfig()
  return {
    readCap: MEDIA_READ_CAP_BYTES,
    linkCap: linkCapFrom(config.whatsappMediaMaxBytes),
    cacheBytes: cacheBytesFrom(config.whatsappMediaCacheBytes),
  }
}

// Per process, like everything in media-memory.ts. The cache is created on first
// use because its size comes from runtimeConfig.
let cache: ReturnType<typeof createMediaCache> | undefined
function mediaCache() {
  return cache ??= createMediaCache({ maxBytes: mediaLimits().cacheBytes, ttlMs: CACHE_TTL_MS })
}
const semaphore = createSemaphore(MAX_CONCURRENT, SLOT_WAIT_MS)
const cooldown = createCooldown(COOLDOWN_MS)
const inflight = createInflight<EvolutionMedia>()

/**
 * Bytes of a message's attachment, checked against the message's own
 * `fileSha256` and never larger than `options.maxBytes`.
 *
 * **Authorization is the caller's, and it comes first.** The cache key is
 * `instanceId` + `remoteJid` + message id and carries nothing about a token, so
 * whoever gets here can be handed bytes someone else's request already fetched.
 * The tool must have run the scoped `findMediaMessage`, and the link route
 * `authorizeMediaLink`, before calling this; `source` is what they returned,
 * never something a caller typed. A cache hit saves the download, never the
 * check.
 *
 * Order: cache, then one shared download per message and cap (followers wait
 * on the leader's promise and hold no slot), then for the leader the cooldown,
 * a slot, and Evolution. The slot is held for the download only; processing
 * takes its own (`withMediaSlot`), so never call this from inside one.
 * Failures are `MediaError`s, except a refused host or missing credentials,
 * which are the H3 errors the rest of the app uses.
 */
export async function downloadVerifiedMedia(
  instance: AppInstance,
  source: { key: MessageKey, inner: JsonRecord, sha256?: Uint8Array },
  options: { maxBytes: number },
): Promise<EvolutionMedia> {
  const { remoteJid, id } = source.key
  if (!remoteJid || !id) {
    console.error(`[media] BUG: the stored message handed to the download has no id or chat (connection ${instance.id}, id ${id ?? 'none'})`)
    throw failure('internal')
  }
  const cacheKey = mediaCacheKey(instance.id, remoteJid, id)

  const hit = mediaCache().get(cacheKey)
  if (hit) {
    // Cached under the larger link cap, asked for under the smaller read cap.
    if (hit.bytes.length > options.maxBytes) throw failure('too-large')
    return { bytes: hit.bytes, mimeType: hit.mimeType }
  }

  // The cap is part of the key: a caller willing to take 25 MB must not share a
  // 10 MB caller's `too-large`.
  return inflight.run(`${cacheKey}|${options.maxBytes}`, () => lead(instance, source, cacheKey, options.maxBytes))
}

/** What the cached copy of a message is, or `undefined`. Same authorization rule as `downloadVerifiedMedia`: the caller checked first. Never mutate the bytes. */
export function cachedMedia(instanceId: string, remoteJid: string, messageId: string): MediaCacheEntry | undefined {
  return mediaCache().get(mediaCacheKey(instanceId, remoteJid, messageId))
}

/**
 * Runs processing (decoding an image, reading a PDF) under the same two-slot
 * gate downloads use, so the process's peak is bounded by one budget. Waits at
 * most 20 s, then `busy`.
 */
export function withMediaSlot<T>(fn: () => Promise<T>): Promise<T> {
  return semaphore.run(fn)
}

/** A deleted connection takes its cached files with it. */
export function evictMediaForInstance(instanceId: string): number {
  return mediaCache().evictInstance(instanceId)
}

function failure(kind: MediaFailureKind, extra?: { retryAfterSec?: number, evolutionText?: string }): MediaError {
  return new MediaError(kind, mediaFailureMessage(kind).message, extra)
}

async function lead(
  instance: AppInstance,
  source: { key: MessageKey, inner: JsonRecord, sha256?: Uint8Array },
  cacheKey: string,
  maxBytes: number,
): Promise<EvolutionMedia> {
  const remaining = cooldown.remainingMs(cacheKey)
  if (remaining > 0) throw failure('cooldown', { retryAfterSec: Math.ceil(remaining / 1000) })

  // 409 for a connection with no credentials, before it takes a slot.
  const evolution = evolutionClientForInstance(instance)
  const path = `/chat/getBase64FromMediaMessage/${encodeURIComponent(instance.name)}`

  return semaphore.run(async () => {
    const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
    try {
      // `raw` + `ignoreResponseError` + `responseType: 'stream'` hands back the
      // status and an unread body for 2xx and 4xx alike, with the client's host
      // guard (`onRequest`) still in front. The timeout covers reading the body
      // too. The body is the whole message Evolution is to download, not an id.
      const response = await evolution.raw(path, {
        method: 'POST',
        body: { message: { key: source.key, message: source.inner } },
        responseType: 'stream',
        ignoreResponseError: true,
        signal,
      })

      if (response.status < 200 || response.status >= 300) {
        throw await evolutionFailure(instance, response.status, response.body)
      }

      const body = await readBodyCapped(response.body, maxResponseBodyBytes(maxBytes))
      let media: EvolutionMedia
      try {
        media = parseEvolutionMediaBody(body)
      }
      catch (error) {
        // A 2xx that is not JSON (a proxy's page, say) is nothing we recognise: say what it was.
        if (error instanceof MediaError && error.kind === 'unknown') {
          console.error(`[media] Evolution answered ${response.status} with a body that is not JSON for connection ${instance.id}: ${body.subarray(0, 300).toString('utf8')}`)
        }
        throw error
      }
      if (media.bytes.length > maxBytes) throw failure('too-large')
      // Never cached, never served.
      if (sha256Matches(media.bytes, source.sha256) === false) {
        console.error(`[media] checksum mismatch for message ${source.key.id} of connection ${instance.id}; discarded`)
        throw failure('hash-mismatch')
      }
      // Only what passed the checks above: not larger than the cap, and not
      // contradicted by `fileSha256`. A message that carries no `fileSha256` is
      // cached too, since the spec verifies only "when the message has one".
      // A copy of its own: the cache must not pin whatever the parser's buffer
      // belongs to, nor change if a caller does.
      if (media.bytes.length <= mediaLimits().cacheBytes) {
        mediaCache().set(cacheKey, { bytes: Buffer.from(media.bytes), mimeType: media.mimeType })
      }
      return media
    }
    catch (error) {
      if (error instanceof MediaError) throw error
      // A refused host and the like: the app's own H3 errors, passed through.
      if (isError(error)) throw error
      if (signal.aborted) {
        cooldown.start(cacheKey)
        console.error(`[media] Evolution did not answer within ${DOWNLOAD_TIMEOUT_MS / 1000}s for message ${source.key.id} of connection ${instance.id}; cooling down`)
        throw failure('timeout')
      }
      const text = evolutionErrorText(error) || (error instanceof Error ? error.message : '')
      console.error(`[media] could not reach Evolution for connection ${instance.id}:`, text)
      throw failure('unknown', { evolutionText: text })
    }
  })
}

/**
 * A non-2xx answer as a `MediaError`. Evolution's text can hold a signed CDN
 * URL: it goes to the server log and into `evolutionText`, never into the
 * message. A text that points at our own request (`internal`) is a bug and is
 * logged as one.
 */
async function evolutionFailure(instance: AppInstance, status: number, body: ReadableStream<Uint8Array> | null): Promise<MediaError> {
  const raw = (await readBodyPrefix(body, ERROR_TEXT_BYTES)).toString('utf8')
  let parsed: unknown = raw
  try {
    parsed = JSON.parse(raw)
  }
  catch { /* not JSON: the text as it came */ }
  const text = evolutionErrorText(parsed)
  const kind = classifyEvolutionFailure({ status, text })
  if (kind === 'internal') {
    console.error(`[media] BUG: Evolution rejected the message we sent for connection ${instance.id} (${status}): ${text}`)
  }
  else {
    console.error(`[media] Evolution answered ${status} for connection ${instance.id}: ${text || raw.slice(0, 500)}`)
  }
  return failure(kind, { evolutionText: text || undefined })
}

/**
 * The status and the sentence for a failed download, for an authenticated
 * caller (the tool). The public link route must not use this: it reveals the
 * account's state, which that page never does, so the route calls
 * `mediaFailureMessage(error.kind)` without one. The live state is read only
 * where a dropped session is a plausible cause; a failed or slow read reports
 * `unknown` rather than guessing.
 */
export async function describeMediaFailure(instance: AppInstance, error: unknown): Promise<{ status: number, message: string }> {
  // The app's own refusals (not provisioned, host refused) keep their status.
  if (isError(error)) return { status: error.statusCode, message: error.statusMessage ?? error.message }
  if (!(error instanceof MediaError)) {
    console.error(`[media] unexpected failure for connection ${instance.id}:`, error)
    return mediaFailureMessage('internal')
  }
  if (error.kind !== 'expired' && error.kind !== 'timeout' && error.kind !== 'unknown') return mediaFailureMessage(error.kind)

  const state = await readAccountState(instance)
  return mediaFailureMessage(error.kind, state)
}

async function readAccountState(instance: AppInstance): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const status = await Promise.race([
      getInstanceStatus(instance),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), STATE_READ_MS) }),
    ])
    return status.state
  }
  catch {
    return 'unknown'
  }
  finally {
    clearTimeout(timer)
  }
}
