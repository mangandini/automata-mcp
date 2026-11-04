/**
 * Everything the public download link (`/api/media/<token>`) puts on the wire
 * that is shaped by input an attacker can influence: the file name and type
 * come from a WhatsApp message anyone in a chat can send, and the link is
 * opened by people who are not signed in. Pure (only `node:crypto`), so a
 * plain `node` can load it and the route and the tool share one definition.
 *
 * Two rules decide the design. The file response must never be something a
 * browser will run as a page (`text/html`, `image/svg+xml`,
 * `application/xhtml+xml`), whatever the sender declared: an allowlist, not a
 * denylist. And no value from a message may reach a header or the page
 * unescaped: names are cleaned of controls and bidi tricks, headers carry an
 * RFC 5987 form, HTML is escaped.
 */
import { createHash } from 'node:crypto'

// ---- content type -------------------------------------------------------

const SERVED_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
  'image/bmp',
  'image/tiff',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
  'text/csv'
])

/** Extension for a served type; anything else is `bin`. */
const EXTENSIONS: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'application/msword': 'doc',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/vnd.oasis.opendocument.presentation': 'odp',
  'text/csv': 'csv'
}

/** Declared type without parameters, trimmed and lowercased (`''` when absent). */
function bareType(declared: string | undefined): string {
  return (declared ?? '').split(';')[0]!.trim().toLowerCase()
}

/**
 * The `Content-Type` to answer with. The declared one only when it is on the
 * allowlist; everything else (including `undefined`) is
 * `application/octet-stream`, which a browser saves instead of rendering.
 */
export function servedContentType(declared: string | undefined): string {
  const type = bareType(declared)
  return SERVED_TYPES.has(type) ? type : 'application/octet-stream'
}

// ---- file name ----------------------------------------------------------

/**
 * Removed from names: C0 and C1 controls (CR/LF among them), Unicode line and
 * paragraph separators, path separators, every format character (`\p{Cf}`:
 * the bidi controls LRM, RLM, ALM, embeddings, overrides and isolates, which
 * reorder what a person reads, so `photo<RLO>fdp.exe` shows as `photoexe.pdf`;
 * zero-width spaces and joiners, word joiner, BOM, soft hyphen), unpaired
 * surrogates (which make `encodeURIComponent` throw) and the characters Windows
 * and the header grammar do not accept. Written as a property class, never as
 * literal characters, which are invisible in review and in diffs.
 */
const UNSAFE_NAME_CHARS = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}/\\"*:<>?|]/gu

const MAX_NAME_LENGTH = 150

/** Evolution names a document it cannot name `<message id>.false`. */
const EVOLUTION_FALLBACK_NAME = /^[A-Za-z0-9_-]+\.false$/

const TRIM_EDGES = /^[. ]+|[. ]+$/g

/**
 * A file name safe to put in a header and to hand to a file system. Never
 * empty: a missing, emptied-out or Evolution-placeholder name becomes
 * `archivo.<ext>`, the extension taken from the mime type.
 */
export function safeDownloadName(input: { fileName?: string, mimeType?: string }): string {
  const cleaned = (input.fileName ?? '').replace(UNSAFE_NAME_CHARS, '').replace(TRIM_EDGES, '')
  if (cleaned === '' || EVOLUTION_FALLBACK_NAME.test(cleaned)) {
    return `archivo.${EXTENSIONS[bareType(input.mimeType)] ?? 'bin'}`
  }
  if (cleaned.length <= MAX_NAME_LENGTH) return cleaned

  // Too long: shorten the stem, keep a plausible extension so the file still
  // opens with the right program. Whole code points only, so a pair of UTF-16
  // surrogates is never cut in half.
  const ext = /\.[A-Za-z0-9]{1,16}$/.exec(cleaned)?.[0] ?? ''
  const budget = MAX_NAME_LENGTH - ext.length
  let head = ''
  for (const ch of cleaned.slice(0, cleaned.length - ext.length)) {
    if (head.length + ch.length > budget) break
    head += ch
  }
  return head.replace(TRIM_EDGES, '') + ext
}

/**
 * `Content-Disposition` for a download: an ASCII `filename` for old clients
 * (anything outside printable ASCII becomes `_`) and the RFC 5987
 * `filename*` with the real name percent-encoded. Callers pass a name from
 * `safeDownloadName`, but this is the one place a name becomes header text, so
 * it does not rely on that: `"` and `\` are neutralised in the quoted
 * fallback (else a name could close the quote and add a parameter), so is `%`
 * (a legacy client that percent-decodes `filename` could turn `%2F..` into a
 * path), and unpaired surrogates dropped (else `encodeURIComponent` throws).
 */
export function contentDispositionAttachment(name: string): string {
  const clean = name.replace(/\p{Cs}/gu, '')
  const ascii = clean.replace(/[^\x20-\x7e]|["\\%]/gu, '_')
  // encodeURIComponent leaves `' ( ) *` alone; RFC 5987 attr-char excludes them.
  const encoded = encodeURIComponent(clean).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

// ---- pages --------------------------------------------------------------

/**
 * The page's only stylesheet, in one constant so the CSP hash below is
 * computed from exactly what is served. No external font, no image.
 */
const PAGE_CSS = 'body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto 0;padding:0 1rem;line-height:1.5;color:#1a1a1a}'
  + 'h1{font-size:1.25rem;margin:0 0 .5rem}'
  + 'p{margin:.25rem 0}'
  + '.name{word-break:break-all;font-weight:600}'
  + '.muted{color:#666;font-size:.9rem}'
  + 'button{margin-top:1.25rem;padding:.6rem 1.25rem;font:inherit;border:0;border-radius:.375rem;background:#1a1a1a;color:#fff;cursor:pointer}'

/**
 * Pages may apply exactly this stylesheet and post a form to themselves:
 * nothing else loads, runs or navigates, and no other site may frame them (a
 * framed Download button is one click away from a disguised download). Derived from `PAGE_CSS` at module
 * load so the two cannot drift.
 */
export const PAGE_CSP = `default-src 'none'; style-src 'sha256-${createHash('sha256').update(PAGE_CSS).digest('base64')}'; form-action 'self'; frame-ancestors 'none'`

/** On every response of the route, page or file. */
export const MEDIA_BASE_HEADERS: Readonly<Record<string, string>> = {
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store'
}

export const MEDIA_PAGE_HEADERS: Readonly<Record<string, string>> = {
  ...MEDIA_BASE_HEADERS,
  'Content-Security-Policy': PAGE_CSP,
  'Content-Type': 'text/html; charset=utf-8'
}

/**
 * Headers of the file itself. `sandbox` (no allow-* tokens) is the second
 * line behind the content-type allowlist: even a type that slipped through
 * would run in an opaque origin with no scripts.
 */
export function mediaFileHeaders(args: { mimeType?: string, name: string, size: number }): Record<string, string> {
  if (!Number.isSafeInteger(args.size) || args.size < 0) throw new RangeError('size must be a non-negative integer')
  return {
    ...MEDIA_BASE_HEADERS,
    'Content-Type': servedContentType(args.mimeType),
    'Content-Disposition': contentDispositionAttachment(args.name),
    'Content-Security-Policy': 'sandbox',
    'Accept-Ranges': 'none',
    'Content-Length': String(args.size)
  }
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, c => HTML_ESCAPES[c]!)
}

function layout(title: string, body: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>${PAGE_CSS}</style></head><body>${body}</body></html>`
}

/** Format characters (bidi controls among them), as in `UNSAFE_NAME_CHARS`; the page strips them on its own. */
const FORMAT_CHARS = /\p{Cf}/gu

/**
 * What opening the link shows. `fileName` should be the `safeDownloadName`
 * result (the page shows what the download will be called); format characters
 * are stripped here as well, so even a raw name cannot reorder what is read.
 * Opening is not downloading: link previews and
 * mail scanners fetch with GET but do not submit forms, so only the button
 * (a POST to this same URL, hence no `action`) reaches WhatsApp.
 */
export function renderDownloadPage(args: { fileName: string, expiresAt: Date }): string {
  const time = args.expiresAt.getTime()
  const expiry = Number.isNaN(time)
    ? ''
    : `<p class="muted">This link expires on ${escapeHtml(args.expiresAt.toISOString().slice(0, 16).replace('T', ' '))} UTC.</p>`
  return layout('Download file', `<h1>Your file is ready</h1><p class="name">${escapeHtml(args.fileName.replace(FORMAT_CHARS, ''))}</p>${expiry}<form method="post"><button type="submit">Download</button></form>`)
}

export type NoticeKind = 'invalid' | 'limit' | 'busy' | 'unavailable' | 'rate' | 'too-large' | 'error'

type NoticeStatus = 404 | 410 | 503 | 502 | 429 | 413

type Notice = { status: NoticeStatus, title: string, text: string, retryAfterSec?: number }

// `invalid` covers unknown, expired and revoked links alike: telling them apart
// would let anyone holding a guess learn which tokens exist. `unavailable`
// never says what state the account is in: this page is public.
const NOTICES: Record<NoticeKind, Notice> = {
  'invalid': { status: 404, title: 'Link not valid', text: 'This link is invalid or has expired.' },
  'limit': { status: 410, title: 'Download limit reached', text: 'This link has reached its download limit.' },
  'busy': { status: 503, title: 'Server busy', text: 'The server is busy right now. Try again in a few seconds.', retryAfterSec: 10 },
  'unavailable': { status: 502, title: 'File not available', text: 'WhatsApp did not deliver the file right now. It may have expired or the account may be disconnected. Ask for it to be sent again.' },
  'rate': { status: 429, title: 'Too many requests', text: 'Too many requests. Wait a moment and try again.', retryAfterSec: 60 },
  'too-large': { status: 413, title: 'File too large', text: 'The file is larger than the download limit.' },
  'error': { status: 503, title: 'Temporarily unavailable', text: 'The download is temporarily unavailable, try again shortly.', retryAfterSec: 30 }
}

export function renderNoticePage(kind: NoticeKind): { status: NoticeStatus, html: string, retryAfterSec?: number } {
  const notice = NOTICES[kind]
  const html = layout(notice.title, `<h1>${escapeHtml(notice.title)}</h1><p>${escapeHtml(notice.text)}</p>`)
  return notice.retryAfterSec === undefined
    ? { status: notice.status, html }
    : { status: notice.status, html, retryAfterSec: notice.retryAfterSec }
}

// ---- link ---------------------------------------------------------------

/**
 * `{app url}/api/media/<token>`, built only from the configured public URL,
 * never from the request's `Host` (the requester chooses that). `undefined`
 * when it is unset or not an http(s) URL, so the tool can say links are off.
 */
export function publicLinkUrl(appUrl: string | undefined, token: string): string | undefined {
  const raw = (appUrl ?? '').trim()
  if (!/^https?:\/\//i.test(raw)) return undefined
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  // origin + path only: a query, fragment or credentials in the setting must
  // not leak into, or break, the link.
  const base = url.origin + url.pathname.replace(/\/+$/, '')
  return `${base}/api/media/${encodeURIComponent(token)}`
}
