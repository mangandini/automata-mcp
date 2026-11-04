/**
 * Text of a WhatsApp PDF for the model, read through `unpdf` (a serverless
 * build of pdf.js, no native code). Imports only `node:worker_threads` and
 * `media-budget.ts` (explicit `.ts`), so a plain `node` loads it for checks.
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
 * Heap ceiling for the worker. A text PDF of a few hundred pages needs well
 * under 100 MB to read 50 pages; 256 MB leaves room for a large, font-heavy
 * file and still turns a runaway allocation into a dead worker (`unreadable`)
 * long before it matters to the 1 GB-class container the app runs in. Raw
 * ArrayBuffers (inflated streams) are outside this limit; the 10 s cap bounds
 * those, and terminating the worker returns them.
 */
const WORKER_LIMITS = { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 }

/**
 * Growth of the process's resident memory, while a worker runs, past which the
 * worker is killed. Needed because `resourceLimits` does not cover ArrayBuffers:
 * a 2 MB Flate stream that inflates to 2 GB grew the process by 1.3 GB inside
 * the 10 s window. A PDF that reads normally stays far under this (the 3-page
 * and 50-page fixtures move RSS by a few MB). It is process-wide RSS, so a large
 * unrelated allocation at the same moment can trip it: the cost of that is one
 * `unreadable` answer for a file that can be asked for again.
 */
const MAX_RSS_GROWTH_BYTES = 512 * 1024 * 1024
const RSS_POLL_MS = 50

/**
 * Reads the first `maxPages` pages and posts each one's text as it goes, so
 * pages read before a deadline are not lost. Each page is cut to `maxChars`:
 * nothing past that can be used, and a page of a few hundred MB of text must
 * not be copied across.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
;(async () => {
  const { url, bytes, maxPages, maxChars } = workerData
  try {
    const { getDocumentProxy } = await import(url)
    // pdf.js compiles font programs with new Function when allowed; a file we
    // did not write has no business making it do that.
    const pdf = await getDocumentProxy(bytes, { isEvalSupported: false })
    parentPort.postMessage({ t: 'open', pageCount: pdf.numPages })
    for (let i = 0; i < Math.min(pdf.numPages, maxPages); i++) {
      const page = await pdf.getPage(i + 1)
      let text
      try {
        const content = await page.getTextContent()
        text = content.items.map(item => ('str' in item ? item.str + (item.hasEOL ? '\\n' : '') : '')).join('').slice(0, maxChars)
      } finally {
        page.cleanup()
      }
      parentPort.postMessage({ t: 'page', text })
    }
    parentPort.postMessage({ t: 'done' })
  } catch (error) {
    // pdf.js raises PasswordException (NEED_PASSWORD / INCORRECT_PASSWORD) for a file it cannot open without one.
    parentPort.postMessage({ t: 'error', encrypted: error && error.name === 'PasswordException' })
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

function runInWorker(bytes: Buffer, maxChars: number): Promise<WorkerRun> {
  return new Promise((resolve) => {
    // A copy, transferred: the caller keeps its bytes (cache, link) and the worker owns its own.
    const copy = new Uint8Array(bytes)
    const run: WorkerRun = { outcome: 'failed', pages: [] }
    let worker: Worker
    let settled = false
    const finish = (outcome: WorkerRun['outcome']) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearInterval(guard)
      run.outcome = outcome
      void worker.terminate().catch(() => {})
      resolve(run)
    }
    const timer = setTimeout(() => finish('deadline'), PDF_LIMITS.maxMs)
    const rssAtStart = process.memoryUsage.rss()
    const guard = setInterval(() => {
      if (process.memoryUsage.rss() - rssAtStart > MAX_RSS_GROWTH_BYTES) finish('failed')
    }, RSS_POLL_MS)

    try {
      worker = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: { url: unpdfEntry(), bytes: copy, maxPages: PDF_LIMITS.maxPages, maxChars },
        transferList: [copy.buffer],
        resourceLimits: WORKER_LIMITS
      })
    } catch {
      clearTimeout(timer)
      clearInterval(guard)
      resolve(run)
      return
    }
    worker.on('message', (message: { t: string, pageCount?: number, text?: string, encrypted?: boolean }) => {
      if (message.t === 'open') run.pageCount = message.pageCount
      else if (message.t === 'page') run.pages.push(message.text ?? '')
      else if (message.t === 'done') finish('done')
      else if (message.t === 'error') finish(message.encrypted ? 'encrypted' : 'failed')
    })
    // Crash, out of memory, or exit before it said it was done.
    worker.on('error', () => finish('failed'))
    worker.on('exit', () => finish('failed'))
  })
}

export async function extractPdfForModel(bytes: Buffer, options: { maxChars: number }): Promise<PdfForModel> {
  const run = await runInWorker(bytes, options.maxChars)
  if (run.outcome === 'encrypted') return { ok: false, reason: 'encrypted' }
  // A parser that died (crash, memory, a page it could not read) leaves no honest
  // account of what the rest says, and the stop reasons we can state are caps, not
  // faults: that is `unreadable`. Only the deadline keeps what was read before it.
  if (run.outcome === 'failed' || run.pageCount === undefined) return { ok: false, reason: 'unreadable' }
  if (run.outcome === 'deadline' && run.pages.length === 0) return { ok: false, reason: 'unreadable' }

  // The caps are applied by the one implementation that owns them, over the pages
  // the worker delivered. Past the deadline only those pages exist, hence `maxPages`.
  const readAll = run.outcome === 'done'
  const extraction = await extractPdfPages({
    pageCount: run.pageCount,
    getPageText: async index => run.pages[index] ?? '',
    maxChars: options.maxChars,
    maxPages: readAll ? undefined : run.pages.length,
    yieldToEventLoop: () => new Promise<void>(resolve => setImmediate(resolve))
  })
  const unreadPages = Math.min(run.pageCount, PDF_LIMITS.maxPages) - run.pages.length
  if (!readAll && extraction.stoppedBy === 'pages' && unreadPages > 0) extraction.stoppedBy = 'time'

  // Judged on the page text itself: the `[page N]` labels are ours, and three
  // scanned pages with a printed number each would otherwise read as a document.
  const pageChars = run.pages.slice(0, extraction.pagesExtracted).join('').replace(/\s/g, '').length
  if (pageChars < MIN_TEXT_CHARS) return { ok: false, reason: 'no-text', pageCount: extraction.pageCount }
  return { ok: true, ...extraction }
}
