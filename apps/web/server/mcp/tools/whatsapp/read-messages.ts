import { z } from 'zod'
import type { AppInstance } from '~~/server/utils/app-db'
import type { ChatMessage } from '~~/server/utils/chats'
import type { ChatTarget } from '~~/server/utils/chat-target'

/**
 * Read tool. Unlike list-chats this refuses loudly when the requested chat is out
 * of scope: returning an empty history would read as "this conversation is
 * empty", which is a different and wrong statement.
 *
 * The same principle governs the response envelope. Pages are newest-first and
 * capped at `limit`, so a page of a `since`-bounded window is
 * missing the *old* end — the part the caller named. Returned bare, it reads as
 * the whole window, and a model summarising it writes a confident summary with a
 * hole in the middle. So every response says whether it is complete
 * (`hasMore`), what span it actually covers (`covered`), and how to get the
 * rest (`nextPage`, plus a `note` in words because the flag alone was not
 * enough).
 */
export default defineKindTool({
  name: 'read-messages',
  kind: 'whatsapp',
  // Refuse unknown arguments: a misspelled `author` or `around` silently ignored
  // would read as the plain newest-first page.
  strictInput: true,
  title: 'Read WhatsApp messages',
  description:
    'Read one page of messages from one WhatsApp conversation, newest first. '
    + 'Takes the `jid` returned by list-chats, or a phone number (digits, '
    + 'optionally with +, spaces or hyphens); every form of that number the '
    + 'token may read is read together and listed in `chatsRead`. Inside a group, '
    + '`author` (a name or a number) returns every message that member sent, '
    + 'media included, and combines with `page`, `since` and `until`. To see a '
    + 'message in context, pass its id (from search-messages or this tool) as '
    + '`around`: you get up to `before` messages before it and `after` after it '
    + '(0-50, default 10 each) in chronological order, the requested one flagged '
    + '`target: true`, with `hasMoreBefore`/`hasMoreAfter`; the window can hold '
    + 'fewer readable messages than asked when neighbouring records are control '
    + 'records (see `protocolMessagesExcluded`). `around` cannot be combined with '
    + '`page`, `since`, `until` or `author`. Covers the history imported when '
    + 'the account was paired as well as everything since, so older '
    + 'conversations are reachable — use `since`/`until` to target a date range. '
    + 'A response is one page, not the whole range: when `hasMore` is true there '
    + 'are older messages you have not seen, so call again with `nextPage` and '
    + 'the same `jid`, `limit` and `window` bounds, and keep going until '
    + '`hasMore` is false before treating the range as fully read. `covered` '
    + 'reports the span this page actually covers, which for a truncated range is '
    + 'narrower than the one you asked for, and `totalMatching`/`totalPages` say '
    + 'how much the range holds in full — a count of distinct messages, safe to '
    + 'quote. A message you sent is marked `fromMe` and carries no `author`; on '
    + 'one you received, `author` is the sender\'s name where the account knows '
    + 'it, and absent where it does not. Reaction messages are left out unless '
    + '`includeReactions` is set. @-mentions in the text are shown as names '
    + 'where the account knows them, and left as raw numeric ids where it does '
    + 'not — an id is not a name to guess at. An edited message arrives as its '
    + 'own record carrying the new text, with `editOf` naming the message it '
    + 'replaces; that earlier record is still in the history with the text it '
    + 'had before, so read the pair as one message that changed rather than as '
    + 'two. WhatsApp\'s own control records — deletions, disappearing-message '
    + 'timer changes, key exchanges — carry nothing to read and are left out, '
    + 'counted by `protocolMessagesExcluded` when any were, and still included '
    + 'in `totalMatching`. An edit that WhatsApp encrypted for the chat\'s '
    + 'participants comes back with no text and `unreadable: '
    + '\'encrypted-edit\'`: the current wording of that message is unknown '
    + 'here, so report it as unknown rather than treating the earlier version '
    + 'as final. To find a message by what it says, prefer search-messages when '
    + 'this connector offers it.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    jid: z.string().min(1).describe('Chat identifier from list-chats, e.g. 5511999999999@s.whatsapp.net, or a phone number'),
    limit: z.number().int().min(1).max(200).default(50).describe('How many messages to return in this page'),
    page: z.number().int().min(1).default(1).describe('1-based page of `limit` messages, counting back from the newest. Walk this up while `hasMore` is true.'),
    since: z.string().optional().describe('Only messages at or after this date, e.g. 2024-03-01 or 2024-03-01T12:00:00Z'),
    until: z.string().optional().describe('Only messages at or before this date. Pass back the `window.until` from a previous page when paging a range.'),
    author: z.string().min(1).optional().describe('Only messages sent by this group member: a name or a phone number. Needs the `jid` of a group. Not compatible with `around`.'),
    around: z.string().min(1).optional().describe('A message id: return the messages around it instead of a page. Not compatible with `page`, `since`, `until` or `author`.'),
    before: z.number().int().min(0).max(50).optional().describe('With `around`: messages before the target (default 10).'),
    after: z.number().int().min(0).max(50).optional().describe('With `around`: messages after the target (default 10).'),
    includeReactions: z.boolean().default(false).describe(
      'Include reaction messages. Each reaction is its own record — an id, an '
      + 'author, a timestamp and an emoji — so in an active group they are a '
      + 'large share of a page while rarely mattering for reconstructing the '
      + 'conversation. Off by default for that reason; turn it on when who '
      + 'reacted is the question.',
    ),
  },
  handler: async ({ jid, limit, page, since, until, author, around, before, after, includeReactions }) => {
    const { instance, scope } = useMcpAuth()

    if (around === undefined) {
      if (before !== undefined || after !== undefined) {
        throw createError({ statusCode: 400, message: '`before` and `after` only work together with `around`.' })
      }
    }
    else {
      // `page` defaults to 1, so an explicit `page: 1` is indistinguishable from
      // omitting it and is harmless; anything above 1 is a real conflict.
      const clashes = [
        page > 1 && '`page`',
        since !== undefined && '`since`',
        until !== undefined && '`until`',
        author !== undefined && '`author`',
      ].filter(Boolean)
      if (clashes.length) {
        throw createError({ statusCode: 400, message: `\`around\` cannot be combined with ${clashes.join(', ')}: it returns the messages around one message, not a page of a range.` })
      }
    }

    // Scope is checked inside, for every form it returns, before any read.
    const target = await resolveChatTarget(instance, scope, jid)

    if (around !== undefined) {
      return await readAround({ instance, target, jid, around, before: before ?? 10, after: after ?? 10, includeReactions })
    }

    // `resolveChatTarget` has already checked the scope for every jid it returns.
    const resolution = author ? await resolveAuthor(instance, scope, target.jids[0]!, author) : undefined
    const chatsRead = target.jids

    // Named `range` rather than `window` only to keep the DOM global unshadowed;
    // it goes back to the caller as `window`.
    const range = {
      since: toIsoDate(since, 'since'),
      // Pin the upper bound as soon as the caller names a lower one. An
      // unpinned `until` means *now*, a value that moves between calls, so page
      // 2 would come from a different range than page 1. Pinned here and echoed
      // back as `window`, paging a range is repeatable. Not about a bound being
      // ignored — the SQL path emits one predicate per bound. Left alone when
      // there is no `since`: putting a `messageTimestamp` predicate on an
      // ordinary unfiltered read would hit a table Evolution indexes by
      // instance and nothing else.
      until: toIsoDate(until, 'until') ?? (since ? new Date().toISOString() : undefined),
    }

    // `includeReactions` is passed alongside `range` rather than folded into it:
    // `range` is echoed back to the caller as `window`, and it should describe
    // the time bounds and nothing else.
    if (resolution?.kind === 'ambiguous' || resolution?.kind === 'none') {
      const ambiguous = resolution.kind === 'ambiguous'
      return {
        jid,
        chatsRead,
        page,
        limit,
        count: 0,
        hasMore: false,
        ...(isBounded(range) && { window: range }),
        ...(!includeReactions && { reactionsExcluded: true }),
        ...(resolution.kind === 'ambiguous' && { authorCandidates: resolution.candidates }),
        messages: [],
        note: ambiguous
          ? [
              `More than one member matches the author "${author}", so nothing was read. Call again with a more specific name or the person's phone number.`,
              resolution.note,
            ].filter(Boolean).join(' ')
          : [`No member of this group matches the author "${author}", so nothing was read.`, resolution.note].filter(Boolean).join(' '),
      }
    }

    const { messages, hasMore, total, protocolMessagesExcluded } = await listMessages(
      instance, target.jids[0]!, {
        limit,
        page,
        ...range,
        includeReactions,
        jids: target.jids,
        author: resolution?.filter,
      },
    )

    const covered = coveredSpan(messages)
    const bounded = isBounded(range)

    // One `note` key, assembled from whichever gaps are real — a second
    // note-shaped key would just be a second thing to miss. Byte-identical to
    // what it always said when nothing was dropped.
    const notes = [
      hasMore
        ? incompleteNote({ page, limit, count: messages.length, excluded: protocolMessagesExcluded, range })
        : undefined,
      protocolMessagesExcluded > 0 ? droppedNote(protocolMessagesExcluded) : undefined,
      !messages.length && target.fromNumber
        ? 'This number may also have a chat stored under an internal id (@lid) that this connector could not link to it; try list-chats with the person\'s name.'
        : undefined,
      resolution?.kind === 'ok' ? resolution.note : undefined,
    ].filter((note): note is string => Boolean(note))

    return {
      jid,
      chatsRead,
      page,
      limit,
      count: messages.length,
      // Wrong only in the safe direction: a page that came back full reports
      // `true` even when it happens to be the last one, which costs one more
      // call returning nothing. A partial answer is never reported as complete.
      hasMore,
      ...(total !== undefined && {
        totalMatching: total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      }),
      ...(hasMore && { nextPage: page + 1 }),
      ...(bounded && { window: range }),
      // The span these messages actually cover, which is the visible half of
      // what truncation took: with `since` set and `hasMore` true, everything
      // between `window.since` and `covered.from` is still unread.
      ...(covered && { covered }),
      // Omitted at zero, so its presence always means something really was
      // dropped. Deliberately not subtracted from `totalMatching`: that count is
      // taken over the whole range, while this describes one page — patching it
      // here would produce a confidently wrong number across pages.
      ...(protocolMessagesExcluded > 0 && { protocolMessagesExcluded }),
      ...(notes.length > 0 && { note: notes.join(' ') }),
      // Same principle as `hasMore`, for a different kind of gap: a whole class
      // of message is missing, and a caller that does not know it was dropped
      // reads the silence as "nobody reacted".
      ...(!includeReactions && { reactionsExcluded: true }),
      ...(resolution?.kind === 'ok' && {
        authorResolved: { names: resolution.names, matchedBy: resolution.matchedBy },
      }),
      messages,
    }
  },
})

function isBounded(range: { since?: string, until?: string }): boolean {
  return Boolean(range.since || range.until)
}

/**
 * The `around` branch: one message in context. A number can resolve to several
 * stored forms of one chat; a message id belongs to one message, so the first
 * form that holds it is the chat.
 */
async function readAround(
  { instance, target, jid, around, before, after, includeReactions }: {
    instance: AppInstance
    target: ChatTarget
    jid: string
    around: string
    before: number
    after: number
    includeReactions: boolean
  },
) {
  let found: Awaited<ReturnType<typeof listMessagesAround>> | undefined
  let chatJid = target.jids[0]!
  for (const candidate of target.jids) {
    const result = await listMessagesAround(instance, { jid: candidate, id: around, before, after, includeReactions })
    if (result.found) {
      found = result
      chatJid = candidate
      break
    }
  }

  if (!found) {
    throw createError({ statusCode: 404, message: 'Message id not found in this chat.' })
  }

  const dropped = found.protocolMessagesExcluded
  const notes = [
    found.targetUnreadable
      ? 'The requested message exists but is a WhatsApp control record (deletion, timer change, key exchange or similar) with nothing to read, so no message is flagged as the target; the messages around it are returned.'
      : undefined,
    // Only when something really was left out: a note present on every response
    // teaches the caller to skip notes.
    dropped > 0
      ? `The window holds fewer than ${before} before / ${after} after readable messages because ${dropped} neighbouring control record${dropped === 1 ? ' was' : 's were'} left out (counted in protocolMessagesExcluded).`
      : undefined,
  ].filter((note): note is string => Boolean(note))

  return {
    jid,
    chatsRead: [chatJid],
    around,
    before,
    after,
    count: found.messages.length,
    hasMoreBefore: found.hasMoreBefore,
    hasMoreAfter: found.hasMoreAfter,
    ...(dropped > 0 && { protocolMessagesExcluded: dropped }),
    ...(found.targetUnreadable && { targetUnreadable: true }),
    ...(notes.length > 0 && { note: notes.join(' ') }),
    ...(!includeReactions && { reactionsExcluded: true }),
    messages: found.messages,
  }
}

/**
 * Said in words as well as in a flag. The failure this exists to prevent was a
 * caller reading `count: 200` against `limit: 200` and concluding the window
 * held exactly 200 messages.
 */
function incompleteNote(
  { page, limit, count, excluded, range }:
  { page: number, limit: number, count: number, excluded: number, range: { since?: string, until?: string } },
): string {
  const scope = range.since ? 'inside the requested window' : 'in this conversation'
  const first = (page - 1) * limit + 1
  // Measured against what Evolution returned, not against what survived
  // filtering: paging walks its rows, so the ordinal of the last message on this
  // page has to count the ones dropped from it.
  const last = (page - 1) * limit + count + excluded

  return `Incomplete: this is page ${page} — messages ${first}-${last} ${scope}, counting back from the `
    + `newest, and not all of them. Older messages ${scope} were NOT returned. Call read-messages again `
    + `with page: ${page + 1}, the same jid and limit`
    + `${range.since || range.until ? ', and the same window bounds' : ''}, and keep going until hasMore `
    + 'is false. Do not summarise this range until then.'
}

/**
 * The count alone reads as "something is missing here". It is the opposite:
 * these rows had nothing in them. Said in words so a caller neither ignores the
 * number nor reports a hole that is not there.
 */
function droppedNote(count: number): string {
  const records = count === 1
    ? '1 WhatsApp control record was'
    : `${count} WhatsApp control records were`

  return `${records} left out of this page — deletions, disappearing-message timer changes, key `
    + 'exchanges and similar bookkeeping, which carry no readable content. Nothing readable was '
    + 'dropped: an edited message is returned as its new text, with editOf naming the message it '
    + 'replaces. totalMatching still counts these records, so it can exceed the messages you receive.'
}

/**
 * Oldest and newest timestamp actually present, computed as a min/max rather
 * than read off the ends of the array. Some message types carry no timestamp at
 * all, and deriving the span from position would quietly become a lie if
 * Evolution's ordering ever changed.
 */
function coveredSpan(messages: ChatMessage[]): { from: string, to: string } | undefined {
  // ISO 8601 UTC strings sort chronologically as text; they all come from
  // `toISOString()`.
  const stamps = messages
    .map(message => message.timestamp)
    .filter((timestamp): timestamp is string => Boolean(timestamp))
    .sort()

  const from = stamps[0]
  const to = stamps[stamps.length - 1]

  return from && to ? { from, to } : undefined
}

/**
 * Normalise a bound to ISO 8601, refusing anything unparseable.
 *
 * `parseDateBound` in `evolution-db.ts` does the parsing and owns the refusal,
 * so the query and this envelope cannot disagree about what a date is. The ISO
 * string is what goes back to the caller as `window`, for it to hand to the
 * next page.
 */
function toIsoDate(value: string | undefined, label: string): string | undefined {
  return parseDateBound(value, label)?.toISOString()
}
