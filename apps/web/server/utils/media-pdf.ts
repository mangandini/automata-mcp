/**
 * Text of a WhatsApp PDF for the model, read through `unpdf` (a serverless
 * build of pdf.js, no native code). Imports only `unpdf` and `media-budget.ts`
 * (explicit `.ts`), so a plain `node` loads it for checks.
 *
 * The page loop and its caps live in `extractPdfPages` (media-budget.ts); what
 * is added here is what it cannot do from the outside:
 * - a deadline on every *single* page, since its time cap is checked only
 *   between pages and one page that never settles would hold the request open
 *   for ever;
 * - mapping pdf.js's failures to the three reasons a caller can act on.
 *
 * A limit that pdf.js cannot honour: its worker runs on this thread, so a page
 * that burns CPU in one synchronous stretch cannot be interrupted, only
 * noticed afterwards. The deadline bounds anything that waits, which is what a
 * damaged or hostile file mostly does; the 10 MB read cap bounds the rest.
 */
import { getDocumentProxy } from 'unpdf'
import { PDF_LIMITS, extractPdfPages, type PdfExtraction } from './media-budget.ts'

export type PdfForModel =
  | { ok: true, text: string, pagesExtracted: number, pageCount: number, stoppedBy?: 'pages' | 'chars' | 'time' }
  | { ok: false, reason: 'no-text' | 'encrypted' | 'unreadable', pageCount?: number }

/** Fewer visible characters than this is a scan with a stray page number, not a document to read. */
const MIN_TEXT_CHARS = 20

/**
 * pdf.js compiles font programs with `new Function` when allowed; a file we did not
 * write has no business making it do that. Honoured at runtime, missing from the
 * published option type (same situation as postgres.js's `simple`), hence the cast.
 */
const PDF_OPTIONS = { isEvalSupported: false } as NonNullable<Parameters<typeof getDocumentProxy>[1]>

class DeadlineExceeded extends Error {}

/** `promise`, or a rejection after `ms`; the loser is never left to reject unhandled. */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  promise.catch(() => {})
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineExceeded()), Math.max(0, ms))
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}

/**
 * `extractPdfPages` with a deadline on each page read. A page that misses the
 * overall budget ends the read with `stoppedBy: 'time'`, keeping the pages
 * already read, exactly as if the between-pages check had caught it.
 */
export async function readPdfPagesBounded(args: {
  pageCount: number
  readPage: (index: number) => Promise<string>
  maxChars: number
  maxMs?: number
  yieldToEventLoop?: () => Promise<void>
}): Promise<PdfExtraction> {
  const maxMs = args.maxMs ?? PDF_LIMITS.maxMs
  const startedAt = Date.now()
  const done: string[] = []
  const run = (pageCount: number, getPageText: (index: number) => Promise<string>, extra: { maxPages?: number } = {}) =>
    extractPdfPages({ pageCount, getPageText, maxChars: args.maxChars, maxMs, yieldToEventLoop: args.yieldToEventLoop, ...extra })

  try {
    return await run(args.pageCount, async (index) => {
      const text = await withDeadline(args.readPage(index), maxMs - (Date.now() - startedAt))
      done[index] = text
      return text
    })
  } catch (error) {
    if (!(error instanceof DeadlineExceeded)) throw error
  }
  // A page did not answer in time. Replay what was read (no I/O, cannot fail
  // or time out) so the text and counts come from the one implementation that
  // owns them, then say why it ended.
  const read = await run(args.pageCount, async index => done[index] ?? '', { maxPages: done.length })
  return { ...read, stoppedBy: 'time' }
}

export async function extractPdfForModel(bytes: Buffer, options: { maxChars: number }): Promise<PdfForModel> {
  // A copy: pdf.js may detach the buffer it is given, and the caller keeps these bytes (cache, link).
  // One clock for opening and reading: the time cap is on the whole extraction.
  const startedAt = Date.now()
  const loading = getDocumentProxy(new Uint8Array(bytes), PDF_OPTIONS)
  let pdf: Awaited<typeof loading>
  try {
    pdf = await withDeadline(loading, PDF_LIMITS.maxMs)
  } catch (error) {
    // Late arrival of a document nobody waits for any more: release it.
    loading.then(late => late.loadingTask.destroy(), () => {})
    return { ok: false, reason: isPasswordError(error) ? 'encrypted' : 'unreadable' }
  }

  try {
    const extraction = await readPdfPagesBounded({
      pageCount: pdf.numPages,
      maxChars: options.maxChars,
      maxMs: PDF_LIMITS.maxMs - (Date.now() - startedAt),
      yieldToEventLoop: () => new Promise<void>(resolve => setImmediate(resolve)),
      readPage: async (index) => {
        const page = await pdf.getPage(index + 1)
        try {
          const content = await page.getTextContent()
          return content.items
            .map(item => ('str' in item ? item.str + (item.hasEOL ? '\n' : '') : ''))
            .join('')
        } finally {
          page.cleanup()
        }
      }
    })
    // A deadline before any page was read says nothing about the document's text.
    if (extraction.pagesExtracted === 0 && extraction.stoppedBy === 'time') return { ok: false, reason: 'unreadable' }
    if (extraction.text.replace(/\s/g, '').length < MIN_TEXT_CHARS) {
      return { ok: false, reason: 'no-text', pageCount: extraction.pageCount }
    }
    return { ok: true, ...extraction }
  } catch (error) {
    return { ok: false, reason: isPasswordError(error) ? 'encrypted' : 'unreadable' }
  } finally {
    // Also abandons a page read that missed its deadline and is still running.
    await pdf.loadingTask.destroy().catch(() => {})
  }
}

/** pdf.js raises `PasswordException` (NEED_PASSWORD / INCORRECT_PASSWORD) for a file it cannot open without one. */
function isPasswordError(error: unknown): boolean {
  return (error as { name?: unknown } | undefined)?.name === 'PasswordException'
}
