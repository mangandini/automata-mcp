/**
 * Text of a WhatsApp PDF for the model, read through `unpdf` (a serverless
 * build of pdf.js, no native code). Imports `node:*` modules and
 * `media-budget.ts` (explicit `.ts`) only, so a plain `node` loads it for checks.
 *
 * pdf.js runs in a worker thread, never on the main one. Its time cap cannot be
 * enforced from the same thread: one Flate stream of 1.9 MB inflating to 2 GB
 * kept the whole event loop (MCP, dashboard, every other request) busy for 12 s
 * while a timer set before it never fired. A worker can be terminated from
 * outside however busy it is, so the 10 s cap is real, and a file that
 * exhausts memory takes the worker down with it rather than the server.
 *
 * Worker source is a string (`eval: true`) rather than a file: a separate file
 * is not part of the Nitro bundle and would have to be found again at runtime
 * in `.output`; the string travels with this module. What it needs from outside
 * is only the location of `unpdf`, resolved here (where bundler and runtime
 * agree on `node_modules`) and passed in, since an eval worker resolves bare
 * names against the process's working directory, which is not the app's.
 *
 * Every way a worker can fail is logged here with its cause and nothing taken
 * from the file (no content, no names), because the caller only gets
 * `unreadable` and a missing `unpdf` in the deployed image would otherwise look
 * exactly like a bad file.
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { PDF_LIMITS, extractPdfPages } from './media-budget.ts'

export type PdfForModel =
  | { ok: true, text: string, pagesExtracted: number, pageCount: number, stoppedBy?: 'pages' | 'chars' | 'time' }
  | { ok: false, reason: 'no-text' | 'encrypted' | 'unreadable', pageCount?: number }

/** Fewer visible characters than this is a scan with a stray page number, not a document to read. */
const MIN_TEXT_CHARS = 20

/**
 * V8 heap ceiling for the worker: a second line of defence behind the memory cap
 * below, which is the one that catches ArrayBuffers (these limits do not cover them).
 */
const WORKER_LIMITS = { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 }

const MEMORY_POLL_MS = 50

export interface PdfWorkerLimits {
  /** Wall-clock cap for opening and reading together. */
  maxMs: number
  /**
   * The worker's own `external_memory + used_heap_size`: ArrayBuffer backing
   * stores (where a decompressed stream lives) plus the JS heap. Per worker, so
   * it neither depends on what the rest of the process is doing nor lets one
   * file kill a PDF being read at the same time; `Infinity` switches it off.
   * The default (320 MB) is set from measured peaks of this sum, sampled every
   * 5 ms: ~39 MB for a 9 MB, 240-page file with 16 embedded fonts and 80 images,
   * ~64 MB for two sheets of 45 MB of vector operators, and ~113 MB for a 6 MB
   * file embedding one 15 MB TrueType font unsubset (145 MB for a 23 MB one).
   * Large embedded fonts are what costs: about 5 bytes held per byte of font.
   * A runaway decode reaches 128 MB in about 0.3 s, so a higher cap costs a
   * second, not seconds.
   */
  maxWorkerBytes: number
  /** Check hooks, not for callers: how often to sample (default 50 ms) and a view of each sample, to observe the peak of a real file. */
  pollMs?: number
  onSample?: (workerBytes: number) => void
}
const DEFAULT_LIMITS: PdfWorkerLimits = { maxMs: PDF_LIMITS.maxMs, maxWorkerBytes: 320 * 1024 * 1024 }

/**
 * Reads pages in order and posts each one's text as it goes, so pages read
 * before a deadline are not lost. Each page is trimmed and cut to `maxChars`
 * (nothing past that can be used, and a page of a few hundred MB of text must
 * not be copied across). Stops once the character budget is spent, by the same
 * test `extractPdfPages` applies (the `[page N]` label, 10 characters plus the
 * digits of N, is charged to every page with text), so the pages it leaves out
 * are exactly the ones the caller would not have used.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
;(async () => {
  const { url, bytes, maxPages, maxChars } = workerData
  let phase = 'open'
  try {
    const { getDocumentProxy } = await import(url)
    // pdf.js compiles font programs with new Function when allowed; a file we
    // did not write has no business making it do that.
    const pdf = await getDocumentProxy(bytes, { isEvalSupported: false })
    phase = 'page'
    parentPort.postMessage({ t: 'open', pageCount: pdf.numPages })
    let used = 0
    for (let i = 0; i < Math.min(pdf.numPages, maxPages); i++) {
      const labelLength = 10 + String(i + 1).length
      if (maxChars - used <= labelLength) break
      const page = await pdf.getPage(i + 1)
      let text
      try {
        const content = await page.getTextContent()
        text = content.items.map(item => ('str' in item ? item.str + (item.hasEOL ? '\\n' : '') : '')).join('').trim().slice(0, maxChars).trimEnd()
      } finally {
        page.cleanup()
      }
      if (text) used += labelLength + text.length
      parentPort.postMessage({ t: 'page', text })
    }
    parentPort.postMessage({ t: 'done' })
  } catch (error) {
    // pdf.js raises PasswordException (NEED_PASSWORD / INCORRECT_PASSWORD) for a file it cannot open without one.
    const name = error && typeof error.name === 'string' ? error.name : 'Error'
    const code = error && typeof error.code === 'string' ? error.code : ''
    parentPort.postMessage({ t: 'error', encrypted: name === 'PasswordException', phase, name, code })
  }
})()
`

let unpdfLocation: string | undefined

/**
 * Where the worker finds `unpdf`: the package's ESM entry as a file URL, looked
 * up the way Node would (up the `node_modules` chain from this module), so it is
 * the same copy the app was built with: `.output/server/node_modules` in
 * production (kept there by `nitro.externals.traceInclude`, since nothing in
 * the bundle imports it by name), the workspace's in dev. `import.meta.resolve`
 * is not available here: Nitro replaces `import.meta` in its bundle with a stub
 * that has `url` only.
 */
function unpdfEntry(): string {
  if (unpdfLocation) return unpdfLocation
  const paths = createRequire(import.meta.url).resolve.paths('unpdf') ?? []
  for (const base of paths) {
    const dir = join(base, 'unpdf')
    if (!existsSync(join(dir, 'package.json'))) continue
    const { module: entry } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { module?: string }
    if (entry) return (unpdfLocation = pathToFileURL(join(dir, entry)).href)
  }
  // Last resort; an eval worker resolves bare names against the working directory.
  return 'unpdf'
}

interface WorkerRun {
  outcome: 'done' | 'deadline' | 'encrypted' | 'failed'
  /** Set once the document opened. */
  pageCount?: number
  pages: string[]
}

/** Only identifiers: an exception's name or code, never its message (which can quote the file). */
function safeLabel(value: unknown): string {
  return typeof value === 'string' && /^[\w.-]{1,60}$/.test(value) ? value : 'unknown'
}

function logFailure(cause: string): void {
  console.error(`[media-pdf] worker failed: ${cause}`)
}

function runInWorker(bytes: Buffer, maxChars: number, limits: PdfWorkerLimits): Promise<WorkerRun> {
  return new Promise((resolve) => {
    // A copy, transferred: the caller keeps its bytes (cache, link) and the worker owns its own.
    const copy = new Uint8Array(bytes)
    const run: WorkerRun = { outcome: 'failed', pages: [] }
    let worker: Worker | undefined
    let settled = false
    // `cause` is logged for every outcome except a clean finish and an encrypted file.
    const finish = (outcome: WorkerRun['outcome'], cause?: string) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      clearInterval(memoryPoll)
      run.outcome = outcome
      if (cause) logFailure(cause)
      // `terminate()` still lets queued messages through; the handlers below ignore them once settled.
      void worker?.terminate().catch(() => {})
      resolve(run)
    }
    const deadline = setTimeout(() => finish('deadline', `time cap of ${limits.maxMs} ms reached`), limits.maxMs)
    const memoryPoll = setInterval(() => {
      // Answered by the worker's isolate from outside, so it works while the worker is busy inside one call.
      worker?.getHeapStatistics().then((stats) => {
        if (settled) return
        const bytesInUse = stats.external_memory + stats.used_heap_size
        limits.onSample?.(bytesInUse)
        if (bytesInUse > limits.maxWorkerBytes) {
          finish('failed', `memory cap of ${Math.round(limits.maxWorkerBytes / 1048576)} MB exceeded`)
        }
      }, () => {})
    }, limits.pollMs ?? MEMORY_POLL_MS)

    try {
      worker = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: { url: unpdfEntry(), bytes: copy, maxPages: PDF_LIMITS.maxPages, maxChars },
        transferList: [copy.buffer],
        resourceLimits: WORKER_LIMITS
      })
    } catch (error) {
      finish('failed', `worker could not be started (${safeLabel((error as { code?: unknown })?.code)})`)
      return
    }
    worker.on('message', (message: { t: string, pageCount?: number, text?: string, encrypted?: boolean, phase?: string, name?: string, code?: string }) => {
      if (settled) return
      if (message.t === 'open') run.pageCount = message.pageCount
      else if (message.t === 'page') run.pages.push(message.text ?? '')
      else if (message.t === 'done') finish('done')
      else if (message.t === 'error') {
        if (message.encrypted) return finish('encrypted')
        const name = safeLabel(message.name)
        const code = safeLabel(message.code)
        // A missing `unpdf` is the deployment's fault, not the file's, and is the one an operator must be able to tell.
        const cause = code === 'ERR_MODULE_NOT_FOUND' || code === 'ERR_INVALID_URL' || code === 'ERR_UNSUPPORTED_ESM_URL_SCHEME'
          ? `unpdf could not be loaded (${code})`
          : message.phase === 'open' ? `document could not be opened (${name})` : `a page could not be read (${name})`
        finish('failed', cause)
      }
    })
    // Crash, out of memory, or exit before it said it was done.
    worker.on('error', error => finish('failed', `worker crashed (${safeLabel((error as { code?: unknown })?.code ?? (error as Error)?.name)})`))
    worker.on('exit', code => finish('failed', `worker exited before finishing (code ${Number.isInteger(code) ? code : 'unknown'})`))
  })
}

export function extractPdfForModel(bytes: Buffer, options: { maxChars: number }): Promise<PdfForModel> {
  return extractPdfWithLimits(bytes, options, DEFAULT_LIMITS)
}

/** `extractPdfForModel` with the worker's limits spelled out, so each can be exercised on its own. */
export async function extractPdfWithLimits(bytes: Buffer, options: { maxChars: number }, limits: PdfWorkerLimits): Promise<PdfForModel> {
  const run = await runInWorker(bytes, options.maxChars, limits)
  if (run.outcome === 'encrypted') return { ok: false, reason: 'encrypted' }
  // A parser that died (crash, memory, a page it could not read) leaves no honest
  // account of what the rest says, and the stop reasons we can state are caps, not
  // faults: that is `unreadable`. Only the deadline keeps what was read before it.
  if (run.outcome === 'failed' || run.pageCount === undefined) return { ok: false, reason: 'unreadable' }
  if (run.outcome === 'deadline' && run.pages.length === 0) return { ok: false, reason: 'unreadable' }

  // The caps are applied by the one implementation that owns them, over the pages
  // the worker delivered. Past the deadline only those pages exist, hence `maxPages`.
  // `run` no longer changes (settled), so `pages` is the same array throughout.
  const readAll = run.outcome === 'done'
  let extraction
  try {
    extraction = await extractPdfPages({
      pageCount: run.pageCount,
      getPageText: async (index) => {
        const text = run.pages[index]
        // The worker stops at the char budget by the same rule as `extractPdfPages`; a page it did not send
        // and the replay still wants means the two disagree, which must not read as an empty page.
        if (text === undefined) throw new Error('page not delivered by the worker')
        return text
      },
      maxChars: options.maxChars,
      maxPages: readAll ? undefined : run.pages.length,
      yieldToEventLoop: () => new Promise<void>(resolve => setImmediate(resolve))
    })
  } catch (error) {
    logFailure(`pages could not be assembled (${safeLabel((error as Error)?.name)})`)
    return { ok: false, reason: 'unreadable' }
  }
  const unreadPages = Math.min(run.pageCount, PDF_LIMITS.maxPages) - run.pages.length
  if (!readAll && extraction.stoppedBy === 'pages' && unreadPages > 0) extraction.stoppedBy = 'time'

  // Judged on the page text itself: the `[page N]` labels are ours, and three
  // scanned pages with a printed number each would otherwise read as a document.
  const pageChars = run.pages.slice(0, extraction.pagesExtracted).join('').replace(/\s/g, '').length
  if (pageChars < MIN_TEXT_CHARS) return { ok: false, reason: 'no-text', pageCount: extraction.pageCount }
  return { ok: true, ...extraction }
}
