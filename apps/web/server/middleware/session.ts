/**
 * Attaches the session cookie's user to `event.context.user` for the UI.
 *
 * The MCP surface is excluded before anything else happens. This is load-bearing:
 * if cookies were parsed on /mcp, a browser that is signed in to this app and
 * also has an MCP client pointed at it could authenticate a tool call with a
 * cookie instead of a token. MCP auth lives entirely in server/mcp/index.ts.
 * The same goes for `/api/media/<token>` (server/utils/media-serve.ts).
 */
export default defineEventHandler(async (event) => {
  if (isMcpPath(event.path)) return

  // The public download link is its own credential (the token in the path); a
  // signed-in browser opening it must not be read as that user, and visitors
  // with no session should not cost a database read.
  if (isMediaPath(event.path)) return

  // Webhooks authenticate with a shared secret, not a cookie.
  if (event.path.startsWith('/api/webhook/')) return

  event.context.user = await getSessionUser(event)
})
