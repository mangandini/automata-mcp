/**
 * Two surfaces carry a credential in the URL. The MCP surface carries bearer
 * tokens in the `Authorization` header and — for clients that cannot set
 * headers — in the path (`/mcp/<token>`). The public download link is the
 * second: `/api/media/<token>` is itself the credential. None of them may reach
 * a log line, an error report, or a trace.
 *
 * Used by server/plugins/redact-mcp.ts. Reach for these in any logging or
 * error-reporting code you add later.
 */

const REDACTED = '[redacted]'

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'apikey',
  'x-api-key',
  'x-webhook-secret',
])

/**
 * `/mcp/wamcp_abc123?foo=1` -> `/mcp/[redacted]`;
 * `/api/media/wamedia_abc/extra?x=1` -> `/api/media/[redacted]` (everything
 * after the prefix, so a suffix cannot carry the token either).
 */
export function redactPath(path: string | undefined): string {
  if (!path) return ''
  const [pathname] = path.split('?')

  if (isMediaPath(pathname)) return `${MEDIA_PREFIX}${REDACTED}`

  if (pathname === '/mcp' || !pathname!.startsWith('/mcp')) {
    return pathname!
  }

  return `/mcp/${REDACTED}`
}

/**
 * Free text (an error message, a stack) with every credential the app mints
 * taken out: an `/api/media/...` path, and any `wamcp_` / `wamedia_` / `waorg_`
 * token wherever it appears. For log lines whose text the app did not write.
 */
export function redactText(text: string): string {
  return text
    .replace(/\/api\/media\/[^\s"'`<>]*/g, `${MEDIA_PREFIX}${REDACTED}`)
    .replace(/\b(wamcp|wamedia|waorg)_[A-Za-z0-9_-]+/g, `$1_${REDACTED}`)
}

export function redactHeaders(headers: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!headers) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SENSITIVE_HEADERS.has(key.toLowerCase()) ? REDACTED : value
  }
  return out
}

/** True for any request on the MCP surface, including the path-token form. */
export function isMcpPath(path: string | undefined): boolean {
  if (!path) return false
  const [pathname] = path.split('?')
  return pathname === '/mcp' || pathname!.startsWith('/mcp/')
}

const MEDIA_PREFIX = '/api/media/'

/**
 * True for any request on the public download route (`/api/media/<anything>`),
 * whatever the method and however many segments follow: the token is in the
 * path, so a 404 or 405 on a longer path must be redacted just the same.
 */
export function isMediaPath(path: string | undefined): boolean {
  if (!path) return false
  const [pathname] = path.split('?')
  return pathname!.startsWith(MEDIA_PREFIX)
}
