import type { AppInstance } from './app-db'
import { relatedChatJids } from './evolution-db'
import { httpStatusOf } from './errors'
import type { McpScope } from './mcp-scope'
import { assertChatAllowed, isChatAllowed, resolveNumberToJid } from './mcp-scope'

/**
 * The chat a tool call addresses, as every stored form of it we know of.
 *
 * `fromNumber` tells the tool whether the forms came from resolving a phone
 * number (in which case another form may exist that history never linked, and the
 * response should say so) or from a JID the caller named.
 */
export interface ChatTarget {
  jids: string[]
  fromNumber: boolean
}

/**
 * One message for every way a scoped token can fail to reach a number: no
 * WhatsApp account, Evolution refusing to resolve it, or no form inside the
 * token's chats. Distinct messages would let a token holder probe which numbers
 * have WhatsApp, or which chats exist outside their scope.
 */
const NOT_ACCESSIBLE = 'No accessible WhatsApp chat was found for that number.'

/**
 * Resolve a tool's `jid` argument — a JID, or a phone number — into the chat
 * forms to read or search.
 *
 * A value containing `@` is a JID and is used as is, after the scope check, with
 * no Evolution call. Anything else must be a phone number. Stripping separators
 * from the *input* is not JID normalisation: the JID itself always comes from
 * Evolution (`resolveNumberToJid`), whose country-specific rules we must never
 * re-implement.
 *
 * Each form is checked against the scope on its own and the ones the token does
 * not reach are dropped without being named.
 */
export async function resolveChatTarget(
  instance: AppInstance,
  scope: McpScope,
  input: string,
): Promise<ChatTarget> {
  const raw = input.trim()

  if (raw.includes('@')) {
    assertChatAllowed(scope, raw)
    return { jids: [raw], fromNumber: false }
  }

  const digits = raw.replace(/[\s\-()]/g, '').replace(/^\+/, '')
  if (!/^\d+$/.test(digits)) {
    throw createError({
      statusCode: 400,
      message: 'Pass either a chat jid (it contains "@") or a phone number made of digits, optionally with a leading "+", spaces, hyphens or parentheses.',
    })
  }

  // With a chat-scoped token every failure below reads the same, so existence
  // is never confirmed; an unrestricted token has nothing to hide and gets the
  // specific reason.
  const hide = !scope.allChats
  const notFound = (message: string) => createError({ statusCode: 404, message: hide ? NOT_ACCESSIBLE : message })

  let resolved: { jid: string, exists: boolean }
  try {
    resolved = await resolveNumberToJid(instance, digits)
  }
  catch (error) {
    if (httpStatusOf(error) === 422) {
      throw notFound(`Evolution could not resolve "${digits}" to a WhatsApp account.`)
    }
    // Fail closed: an unverifiable number is neither "found" nor "not found".
    throw createError({
      statusCode: 503,
      message: 'Could not look up that phone number because the WhatsApp account is unreachable. It may be disconnected; try again later or pass the chat jid.',
      cause: error,
    })
  }
  if (!resolved.exists) {
    throw notFound(`The number ${digits} has no WhatsApp account.`)
  }

  // Almost half of the 1:1 chats live under a `@lid` JID, and the resolved
  // number only gives the phone form. `relatedChatJids` adds the forms history
  // links to it; it can come back empty (the link exists only on live rows).
  const forms = [resolved.jid, ...await relatedChatJids(instance, resolved.jid)]
  const jids = [...new Set(forms)].filter(jid => isChatAllowed(scope, jid))
  if (!jids.length) {
    throw notFound(`The number ${digits} has a WhatsApp account, but this token is not scoped to any of its chats.`)
  }

  return { jids, fromNumber: true }
}
