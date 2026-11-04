import type { H3Event } from 'h3'
import type { AppMediaLink } from './app-db'
import { clientIp } from './login-throttle'
import { findMediaMessage } from './evolution-db'
import { authorizeMediaLink, claimMediaDownload, findMediaLinkByToken, refundMediaDownload } from './media-links'
import { cachedMedia, downloadVerifiedMedia, mediaLimits } from './media-download'
import { MediaError, mediaFailureMessage } from './media-errors.ts'
import { createRateLimiter } from './media-memory.ts'
import { mediaFileHeaders, MEDIA_BASE_HEADERS, MEDIA_PAGE_HEADERS, renderDownloadPage, renderNoticePage, safeDownloadName } from './media-safety.ts'
import type { NoticeKind } from './media-safety.ts'
import { classifyMedia } from './message-payload'

/**
 * What `/api/media/<token>` does. The two route files are one-liners over
 * `serveMediaPage` (GET and HEAD) and `serveMediaFile` (POST).
 *
 * This is the app's third credential path and the only one a browser with no
 * session presents, so it is the most exposed surface. Everything it answers is
 * one of three things: the page that holds the Download button, the file, or a
 * plain notice. Every one of them carries the headers in `media-safety.ts`.
 *
 * Opening a link downloads nothing. Link previews and mail scanners GET, so a
 * GET (and HEAD) only proves the link is alive (database reads, no Evolution
 * call, no counter change); the button is a form POST, and only that fetches.
 *
 * Failure semantics follow the rest of the app: a database that cannot be read
 * is a 503 notice with a log line naming the step, never "link not valid"
 * (telling someone their good link is dead invites them to throw it away), and
 * every refusal of the link itself looks the same (`invalid`), so the page
 * cannot be used to learn which half failed. The page never says what state the
 * WhatsApp account is in; `mediaFailureMessage` is not given one here.
 *
 * Never log the token or the facts behind it. Where a line needs to name a
 * link it names `link.id`.
 */

/**
 * Per client address, across GET, HEAD and POST: a page opened is as cheap as
 * it gets but still two database reads, and the limiter is also what bounds how
 * often a link whose fetch keeps failing can be retried (each failure refunds
 * its claim). In-memory and per process, a speed bump like the invitation mail
 * throttle; `clientIp` is the last `X-Forwarded-For` hop, which is only right
 * behind exactly one proxy (OPS.md).
 */
const RATE_LIMIT = 30
const RATE_WINDOW_MS = 60_000
const limiter = createRateLimiter(RATE_LIMIT, RATE_WINDOW_MS)

/** A notice page: status, the route's headers, `Retry-After` where the notice has one. */
function notice(event: H3Event, kind: NoticeKind, retryAfterSec?: number): string {
  const page = renderNoticePage(kind)
  setResponseStatus(event, page.status)
  setResponseHeaders(event, MEDIA_PAGE_HEADERS)
  const wait = retryAfterSec ?? page.retryAfterSec
  if (wait !== undefined) setResponseHeader(event, 'Retry-After', wait)
  return page.html
}

/** Throttle, then look the link up: the live row, or `answer`, a notice whose status and headers are already set. */
async function resolveLink(event: H3Event, token: string): Promise<{ link: AppMediaLink } | { answer: string }> {
  const turn = limiter.hit(clientIp(event))
  if (!turn.allowed) return { answer: notice(event, 'rate', turn.retryAfterSec) }

  // The lookup and the authorization log their own failure (naming the step and
  // the link id); here a thrown H3 error only becomes the page. Anything that is
  // not an H3 error is a bug and goes to Nitro unhandled, which redacts the URL.
  let link: AppMediaLink | undefined
  try {
    link = await findMediaLinkByToken(token)
  }
  catch (error) {
    if (isError(error)) return { answer: notice(event, 'error') }
    throw error
  }
  if (!link) return { answer: notice(event, 'invalid') }
  return { link }
}

/** What the link may be used for right now (`authorizeMediaLink`), or `answer`, a prepared notice. */
async function authorize(event: H3Event, link: AppMediaLink) {
  try {
    return await authorizeMediaLink(link) ?? { answer: notice(event, 'invalid') }
  }
  catch (error) {
    if (isError(error)) return { answer: notice(event, 'error') }
    throw error
  }
}

/**
 * GET and HEAD: the page with the Download button, or a notice. Reads the
 * database only (link, then who may still use it), so a dead link never shows a
 * button, and calls nothing else. HEAD gets the same headers; Node drops the
 * body.
 */
export async function serveMediaPage(event: H3Event, token: string): Promise<string> {
  const resolved = await resolveLink(event, token)
  if ('answer' in resolved) return resolved.answer
  const { link } = resolved

  const allowed = await authorize(event, link)
  if ('answer' in allowed) return allowed.answer

  setResponseHeaders(event, MEDIA_PAGE_HEADERS)
  // The row's name goes through `safeDownloadName` again: it is idempotent, and
  // it keeps the page and the header clean however the row was written.
  return renderDownloadPage({
    fileName: safeDownloadName({ fileName: link.file_name, mimeType: link.mime_type }),
    expiresAt: new Date(link.expires_at),
  })
}

/**
 * POST: the file. Order matters:
 *
 *   rate limit -> link -> authorization -> claim -> (cache | row + fetch)
 *
 * The claim comes before any fetch, as one conditional write, so two taps
 * racing for the last download cannot both win. A cache hit still claims: the
 * allowance counts deliveries, not WhatsApp calls. Anything that fails before
 * the bytes are in hand gives its claim back (the person got nothing); a client
 * that goes away mid-body keeps it. Authorization runs on every POST, so a
 * revoked token stops a link even for bytes already in the cache.
 */
export async function serveMediaFile(event: H3Event, token: string): Promise<string | Buffer> {
  const resolved = await resolveLink(event, token)
  if ('answer' in resolved) return resolved.answer
  const { link } = resolved

  const allowed = await authorize(event, link)
  if ('answer' in allowed) return allowed.answer
  const { instance } = allowed

  let claimed = false
  let delivered = false
  try {
    try {
      claimed = await claimMediaDownload(link.id)
    }
    catch (error) {
      if (isError(error)) return notice(event, 'error')
      throw error
    }
    if (!claimed) return notice(event, 'limit')

    const { linkCap } = mediaLimits()
    let bytes: Buffer
    const hit = cachedMedia(instance.id, link.remote_jid, link.message_id)
    if (hit) {
      // Cached by the tool under its smaller read cap or by a link under this
      // one, so it can only be too large if the operator lowered the cap.
      if (hit.bytes.length > linkCap) return notice(event, 'too-large')
      bytes = hit.bytes
    }
    else {
      // The row is read again, scoped to the link's one chat: the file that is
      // fetched is the row that is checked, and the link's chat has already
      // been through the token's scope.
      let row: Awaited<ReturnType<typeof findMediaMessage>>
      try {
        row = await findMediaMessage(instance, { id: link.message_id, remoteJid: link.remote_jid })
      }
      catch (error) {
        console.error(`[media-link] could not read the message for link ${link.id}:`, error)
        if (isError(error)) return notice(event, 'error')
        throw error
      }
      if (!row) {
        console.error(`[media-link] link ${link.id}: its message is no longer in the connection's history`)
        return notice(event, 'unavailable')
      }

      // The message may have been edited or replaced since the link was made.
      const media = classifyMedia(row.message)
      if (media.route === 'unsupported') {
        console.error(`[media-link] link ${link.id}: its message is no longer a downloadable attachment (${media.unsupportedType})`)
        return notice(event, 'unavailable')
      }
      if (media.declaredSize !== undefined && media.declaredSize > linkCap) return notice(event, 'too-large')

      try {
        const downloaded = await downloadVerifiedMedia(
          instance,
          { key: row.key, inner: media.inner, sha256: media.sha256 },
          { maxBytes: linkCap },
        )
        bytes = downloaded.bytes
      }
      catch (error) {
        return failureNotice(event, link, error)
      }
    }

    setResponseHeaders(event, mediaFileHeaders({
      mimeType: link.mime_type,
      name: safeDownloadName({ fileName: link.file_name, mimeType: link.mime_type }),
      size: bytes.length,
    }))
    // From here the bytes are the person's: a client that aborts mid-body keeps its claim.
    delivered = true
    return bytes
  }
  finally {
    if (claimed && !delivered) await refundMediaDownload(link.id)
  }
}

/**
 * A failed fetch as a public notice. Never says what the account's state is
 * (`describeMediaFailure` would, for the tool's authenticated caller); the
 * full cause goes to the server log.
 */
function failureNotice(event: H3Event, link: AppMediaLink, error: unknown): string {
  if (error instanceof MediaError) {
    if (error.kind === 'busy') return notice(event, 'busy', error.retryAfterSec)
    if (error.kind === 'too-large') return notice(event, 'too-large')
    console.error(`[media-link] link ${link.id}: download failed (${error.kind}):`, error.evolutionText || mediaFailureMessage(error.kind).message)
    return notice(event, 'unavailable', error.kind === 'cooldown' ? error.retryAfterSec : undefined)
  }
  console.error(`[media-link] link ${link.id}: download failed:`, error)
  return notice(event, 'unavailable')
}

/**
 * Every other method on a link. Without a handler of their own these requests
 * fall through to the Nuxt renderer, which would answer with the app's login
 * page and write the whole path, token included, into its router warning; so
 * the route claims every method and says no itself.
 */
export function refuseMediaMethod(event: H3Event): never {
  setResponseHeaders(event, { ...MEDIA_BASE_HEADERS, Allow: 'GET, HEAD, POST' })
  throw createError({ statusCode: 405, statusMessage: 'Method Not Allowed' })
}

/** `/api/media/<anything>/<more>` (and the bare `/api/media`): nothing lives there; the same reason as above. */
export function mediaNotFound(event: H3Event): string {
  return notice(event, 'invalid')
}
