/** Deeper paths under /api/media: nothing there, and they must not reach the Nuxt renderer either. */
export default defineEventHandler(event => mediaNotFound(event))
