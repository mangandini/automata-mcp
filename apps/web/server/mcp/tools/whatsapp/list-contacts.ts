import { z } from 'zod'

/**
 * Read tool. Chat scope is option (a) of the user's decision: an unscoped token
 * gets the whole address book; a scoped one only the contacts whose JID is in
 * `scope.chatJids`. It is applied inside the listing (`allowedJids`), as in
 * `list-chats`, not by filtering a page afterwards: `total` and `hasMore`
 * describe only what the token may see, and it does not learn that other
 * contacts exist.
 *
 * The match is exact on the JID. A contact Evolution knows by LID will not match
 * a scope entry stored as a phone-number JID (and vice versa), so it is left out
 * rather than guessed at — failing closed. Nothing is normalised here, and
 * `contactDirectory` is left untouched: mentions and author names share it and
 * must keep seeing every contact. It also swallows a failed `fetchContacts` as
 * an empty list, which is why an empty answer carries a note.
 *
 * Groups are excluded: they are conversations, found with `list-chats`.
 *
 * **This answers with one page, and says so.** Presenting a page as the whole
 * address book makes a model conclude those are all the contacts there are.
 */
export default defineKindTool({
  name: 'list-contacts',
  kind: 'whatsapp',
  title: 'List WhatsApp contacts',
  description:
    'List the contacts WhatsApp knows for this account, with their `jid` and, '
    + 'when the contact has a phone number, `number`. Pass `query` to find one by '
    + 'a fragment of the name or number, matched ignoring case and accents. Groups '
    + 'are not included; use list-chats for those. Ordered by name. If this '
    + 'connector is scoped to specific chats, only contacts for those are listed. '
    + 'An answer is one page: when `hasMore` is true, call again with `nextPage` '
    + 'and the same arguments before treating the list as complete.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    query: z.string().min(1).max(100).optional().describe(
      'Fragment of a contact name or number to look for, e.g. "maria" or "5511". '
      + 'Ignores case and accents. Omit to list everything.',
    ),
    page: z.number().int().min(1).default(1).describe('1-based page of `limit` contacts. Walk this up while `hasMore` is true.'),
    limit: z.number().int().min(1).max(200).default(100).describe('How many contacts to return in this page'),
  },
  handler: async ({ query, page, limit }) => {
    const { instance, scope } = useMcpAuth()

    const result = await listContacts(instance, {
      q: query,
      sort: 'name',
      dir: 'asc',
      limit,
      page,
      excludeGroups: true,
      // Scope is a predicate inside the listing, before anything is counted.
      allowedJids: scope.allChats ? undefined : new Set(scope.chatJids),
    })

    const { hasMore, total } = result
    // Evolution falls back to the bare local part when it has no name; presented
    // as `name` that id would be quoted as one, so it is left out instead.
    const contacts = result.contacts.map(({ jid, name, number }) => {
      const realName = meaningfulName(name, localPartOf(jid))
      return { jid, ...(realName && { name: realName }), number }
    })

    const notes = [
      hasMore
        ? `This page holds contacts ${(page - 1) * limit + 1}-${(page - 1) * limit + contacts.length} of ${total} matching; call list-contacts again with page: ${page + 1} and the same arguments. Do not tell the user these are all their contacts until hasMore is false.`
        : undefined,
      total === 0 && !query
        ? (scope.allChats
          ? 'The contact list came back empty; Evolution may not have answered. This does not mean the account has no contacts.'
          : "No contacts in this connector's chat scope.")
        : undefined,
      total === 0 && query
        ? 'No contact matched; try a shorter fragment or list-chats.'
        : undefined,
    ].filter((note): note is string => Boolean(note))

    return {
      count: contacts.length,
      page,
      total,
      hasMore,
      ...(hasMore && { nextPage: page + 1 }),
      ...(notes.length > 0 && { note: notes.join(' ') }),
      contacts,
    }
  },
})
