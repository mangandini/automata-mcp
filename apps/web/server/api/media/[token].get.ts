/**
 * The page behind a download link: opening it never downloads. Public, no
 * session, no MCP auth; see `server/utils/media-serve.ts`. HEAD has its own
 * file (`[token].head.ts`): h3 does not answer it from this one.
 */
export default defineEventHandler(event => serveMediaPage(event, getRouterParam(event, 'token') ?? ''))
