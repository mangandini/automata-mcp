/** h3's router does not answer HEAD from the GET handler, and a HEAD that reaches no handler falls through to the Nuxt renderer. */
export default defineEventHandler(event => serveMediaPage(event, getRouterParam(event, 'token') ?? ''))
