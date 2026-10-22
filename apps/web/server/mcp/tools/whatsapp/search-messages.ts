import { z } from 'zod'
import type { AppInstance } from '~~/server/utils/app-db'
import type { MessageSearchHit } from '~~/server/utils/evolution-db'
import type { MentionDirectory } from '~~/server/utils/mentions'

/**
 * Search tool. Unlike `read-messages` it defaults to every chat the token can
 * see, so the scope check has two halves: a named chat is asserted (and refused
 * loudly, as there), while an unscoped search is narrowed to the token's chats
 * *in the SQL* rather than by filtering what comes back.
 *
 * Reaches Evolution's database rather than its API, as both read paths now do —
 * see `evolution-db.ts` for why.
 */
export default defineKindTool({
  name: 'search-messages',
  kind: 'whatsapp',
  // No `messageDatabaseConfigured()` half any more. Both read paths need the
  // database now, so hiding only this one would leave `read-messages` visible
  // and failing — the boot warning in plugins/evolution-db-check.ts is where an
  // unconfigured deployment is reported instead.
  title: 'Search WhatsApp messages',
  description:
    'Find WhatsApp messages containing given words, newest first, across every '
    + 'chat unless a `jid` narrows it to one. Matching is case-insensitive and '
    + 'every word must appear in the same message. Covers the history imported '
    + 'when the account was paired as well as everything since. Reaction messages '
    + 'are not searched unless `includeReactions` is set, which also makes a bare '
    + 'emoji findable. A match you sent is marked `fromMe` and carries no '
    + '`author`; on one you received, `author` is the sender\'s name where the '
    + 'account knows it, and absent where it does not. @-mentions in the text are '
    + 'shown as names where the account knows them, and left as raw numeric ids '
    + 'where it does not — an id is not a name to guess at. An edited message is matched on its new text and comes '
    + 'back with `editOf`, the id of the message it replaces — which may be a '
    + 'separate hit here still carrying its old wording, so prefer the edit when '
    + 'the two disagree. A hit\'s `type` names the record as WhatsApp stored it, '
    + 'so an edit reads as `protocolMessage` and an album item as '
    + '`associatedChildMessage`; the `text` is the real content either way. An '
    + 'edit WhatsApp encrypted for the chat\'s participants '
    + 'is not searchable at all: its text is unknown to this connector, so a '
    + 'search finding nothing is not proof a message does not exist. Use this '
    + 'instead of paging read-messages when you are looking for something by '
    + 'what it says.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    query: z.string().min(2).describe('Words to look for. All of them must appear in the message.'),
    jid: z.string().optional().describe('Restrict to one chat, using a `jid` from list-chats. Omit to search every chat.'),
    since: z.string().optional().describe('Only messages at or after this date, e.g. 2024-03-01 or 2024-03-01T12:00:00Z'),
    until: z.string().optional().describe('Only messages at or before this date'),
    fromMe: z.boolean().optional().describe('true for only messages you sent, false for only messages you received'),
    limit: z.number().int().min(1).max(100).default(20).describe('How many matches to return'),
    includeReactions: z.boolean().default(false).describe(
      'Search reaction messages too, matching against the emoji itself. Off by '
      + 'default: a reaction carries an id, an author and a timestamp to say one '
      + 'character, and it rarely answers a question about what was said.',
    ),
  },
  handler: async ({ query, jid, since, until, fromMe, limit, includeReactions }) => {
    const { instance, scope } = useMcpAuth()

    const terms = query.split(/\s+/).filter(Boolean)
    if (!terms.length) {
      throw createError({ statusCode: 400, message: '`query` needs at least one word to search for.' })
    }

    if (jid) assertChatAllowed(scope, jid)

    const { hits, hasMore } = await searchMessages(instance, {
      terms,
      jids: jid ? [jid] : undefined,
      // A named chat is already checked above. Otherwise a scoped token gets its
      // allowlist pushed into the query, so out-of-scope messages are never read.
      allowedJids: jid || scope.allChats ? undefined : scope.chatJids,
      since,
      until,
      fromMe,
      includeReactions,
      limit,
      page: 1,
    })

    const [names, directory] = await Promise.all([
      chatNames(instance, hits),
      resolveNames(instance, hits),
    ])

    return {
      query,
      matches: hits.map(hit => ({
        jid: hit.jid,
        id: hit.id,
        fromMe: hit.fromMe,
        author: authorName({ fromMe: hit.fromMe, ...hit.sender }, directory),
        timestamp: hit.timestamp,
        type: hit.type,
        text: applyMentions(hit.text, hit.mentioned, directory) ?? hit.text,
        ...(hit.editOf && { editOf: hit.editOf }),
        chatName: names.get(hit.jid),
      })),
      count: hits.length,
      // Say so rather than presenting a capped page as the whole answer.
      truncated: hasMore,
      // Same principle: a whole message class this search never looked at.
      ...(!includeReactions && { reactionsExcluded: true }),
    }
  },
})

/**
 * Label the chats a search landed in.
 *
 * Reuses `listChats` rather than deriving names in SQL: naming is not obvious
 * here (see the `EvolutionChatRow` note in `chats.ts` — 2.3.7 aliases two
 * different columns as `pushName`, so names come from the contact table and the
 * group listing instead), and one source of naming rules is worth the round trip.
 *
 * Best effort. The group listing behind it can time out on a disconnected
 * account, and a result labelled with bare JIDs beats no result at all.
 */
async function chatNames(instance: AppInstance, hits: MessageSearchHit[]): Promise<Map<string, string>> {
  const wanted = new Set(hits.map(hit => hit.jid))
  if (!wanted.size) return new Map()

  try {
    const { chats } = await listChats(instance)
    return new Map(chats.filter(chat => wanted.has(chat.jid)).map(chat => [chat.jid, chat.name]))
  }
  catch (error) {
    console.error('[search] could not label chats:', error)
    return new Map()
  }
}

/**
 * Names for everyone the hits refer to — the people they mention, and the people
 * who sent them.
 *
 * Both come from the same directory, so they are resolved together: a group's
 * membership is one lookup whether it answers a mention or an author.
 *
 * Two passes, because the two sources cost wildly different amounts. Contacts are
 * one cached read that covers every chat at once, so they run first; group
 * membership is a live round trip *per group* and only runs for the groups that
 * still have something unresolved after that.
 *
 * A hit set can span more groups than it is worth waking the socket for, so the
 * second pass is capped, busiest group first — the cap trades a few unnamed
 * senders in the tail for a bounded response time. `read-messages` needs none of
 * this: it is one chat, so it is always exactly one lookup.
 *
 * Best effort throughout, like `chatNames`: an unresolved mention stays a raw id,
 * an unresolved author falls back to the stored push name or to nothing, and a
 * search still answers.
 */
const MENTION_GROUP_LOOKUPS = 8

/** Every identity a hit needs a name for: who it mentions, and who sent it. */
function identitiesOf(hit: MessageSearchHit): string[] {
  const identity = hit.fromMe ? undefined : hit.sender.identity
  return identity ? [...hit.mentioned, identity] : hit.mentioned
}

async function resolveNames(instance: AppInstance, hits: MessageSearchHit[]): Promise<MentionDirectory> {
  if (!hits.some(hit => identitiesOf(hit).length)) return new Map()

  try {
    const evolution = evolutionClientForInstance(instance)
    const contacts = await contactDirectory(instance, evolution)

    // Built once and then added to. Calling `mentionDirectory` again for the
    // group pass would re-walk the whole contact table and discard this.
    const directory = contactsToDirectory(contacts)

    const unresolvedByGroup = new Map<string, number>()
    for (const hit of hits) {
      if (!hit.jid.endsWith('@g.us')) continue
      const missing = identitiesOf(hit).filter(jid => !directory.has(localPartOf(jid))).length
      if (missing) unresolvedByGroup.set(hit.jid, (unresolvedByGroup.get(hit.jid) ?? 0) + missing)
    }

    if (!unresolvedByGroup.size) return directory

    const chatJids = [...unresolvedByGroup.entries()]
      .sort(([, a], [, b]) => b - a)
      .slice(0, MENTION_GROUP_LOOKUPS)
      .map(([jid]) => jid)

    return await addGroupMembers(directory, { instance, evolution, chatJids })
  }
  catch (error) {
    console.error('[search] could not resolve names:', error)
    return new Map()
  }
}
