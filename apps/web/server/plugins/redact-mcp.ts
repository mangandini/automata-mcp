/**
 * Keeps MCP bearer tokens and download-link tokens out of logs and error
 * responses.
 *
 * The `/mcp/<token>` fallback form puts a live credential in the request path,
 * and so does the public download link, `/api/media/<token>`.
 * Nitro's error handler (both dev and prod) builds its log line AND the `url`
 * field of the JSON error body from `getRequestURL(event)`, which reads
 * `event.node.req.originalUrl` in preference to anything else — so scrubbing
 * `event.path` alone is not enough.
 *
 * `originalUrl` is set by h3 at app entry and is never used for routing, so
 * rewriting it here is safe: the router still matches on `event.path` and
 * `getRouterParam(event, 'token')` still resolves.
 *
 * Wire any error reporter you add (Sentry, etc.) through `redactPath` /
 * `redactHeaders` from server/utils/redact.ts as well.
 */
/** The two path families whose URL is a credential. */
function isSecretPath(path: string | undefined): boolean {
  return isMcpPath(path) || isMediaPath(path)
}

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('request', (event) => {
    if (!isSecretPath(event.path)) return

    // Marker for any downstream logging you add.
    event.context.noLog = true

    const req = event.node?.req
    if (req?.originalUrl) {
      req.originalUrl = redactPath(req.originalUrl)
    }
  })

  nitroApp.hooks.hook('error', (error, ctx) => {
    if (!isSecretPath(ctx.event?.path)) return

    if (ctx.event) {
      ctx.event._path = redactPath(ctx.event._path)
    }

    if (error && typeof error === 'object' && 'url' in error) {
      ;(error as { url?: string }).url = redactPath((error as { url?: string }).url)
    }
  })
})
