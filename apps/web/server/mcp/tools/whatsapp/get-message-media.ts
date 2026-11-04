import { z } from 'zod'

/**
 * Opt-in (`OPT_IN_TOOLS`): "all actions" does not include it. It reaches
 * further than reading what the token already reads: it downloads an
 * attachment from WhatsApp on every call and mints a public download link, so a
 * token holds it only when someone ticked it by name. The work is in
 * `getMessageMedia` (`server/utils/media-read.ts`); this file only reads the
 * auth context.
 */

/**
 * Built from the constants the code enforces, so the text cannot drift from
 * them. The link cap is the one limit an operator can change
 * (`NUXT_WHATSAPP_MEDIA_MAX_BYTES`), so it is described as the default. A cap
 * set below the read cap leaves no "link only" band: those files are refused.
 */
function description(): string {
  const mb = (bytes: number) => `${bytes / 1024 / 1024} MB`
  const minutes = MEDIA_LINK_TTL_MS / 60_000
  const lifetime = minutes % 60 === 0 ? `${minutes / 60} hour${minutes === 60 ? '' : 's'}` : `${minutes} minutes`
  return 'Open the attachment of one WhatsApp message, by the message `id` that search-messages or '
    + 'read-messages returned (no chat argument: the chat comes from the message). Call it when the '
    + 'answer is inside an image or a PDF rather than in the text. An image comes back as a picture '
    + '(shrunk to fit if it is large; `processing` says how), a PDF as its extracted text with '
    + '`[page N]` markers (`note` says whether it was cut short); a scanned PDF has no text, and '
    + 'other documents (Word, Excel, text files) are not read, so those come back as details and a '
    + `link only. Every successful call also creates a new public download link for the original file, valid for ${lifetime} `
    + `and ${MEDIA_LINK_MAX_DOWNLOADS} downloads, that works without signing in (the person opens it `
    + 'and presses Download): hand it to the user when they want the file itself, and do not '
    + 'paste it anywhere else; if the response says no link could be made, there is none to give. '
    + 'Every call downloads the file from WhatsApp again unless it was fetched in the last few '
    + 'minutes, so ask for an attachment once and keep what you read. Not supported: audio, voice '
    + 'notes, video, stickers and view-once media (refused, naming the type). Files declared above '
    + `the link limit (${mb(MEDIA_LINK_CAP_DEFAULT)} by default) are refused. Images and PDFs above ${mb(MEDIA_READ_CAP_BYTES)} `
    + 'that are within that limit are not read; only the link is given. A file WhatsApp no longer '
    + 'serves (old or expired media) is reported as such: ask the sender to send it again.'
}

export default defineKindTool({
  name: 'get-message-media',
  kind: 'whatsapp',
  optIn: true,
  strictInput: true,
  title: 'Get WhatsApp attachment',
  description: description(),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: {
    messageId: z.string()
      .regex(/^[A-Za-z0-9_-]{8,64}$/, 'a WhatsApp message id, as returned by search-messages or read-messages')
      .describe('The `id` of the message that carries the attachment, from search-messages or read-messages'),
  },
  handler: async ({ messageId }) => {
    const { instance, scope, tokenId } = useMcpAuth()
    return getMessageMedia({ instance, scope, tokenId, messageId })
  },
})
