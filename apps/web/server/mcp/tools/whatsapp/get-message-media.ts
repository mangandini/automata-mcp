import { z } from 'zod'

/**
 * Opt-in (`OPT_IN_TOOLS`): "all actions" does not include it. It reaches
 * further than reading what the token already reads: it downloads an
 * attachment from WhatsApp on every call and mints a public download link, so a
 * token holds it only when someone ticked it by name. The work is in
 * `getMessageMedia` (`server/utils/media-read.ts`); this file only reads the
 * auth context.
 */
export default defineKindTool({
  name: 'get-message-media',
  kind: 'whatsapp',
  optIn: true,
  strictInput: true,
  title: 'Get WhatsApp attachment',
  description:
    'Open the attachment of one WhatsApp message, by the message `id` that search-messages or '
    + 'read-messages returned (no chat argument: the chat comes from the message). Call it when the '
    + 'answer is inside an image or a PDF rather than in the text. An image comes back as a picture '
    + '(shrunk to fit if it is large; `processing` says how), a PDF as its extracted text with '
    + '`[page N]` markers (`note` says whether it was cut short); a scanned PDF has no text, and '
    + 'other documents (Word, Excel, text files) are not read, so those come back as details and a '
    + 'link only. Every successful call also creates a new public download link for the original '
    + 'file, valid for 1 hour and 20 downloads, that works without signing in (the person opens it '
    + 'and presses Download): hand it to the user when they want the file itself, and do not '
    + 'paste it anywhere else. Every call downloads the file from WhatsApp again unless it was '
    + 'fetched in the last few minutes, so ask for an attachment once and keep what you read. Not '
    + 'supported: audio, voice notes, video, stickers and view-once media (refused, naming the '
    + 'type). Files declared over 25 MB are refused; over 10 MB they are not read and only the '
    + 'link is given. A file WhatsApp no longer serves (old or expired media) is reported as such: '
    + 'ask the sender to send it again.',
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
    return await getMessageMedia({ instance, scope, tokenId, messageId })
  },
})
