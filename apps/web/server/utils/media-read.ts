import type { AppInstance } from './app-db'
import { findMediaMessage } from './evolution-db'
import { isChatAllowed } from './mcp-scope'
import type { McpScope } from './mcp-scope'
import { describeMediaFailure, downloadVerifiedMedia, mediaLimits, withMediaSlot } from './media-download'
import { MediaError } from './media-errors.ts'
import { RESPONSE_BUDGET_CHARS, contentChars, describePdfCoverage, textCharBudget } from './media-budget.ts'
import { prepareImageForModel } from './media-image.ts'
import { createMediaLink, mediaLinksEnabled } from './media-links'
import { extractPdfForModel } from './media-pdf.ts'
import { safeDownloadName } from './media-safety.ts'
import { classifyMedia, detectImageMime, looksLikePdf } from './message-payload.ts'

/**
 * What `get-message-media` does, in the order the spec fixes. The tool file
 * only reads the auth context and calls `getMessageMedia`.
 *
 * Order is the security argument. The scoped row lookup is first, so a message
 * outside the token's chats is "not found" before anything is downloaded or any
 * cache is read (`downloadVerifiedMedia` authorizes nothing: its cache key
 * carries no token). Declared size is checked before a byte is fetched. The
 * download and the processing take the process's two slots **one after the
 * other, never nested**: `downloadVerifiedMedia` holds a slot only while it
 * talks to Evolution (a cache hit or a follower of an in-flight download holds
 * none) and has released it when it returns, and only then does
 * `withMediaSlot` wrap the PDF worker / image encoder. That slot is the only
 * thing bounding how many PDF workers (each up to ~450 MB) run at once, so the
 * two processors are never called outside it; and nesting a download inside a
 * processing slot would let two such callers each hold a slot while waiting for
 * a second one.
 *
 * Failures before there is anything to show are errors (404, 413, 422, and the
 * download's own); anything that goes wrong after the file is in hand (an image
 * too large to decode, a scanned PDF, no public URL for links, a failed link
 * insert) degrades to "what we have, and why not the rest" instead of throwing
 * the file away.
 */

type TextBlock = { type: 'text', text: string }
type ImageBlock = { type: 'image', data: string, mimeType: string }
export type MediaToolContent = { content: Array<TextBlock | ImageBlock> }

/**
 * One text for "no such message" and "not in this token's chats", so an id
 * cannot be probed across chats the token cannot read.
 */
const NOT_FOUND = 'No attachment with this message id is available to this connector. Use the `id` of a message returned by search-messages or read-messages.'

function notFound() {
  return createError({ statusCode: 404, message: NOT_FOUND })
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024 * 10) / 10} MB`
}

/** A processing refusal, as the sentence for `note`. */
const IMAGE_REFUSALS = {
  'pixel-cap': 'The picture has too many pixels to decode safely, so it was not shown.',
  'over-budget': 'Even at the smallest size this connector sends, the picture does not fit in a response, so it was not shown.',
  'unreadable': 'The picture could not be decoded, so it was not shown.',
} as const

const PDF_REFUSALS = {
  'no-text': 'This PDF has no text that can be extracted (it is probably a scan), so only the download link is given.',
  'encrypted': 'This PDF is password-protected, so its text could not be read.',
  'unreadable': 'This PDF could not be read, so only the download link is given.',
} as const

// A `fileSha256` that is there but that `storedBytes` cannot turn into 32 bytes
// means Evolution wrote a shape we do not know. The file is still served (the
// checksum is a second opinion, not the gate), but silently skipping a check is
// exactly how a regression hides, so it is logged as the bug it is, once per
// shape rather than once per call.
const reportedShapes = new Set<string>()
const MAX_REPORTED_SHAPES = 50

function shapeOf(value: unknown): string {
  if (Array.isArray(value)) return `array(${value.length})`
  if (typeof value === 'string') return `string(${value.length})`
  if (value && typeof value === 'object') {
    const keys = Object.keys(value)
    return /^\d+$/.test(keys[0] ?? '') ? `object(${keys.length} numeric keys)` : `object(keys: ${keys.slice(0, 6).join(',')})`
  }
  return typeof value
}

function reportUnverifiable(instanceId: string, value: unknown): void {
  const shape = shapeOf(value)
  if (reportedShapes.has(shape) || reportedShapes.size >= MAX_REPORTED_SHAPES) return
  reportedShapes.add(shape)
  console.error(`[media] BUG: a message's fileSha256 is not 32 bytes in any shape we read (${shape}, connection ${instanceId}); its file is served without a checksum`)
}

export async function getMessageMedia(args: {
  instance: AppInstance
  scope: McpScope
  tokenId: string
  messageId: string
}): Promise<MediaToolContent> {
  const { instance, scope, tokenId, messageId } = args
  const { readCap, linkCap } = mediaLimits()

  // 1. The row, scope in SQL. A token with no chat allowlist (an empty one) matches nothing.
  const row = await findMediaMessage(instance, scope.allChats
    ? { id: messageId, anyChat: true }
    : { id: messageId, jids: scope.chatJids })
  const jid = row?.key.remoteJid
  // The SQL already did this; a stored key with no chat, or a row outside the
  // scope, would be a bug in it and must read the same as not found.
  if (!row || !jid || !isChatAllowed(scope, jid)) throw notFound()

  // 2. What it is, by payload.
  const media = classifyMedia(row.message)
  if (media.route === 'unsupported') {
    throw createError({
      statusCode: 422,
      message: media.unsupportedType === 'view-once'
        ? 'This message is a view-once attachment, which this connector does not provide.'
        : `This message is not an image or document (its content type is "${media.unsupportedType}"). Only images, PDFs and other documents can be fetched; audio, video, voice notes and stickers cannot.`,
    })
  }

  // 3. Declared size, before anything is downloaded.
  if (media.declaredSize !== undefined && media.declaredSize > linkCap) {
    throw createError({
      statusCode: 413,
      message: `This file is declared as ${megabytes(media.declaredSize)}, above the ${megabytes(linkCap)} this connector handles.`,
    })
  }

  const notes: string[] = []
  let kind: 'image' | 'pdf' | 'document' = media.route
  let bytes: Buffer | undefined
  let downloadedMime: string | undefined

  // Only images and PDFs are ever read by the tool, and only within the read
  // cap; everything else (other documents, anything over the cap) is a link.
  if (kind === 'document') {
    notes.push('This is a document the connector does not read; it is available through the download link only.')
  }
  else if (media.declaredSize !== undefined && media.declaredSize > readCap) {
    notes.push(`The file is declared as ${megabytes(media.declaredSize)}, above the ${megabytes(readCap)} the connector reads, so it was not downloaded; it is available through the download link only.`)
  }
  else {
    try {
      const downloaded = await downloadVerifiedMedia(
        instance,
        { key: row.key, inner: media.inner, sha256: media.sha256 },
        { maxBytes: readCap },
      )
      bytes = downloaded.bytes
      downloadedMime = downloaded.mimeType
    }
    catch (error) {
      if (error instanceof MediaError && error.kind === 'too-large') {
        notes.push(`The file is larger than the ${megabytes(readCap)} the connector reads, so only the download link is given.`)
      }
      else {
        throw await mediaFailureError(instance, error)
      }
    }
  }

  // 4. Content for the model, from what was downloaded.
  let block: ImageBlock | TextBlock | undefined
  let processing: Record<string, unknown> | undefined
  let linkMime = media.mimeType ?? downloadedMime ?? 'application/octet-stream'

  const file = bytes
  if (file) {
    const rawSha = media.mediaKey ? media.inner[media.mediaKey]?.fileSha256 : undefined
    if (rawSha !== undefined && rawSha !== null && !media.sha256) {
      reportUnverifiable(instance.id, rawSha)
      notes.push('The file could not be checked against the checksum WhatsApp stored for it (that value is in a format this connector does not read), so it is served unverified.')
    }

    if (kind === 'image') {
      const detected = detectImageMime(file)
      if (!detected) {
        // A document declared as an image (an SVG, HEIC, or anything else): a plain file from here on.
        kind = 'document'
        notes.push('It was declared as an image, but its content is not a JPEG, PNG, WebP or GIF picture, so it was not shown; it is available through the download link.')
      }
      else {
        linkMime = detected
        const prepared = await inSlot(instance, () => prepareImageForModel(file))
        if (prepared?.ok && prepared.width > 0 && prepared.height > 0) {
          block = { type: 'image', data: prepared.bytes.toString('base64'), mimeType: prepared.mimeType }
          processing = { imageStep: prepared.step, width: prepared.width, height: prepared.height, bytes: prepared.bytes.length }
          if (prepared.step > 0) {
            notes.push(`The picture is shown reduced to ${prepared.width}x${prepared.height} (the original is ${prepared.originalWidth}x${prepared.originalHeight}); the download link has the original.`)
          }
        }
        else {
          notes.push(IMAGE_REFUSALS[prepared?.ok === false ? prepared.reason : 'unreadable'])
        }
      }
    }
    else if (kind === 'pdf') {
      if (!looksLikePdf(file)) {
        kind = 'document'
        notes.push('It was declared as a PDF, but its content is not one, so its text was not read; it is available through the download link.')
      }
      else {
        linkMime = 'application/pdf'
        const extracted = await inSlot(instance, () => extractPdfForModel(file, { maxChars: textCharBudget() }))
        if (extracted?.ok) {
          block = { type: 'text', text: extracted.text }
          processing = { pagesExtracted: extracted.pagesExtracted, pageCount: extracted.pageCount, ...(extracted.stoppedBy && { stoppedBy: extracted.stoppedBy }) }
          notes.push(describePdfCoverage(extracted))
        }
        else {
          notes.push(PDF_REFUSALS[extracted?.reason ?? 'unreadable'])
        }
      }
    }
  }

  // 5. The link. A failed insert must never read as "a link exists".
  const fileName = safeDownloadName({ fileName: media.fileName, mimeType: linkMime })
  let download: { url: string, expiresAt: string } | undefined
  if (!mediaLinksEnabled()) {
    notes.push('No download link was created: this server has no public URL configured (NUXT_PUBLIC_APP_URL).')
  }
  else {
    try {
      download = await createMediaLink({ instanceId: instance.id, tokenId, messageId, remoteJid: jid, fileName, mimeType: linkMime })
    }
    catch (error) {
      console.error(`[media] could not create a download link for connection ${instance.id}:`, error)
      if (!block) {
        throw createError({
          statusCode: 503,
          message: 'The download link could not be created because the app database is unavailable. Try again in a moment.',
        })
      }
      notes.push('No download link could be created right now (the app database is unavailable); what is shown below was read, but there is no link to hand to the user. Ask again in a moment for one.')
    }
  }

  // 6. The answer, inside the response budget.
  const size = bytes?.length ?? media.declaredSize
  const metadata = (note: string[]) => ({
    messageId,
    jid,
    type: kind,
    fileName,
    mimeType: linkMime,
    ...(size !== undefined && { size }),
    ...(download && { download }),
    ...(note.length && { note: note.join(' ') }),
    ...(processing && { processing }),
  })
  const render = (note: string[]): TextBlock => ({ type: 'text', text: JSON.stringify(metadata(note), null, 2) })
  const head = render(notes)
  if (!block) return { content: [head] }

  const content: MediaToolContent['content'] = [head, block]
  if (contentChars(content) <= RESPONSE_BUDGET_CHARS) return { content }

  // The pieces are each sized under the budget with a reserve for this block,
  // so reaching here means the reserve was wrong. Give up the content, not the link.
  console.error(`[media] BUG: a ${kind} response was ${contentChars(content)} characters, over the ${RESPONSE_BUDGET_CHARS} budget; sending the link only`)
  return { content: [render([...notes, 'The content did not fit in a response, so only the download link is given.'])] }
}

/** A failed download or a busy slot as the tool's error, with the live account state where it helps. */
async function mediaFailureError(instance: AppInstance, error: unknown) {
  const failure = await describeMediaFailure(instance, error)
  return createError({ statusCode: failure.status, message: failure.message })
}

/**
 * Runs the heavy step under the process's slot. A `busy` from the wait is the
 * caller's to see (503, try again); anything else that goes wrong in a
 * processor is a bug in it and is logged, and the file is still handed over as
 * a link: `undefined` means "could not be processed".
 */
async function inSlot<T>(instance: AppInstance, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await withMediaSlot(fn)
  }
  catch (error) {
    if (error instanceof MediaError) throw await mediaFailureError(instance, error)
    console.error(`[media] processing an attachment of connection ${instance.id} failed:`, error)
    return undefined
  }
}
