import { z } from 'zod'

/**
 * Read tool. Chat scope is applied inside the listing (`allowedJids`), not by
 * filtering a page afterwards: a scoped token sees its own conversations and
 * simply does not learn the others exist, and `total`/`hasMore` describe only
 * what it may see.
 *
 * **This answers with one page, and says so.** `hasMore` means "there is another
 * page of what the listing holds"; presenting a page as the complete list makes a
 * model conclude those are all the conversations there are.
 *
 * Paging is cheap now: `listChatsPage` cuts a listing that `chatListing()` walks
 * once and caches for 60 seconds, so a page is a slice in memory, not a call to
 * Evolution. The flip side is that pages come off a snapshot, which is why
 * `truncated` and `incomplete` ride on every page, including an empty one past
 * the end — `listChatsPage` never throws on a failed walk, so the flag is the only
 * thing telling the caller a short listing is short.
 */
export default defineKindTool({
  name: 'list-chats',
  kind: 'whatsapp',
  title: 'List WhatsApp chats',
  description:
    'List WhatsApp conversations with the `jid` needed by read-messages, '
    + 'including ones imported from the phone when the account was paired. To '
    + 'find a group or contact by name, pass `query`: a fragment of the name or '
    + 'number, matched ignoring case and accents ("sao paulo" finds "São Paulo"). '
    + 'Narrow with `type` (group or direct) and `unreadOnly`; order by most recent '
    + 'activity (`sort: "last"`, the default) or by name. If this connector is '
    + 'scoped to specific chats, only those are listed. An answer is one page: '
    + 'when `hasMore` is true, call again with `nextPage` and the same arguments '
    + 'before treating the list as complete. Pages are cut from a snapshot of the '
    + 'chat list that refreshes every minute, so with `sort: "last"` new activity '
    + 'can reorder chats between pages — a chat may repeat or be skipped, which '
    + 'is why you should collect by `jid`. `truncated` (the account holds more '
    + 'chats than the listing will) and `incomplete` (WhatsApp could not be asked '
    + 'for all of them) appear only when true, and then the list may not contain '
    + 'the chat you want; `unnamedGroups` appears only when above zero, counting '
    + 'groups with no name right now, which a name search can miss. `unreadCount` '
    + 'is the last state this connection saw, not a live read of the phone. '
    + 'search-messages finds a conversation by what was said in it.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    query: z.string().min(1).max(100).optional().describe(
      'Fragment of a chat name or number to look for, e.g. "familia" or "5511". '
      + 'Ignores case and accents. Omit to list everything.',
    ),
    type: z.enum(['all', 'group', 'direct']).default('all').describe('Only group chats, only one-to-one chats, or both'),
    unreadOnly: z.boolean().optional().describe('Only conversations with unread messages'),
    sort: z.enum(['last', 'name']).default('last').describe('`last`: most recently active first. `name`: alphabetical.'),
    page: z.number().int().min(1).default(1).describe('1-based page of `limit` chats. Walk this up while `hasMore` is true.'),
    limit: z.number().int().min(1).max(200).default(200).describe('How many chats to return in this page'),
  },
  handler: async ({ query, type, unreadOnly, sort, page, limit }) => {
    const { instance, scope } = useMcpAuth()

    const result = await listChatsPage(instance, {
      q: query,
      type,
      unreadOnly,
      sort,
      dir: sort === 'last' ? 'desc' : 'asc',
      limit,
      page,
      // Scope is a predicate inside the listing, before anything is counted.
      allowedJids: scope.allChats ? undefined : new Set(scope.chatJids),
    })

    const { chats, hasMore, total, truncated, incomplete, unnamedGroups } = result

    // One `note`, assembled from whichever gaps are real.
    const notes = [
      hasMore
        ? `This page holds chats ${(page - 1) * limit + 1}-${(page - 1) * limit + chats.length} of ${total} matching; call list-chats again with page: ${page + 1} and the same arguments. Do not tell the user these are all their chats until hasMore is false.`
        : undefined,
      truncated || incomplete
        ? 'The chat list is '
          + [truncated && 'truncated (the account holds more chats than the listing will)', incomplete && 'incomplete (WhatsApp could not be asked for all of them)']
            .filter(Boolean).join(' and ')
          + ', so it may not contain the chat you want; try search-messages.'
        : undefined,
      unnamedGroups > 0 && query
        ? `${unnamedGroups} group${unnamedGroups === 1 ? ' has' : 's have'} no name right now because WhatsApp did not answer; a name search can miss them — retry in a minute or use search-messages.`
        : undefined,
      total === 0 && query
        ? 'No chat matched. Try a shorter fragment or search-messages; do not conclude the chat does not exist.'
        : undefined,
    ].filter((note): note is string => Boolean(note))

    return {
      count: chats.length,
      page,
      total,
      hasMore,
      ...(hasMore && { nextPage: page + 1 }),
      ...(truncated && { truncated }),
      ...(incomplete && { incomplete }),
      ...(unnamedGroups > 0 && { unnamedGroups }),
      ...(notes.length > 0 && { note: notes.join(' ') }),
      chats,
    }
  },
})
