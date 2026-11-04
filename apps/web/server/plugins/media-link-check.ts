/**
 * Say at boot that `get-message-media` cannot hand out download links.
 *
 * A link is built from `NUXT_PUBLIC_APP_URL` and nothing else: the request's
 * `Host` is the requester's choice, so a link built from it would point
 * wherever they like. With the setting empty the tool still reads attachments
 * (images and PDFs come back inline), it just says there is no link for
 * anything too large or of a kind it cannot show. That is a quiet degradation
 * from a client, so it is announced once here.
 */
export default defineNitroPlugin(() => {
  if (mediaLinksEnabled()) return

  console.warn(
    '[startup] NUXT_PUBLIC_APP_URL is not set (or is not an http(s) URL). get-message-media still reads '
    + 'attachments, but it cannot create download links. Set it to the address people open the app at.',
  )
})
