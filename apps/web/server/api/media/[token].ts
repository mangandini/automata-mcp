/** Any method but GET, HEAD and POST, which have their own files (the router prefers those). */
export default defineEventHandler(event => refuseMediaMethod(event))
