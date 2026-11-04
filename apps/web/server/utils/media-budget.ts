/**
 * How much of an attachment may travel back to the model, and how it is cut
 * down to fit. Pure (no imports), so a plain `node` loads it; the decoding
 * itself (sharp, the PDF reader) lives with the caller and is passed in, which
 * is also what keeps these loops testable without either library.
 *
 * One budget for the whole response, base64 of an image included, because the
 * client counts what it receives, not what we sent as "bytes". Everything here
 * errs toward giving up early and handing over the download link: a hole that
 * is announced is better than a response the client truncates silently.
 */

/** Everything the tool returns, JSON metadata and image base64 included. */
export const RESPONSE_BUDGET_CHARS = 120_000
/** Room inside that for the JSON metadata block (name, size, link, note). */
export const RESPONSE_RESERVE_CHARS = 4_000
/** Largest file we download for the model to read. */
export const MEDIA_READ_CAP_BYTES = 10 * 1024 * 1024
/** Largest file the public link serves (`NUXT_WHATSAPP_MEDIA_MAX_BYTES` overrides). */
export const MEDIA_LINK_CAP_DEFAULT = 25 * 1024 * 1024
/** In-memory copy of verified downloads (`NUXT_WHATSAPP_MEDIA_CACHE_BYTES` overrides). */
export const MEDIA_CACHE_DEFAULT = 50 * 1024 * 1024
/** Decoding a larger image costs more memory than the process can spare. */
export const MAX_IMAGE_PIXELS = 40_000_000
export const PDF_LIMITS = { maxPages: 50, maxMs: 10_000 } as const

/** Below 768 px a phone screenshot's digits stop being legible, so the ladder ends there. */
const ORIGINAL_MAX_SIDE = 1568
export const IMAGE_LADDER = [
  { step: 1, maxSide: 1568, qualities: [80, 65, 50] },
  { step: 2, maxSide: 1024, qualities: [75, 60, 50] },
  { step: 3, maxSide: 768, qualities: [70, 55] }
] as const

export function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4
}

/**
 * How much of Evolution's JSON answer we read before giving up: the base64 of
 * `capBytes` plus room for the file name, caption and the rest of the envelope.
 */
export function maxResponseBodyBytes(capBytes: number): number {
  return Math.ceil(capBytes * 4 / 3) + 8192
}

/** Bytes of image that still fit once base64 and the metadata reserve are paid. */
export function imageByteBudget(): number {
  return Math.floor((RESPONSE_BUDGET_CHARS - RESPONSE_RESERVE_CHARS) * 3 / 4)
}

export function textCharBudget(): number {
  return RESPONSE_BUDGET_CHARS - RESPONSE_RESERVE_CHARS
}

export function contentChars(content: Array<{ type: 'text', text: string } | { type: 'image', data: string }>): number {
  let total = 0
  for (const block of content) total += block.type === 'text' ? block.text.length : block.data.length
  return total
}

// ---- image ladder -------------------------------------------------------

export interface ImageAttempt {
  /** 0 = the original, untouched; 1-3 = re-encoded as JPEG. */
  step: 0 | 1 | 2 | 3
  /** Longest side of the output, never larger than the source's. */
  maxSide: number
  /** JPEG quality; 0 for step 0, which is not re-encoded. */
  quality: number
}

/**
 * The re-encodings to try, in order. A side is clamped to the source's (no
 * upscaling), and an attempt that would produce the same size at the same
 * quality as an earlier one is dropped: for a 600 px image the three steps
 * collapse into one size, and re-running it would only repeat the same bytes.
 */
export function planImageAttempts(width: number, height: number): ImageAttempt[] {
  const longest = Math.max(width, height)
  const attempts: ImageAttempt[] = []
  const seen = new Set<string>()
  for (const rung of IMAGE_LADDER) {
    const maxSide = Math.min(rung.maxSide, longest)
    for (const quality of rung.qualities) {
      const key = `${maxSide}:${quality}`
      if (seen.has(key)) continue
      seen.add(key)
      attempts.push({ step: rung.step, maxSide, quality })
    }
  }
  return attempts
}

/**
 * Step 0 hands the original back as is, so it needs a source we trust to
 * pass through (`original.usable`: a JPEG without metadata worth stripping,
 * decided by the caller) that is within budget and small enough to read.
 * Otherwise the first encoding within budget wins; `undefined` means nothing
 * fit and the caller falls back to the link alone.
 */
export async function runImageLadder(args: {
  width: number
  height: number
  original: { bytes: number, usable: boolean }
  budgetBytes: number
  encode: (attempt: ImageAttempt) => Promise<Buffer>
}): Promise<{ attempt: ImageAttempt, bytes?: Buffer } | undefined> {
  const longest = Math.max(args.width, args.height)
  if (args.original.usable && args.original.bytes <= args.budgetBytes && longest <= ORIGINAL_MAX_SIDE) {
    return { attempt: { step: 0, maxSide: longest, quality: 0 } }
  }
  for (const attempt of planImageAttempts(args.width, args.height)) {
    const bytes = await args.encode(attempt)
    if (bytes.length <= args.budgetBytes) return { attempt, bytes }
  }
  return undefined
}

// ---- PDF paging ---------------------------------------------------------

export interface PdfExtraction {
  text: string
  pagesExtracted: number
  pageCount: number
  stoppedBy?: 'pages' | 'chars' | 'time'
}

function pageLabel(index: number): string {
  return `\n\n[page ${index + 1}]\n`
}

const yieldViaImmediate = () => new Promise<void>(resolve => setImmediate(resolve))

/**
 * Reads pages one at a time and stops at the first cap reached, instead of
 * reading the lot and trimming after: a 2 000-page PDF must cost 50 pages of
 * work, not 2 000. The char cap cuts inside the page that crosses it. The
 * event loop is released between pages so a long document does not stall the
 * MCP traffic and the dashboard. A page with no text adds nothing (so a
 * scanned PDF comes back with `text === ''`) but still counts as read.
 * `stoppedBy` is set only when pages were left unread; finishing the last page
 * late or full is not a stop.
 */
export async function extractPdfPages(args: {
  pageCount: number
  getPageText: (index: number) => Promise<string>
  maxChars: number
  maxPages?: number
  maxMs?: number
  now?: () => number
  yieldToEventLoop?: () => Promise<void>
}): Promise<PdfExtraction> {
  const maxPages = args.maxPages ?? PDF_LIMITS.maxPages
  const maxMs = args.maxMs ?? PDF_LIMITS.maxMs
  const now = args.now ?? Date.now
  const yieldToEventLoop = args.yieldToEventLoop ?? yieldViaImmediate
  const startedAt = now()
  let text = ''
  let pagesExtracted = 0
  let stoppedBy: PdfExtraction['stoppedBy']

  for (let i = 0; i < args.pageCount; i++) {
    if (i >= maxPages) { stoppedBy = 'pages'; break }
    // A label with no room for a single character of its page would only be noise.
    if (args.maxChars - text.length <= pageLabel(i).length) { stoppedBy = 'chars'; break }
    if (i > 0) {
      if (now() - startedAt >= maxMs) { stoppedBy = 'time'; break }
      await yieldToEventLoop()
    }
    const pageText = (await args.getPageText(i)).trim()
    pagesExtracted++
    if (!pageText) continue
    const chunk = pageLabel(i) + pageText
    const room = args.maxChars - text.length
    if (chunk.length > room) {
      text += chunk.slice(0, room)
      // Cut inside this page: whether or not more pages follow, the text is incomplete.
      stoppedBy = 'chars'
      break
    }
    text += chunk
  }
  return stoppedBy ? { text, pagesExtracted, pageCount: args.pageCount, stoppedBy } : { text, pagesExtracted, pageCount: args.pageCount }
}

const STOP_REASONS: Record<NonNullable<PdfExtraction['stoppedBy']>, string> = {
  pages: 'page limit',
  chars: 'response size limit; the last page read may be cut short',
  time: 'extraction time limit'
}

/** One sentence for the tool's `note` about how much of the PDF the text covers. */
export function describePdfCoverage(r: PdfExtraction): string {
  if (!r.stoppedBy) return `Text of all ${r.pageCount} ${r.pageCount === 1 ? 'page' : 'pages'}.`
  return `Text of ${r.pagesExtracted} of ${r.pageCount} pages (${STOP_REASONS[r.stoppedBy]}); the rest was not read. The download link has the whole file.`
}
