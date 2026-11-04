/** The Download button: the only request that fetches the file. See `server/utils/media-serve.ts`. */
export default defineEventHandler(event => serveMediaFile(event, getRouterParam(event, 'token') ?? ''))
