/**
 * Reading and checking Evolution's answer to `getBase64FromMediaMessage`. Pure
 * (only `node:crypto` and `./media-errors.ts`), so a plain `node` loads it and
 * the early-abort and "never an empty file" rules are checked without Evolution.
 */

import { createHash } from 'node:crypto'
import { MediaError } from './media-errors.ts'

/**
 * Collects a response body, and stops the moment it is larger than `maxBytes`:
 * the stream is cancelled (the connection is dropped, not drained) and the
 * caller gets `too-large`. So the base64-to-Buffer step downstream can never run
 * on a body bigger than the budget allows, however much Evolution would send.
 * `null` (no body at all) reads as zero bytes; what that means is the caller's
 * to decide.
 */
export async function readBodyCapped(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Buffer> {
  if (!body) return Buffer.alloc(0)
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new MediaError('too-large', 'Evolution\'s answer is larger than the download budget.')
      }
      chunks.push(value)
    }
  }
  finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total)
}

/**
 * The first `maxBytes` of a body, for an error text we only want to read and
 * log: the rest is dropped and the connection with it. Unlike `readBodyCapped`
 * it never throws for size, because an over-long error is still an error.
 */
export async function readBodyPrefix(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Buffer> {
  if (!body) return Buffer.alloc(0)
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read()
      if (done) break
      const take = value.subarray(0, maxBytes - total)
      chunks.push(take)
      total += take.length
    }
    await reader.cancel().catch(() => {})
  }
  finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total)
}

export interface EvolutionMedia {
  bytes: Buffer
  mimeType?: string
  fileName?: string
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

/**
 * The file out of Evolution's 201 body (`{ mediaType, fileName, caption, size,
 * mimetype, base64 }`). Anything that does not yield at least one byte is
 * `empty`, never a zero-length file: Evolution answers 201 with a literal
 * `null` body for a message that carries only `messageContextInfo`, and a
 * download that "worked" into an empty attachment would be reported as a
 * success. A body that is not JSON at all is `unknown`.
 *
 * `mimetype` and `fileName` are what Evolution says; they are hints, and the
 * caller decides how far to trust them.
 */
export function parseEvolutionMediaBody(json: Buffer): EvolutionMedia {
  if (json.length === 0) throw new MediaError('empty', 'Evolution returned no content for this message.')
  let parsed: unknown
  try {
    parsed = JSON.parse(json.toString('utf8'))
  }
  catch {
    throw new MediaError('unknown', 'Evolution\'s answer was not JSON.')
  }
  const record = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : undefined
  const base64 = record?.base64
  const bytes = typeof base64 === 'string' && base64 ? Buffer.from(base64, 'base64') : undefined
  if (!record || !bytes?.length) throw new MediaError('empty', 'Evolution returned no content for this message.')
  return { bytes, mimeType: nonEmptyString(record.mimetype), fileName: nonEmptyString(record.fileName) }
}

/**
 * Whether the bytes are the file the message names: SHA-256 against the
 * message's `fileSha256`. `undefined` when the message carries none (nothing to
 * compare, which is not a pass). A stored value that is not 32 bytes cannot
 * match, so it is `false`.
 */
export function sha256Matches(bytes: Uint8Array, expected: Uint8Array | undefined): boolean | undefined {
  if (!expected) return undefined
  return Buffer.from(expected).equals(createHash('sha256').update(bytes).digest())
}
