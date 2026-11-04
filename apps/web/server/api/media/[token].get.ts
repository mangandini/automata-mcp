/**
 * The page behind a download link: opening it never downloads. Public, no
 * session, no MCP auth; see `server/utils/media-serve.ts`. HEAD is answered by
 * this same handler (checked against h3, see the route's check script).
 */
export default defineEventHandler(event => serveMediaPage(event, getRouterParam(event, 'token') ?? ''))
