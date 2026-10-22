import type { AppInstance } from './app-db'
import type { EvolutionClient } from './evolution'
import type { MentionDirectory } from './mentions'
import { applyMentions, authorName, contactsToDirectory, meaningfulName, mentionDirectory, mentionedJidsOf } from './mentions'
import { listMessagesPage, senderOf } from './evolution-db'
import { matchesSearch } from './search-text'

/**
 * Reading conversations out of Evolution.
 *
 * Shared by the MCP tools and the UI's chat picker so both see the same shape
 * and the same caveats.
 */

export interface ChatSummary {
  jid: string
  name: string
  isGroup: boolean
  /** Bare phone number of a 1:1 chat. Groups do not have one. */
  number?: string
  /** Members in a group, and only when the group lookup actually ran. */
  participantCount?: number
  profilePicUrl?: string
  updatedAt?: string
  /**
   * When the last message in the chat was sent, ISO 8601.
   *
   * Preferred over `updatedAt`, which is the Chat row's mtime and so also moves
   * for a read receipt or an unread-count change. Absent if Evolution's chat row
   * carries no last message — fall back to `updatedAt` for display.
   */
  lastMessageAt?: string
  unreadCount: number
  lastMessagePreview?: string
}

export interface ChatMessage {
  id?: string
  fromMe: boolean
  author?: string
  timestamp?: string
  type?: string
  text?: string
  /**
   * The `id` of the message this one edits, when it is an edit.
   *
   * WhatsApp delivers an edit as its own record and never rewrites the original,
   * so history holds both: this row with the new text, and an earlier row that
   * still reads as it did before. Nothing merges the pair — read them as one
   * message that changed, not as two. The target may not be on this page.
   */
  editOf?: string
  /**
   * Content that exists and this server cannot render, named rather than left
   * blank. `text` is absent whenever this is set.
   */
  unreadable?: UnreadableReason
}

/**
 * Why a message came back with no text.
 *
 * Both values describe a `secretEncryptedMessage`, which is an *encrypted
 * message edit* — WhatsApp's newer replacement for a plaintext
 * `protocolMessage{type:14}`. Not a view-once, not a disappearing message: a
 * caller told only "encrypted" reports the wrong gap. The payload is AES-GCM
 * under a key derived from the *original* message's
 * `messageContextInfo.messageSecret`, which this row does not carry, so it is
 * unrecoverable from storage. Neither Baileys 7.0.0-rc.9 nor Evolution 2.3.7
 * decrypts it and neither does this app.
 *
 * Two values rather than one because proto3 omits a zero: an absent
 * `secretEncType` means `UNKNOWN = 0`, not `MESSAGE_EDIT`. Reporting an
 * unlabelled row as an edit would be a guess, in the one field whose whole
 * purpose is not to guess.
 */
export type UnreadableReason = 'encrypted-edit' | 'encrypted-content'

export interface ChatQuery {
  /** Page size. */
  take?: number
  /** Rows to skip. Evolution maps this straight to SQL `OFFSET`. */
  skip?: number
}

/**
 * One page of the account's conversations.
 *
 * The envelope is here because the obvious completeness signal is a trap. The
 * dashboard's chat count is `_count.Chat` — rows in Evolution's `Chat` table —
 * while this listing is `DISTINCT ON (remoteJid)` over `"Message"`. History sync
 * writes a `Chat` row for every conversation the phone lists but persists only
 * the messages it actually delivered, so the listing is legitimately shorter and
 * no amount of paging closes the gap. Comparing the two announces a truncation
 * that is not there and offers a next page that comes back empty.
 */
export interface ChatPage {
  chats: ChatSummary[]
  /**
   * There may be another page behind this one.
   *
   * Derived from "the page came back full", never from a count — the same rule
   * `MessagePage.hasMore` follows, and here the only count within reach counts a
   * different population entirely.
   */
  hasMore: boolean
}

/**
 * The account's whole conversation listing, memoised per account.
 *
 * Evolution's `findChats` takes no search term and no ordering, so a table that
 * searches and sorts the *whole* account cannot push either down to it. The
 * listing is therefore walked once into this cache and filtered, sorted and
 * sliced here — which is also strictly cheaper than what paging used to cost:
 * naming the rows pulls Evolution's entire contact table, and that was paid once
 * per page while walking `skip`. Now it is paid once per listing.
 *
 * Successes only, as `contactDirectory()` does, and concurrent callers share one
 * walk — a dashboard opening its chats table while the scope picker loads would
 * otherwise start two.
 *
 * The TTL is short because the order is "last activity", which live traffic
 * reshuffles: long enough that paging and re-sorting cost nothing, short enough
 * that a new conversation appears without a reload.
 */
const CHAT_LISTING_TTL_MS = 60_000
/** One request to Evolution. Large on purpose — see `listChats`. */
const CHAT_LISTING_PAGE = 2000
/**
 * The most rows the walk will hold. A ceiling on memory and on how long a cold
 * cache can take, not a statement about the account: hitting it sets
 * `truncated`, which the caller must report rather than present as the end.
 */
const CHAT_LISTING_CAP = 10_000

interface ChatListing {
  chats: ChatSummary[]
  /**
   * The walk stopped at its cap: the account holds more conversations than this.
   *
   * Deliberately separate from `failed` below — "more than I will hold" and "I
   * could not finish asking" need different words in front of a user, and one
   * flag covering both would have to pick the wrong one half the time.
   */
  truncated: boolean
  /** A request to Evolution failed, so the listing may be short. Never cached. */
  failed: boolean
}

const chatListingCache = new Map<string, { expiresAt: number, listing: ChatListing }>()
const chatListingFetches = new Map<string, Promise<{ listing: ChatListing, cacheable: boolean }>>()

async function chatListing(instance: AppInstance): Promise<ChatListing> {
  const cached = chatListingCache.get(instance.id)
  if (cached && Date.now() < cached.expiresAt) return cached.listing

  const inFlight = chatListingFetches.get(instance.id)
  if (inFlight) return (await inFlight).listing

  const fetching = buildChatListing(instance)
    .then((result) => {
      if (result.cacheable) {
        chatListingCache.set(instance.id, {
          expiresAt: Date.now() + CHAT_LISTING_TTL_MS,
          listing: result.listing,
        })
      }
      return result
    })
    .finally(() => chatListingFetches.delete(instance.id))

  chatListingFetches.set(instance.id, fetching)
  return (await fetching).listing
}

/**
 * Walk `findChats` to the end, then name what came back.
 *
 * Evolution builds this listing from its own tables, which are seeded by the
 * history WhatsApp hands over at pairing and then kept current by live traffic.
 * An account paired before `syncFullHistory` was switched on has no seed and so
 * shows only conversations active since — which is one reason the UI also lets a
 * number be added by hand. Returning nothing is never an error.
 *
 * The order is `updatedAt DESC`, which live traffic reshuffles between requests,
 * so pages are deduped by JID rather than trusted to be disjoint — the same rule
 * the dialog used to apply in the browser.
 *
 * A failure is never cached: the first page failing is indistinguishable from a
 * freshly paired account and must not break the picker, and a later page failing
 * leaves a short listing that would otherwise be served as complete for a minute.
 */
async function buildChatListing(instance: AppInstance): Promise<{ listing: ChatListing, cacheable: boolean }> {
  const evolution = evolutionClientForInstance(instance)

  interface ChatDraft {
    jid: string
    localPart: string
    isGroup: boolean
    chatName?: string
    profilePicUrl?: string
    updatedAt?: string
    lastMessageAt?: string
    unreadCount: number
    lastMessagePreview?: string
  }

  const byJid = new Map<string, ChatDraft>()
  let truncated = false
  let failed = false

  for (let skip = 0; ; skip += CHAT_LISTING_PAGE) {
    let rows: EvolutionChatRow[] | undefined
    try {
      rows = await evolution<EvolutionChatRow[]>(
        `/chat/findChats/${encodeURIComponent(instance.name)}`,
        { method: 'POST', body: { take: CHAT_LISTING_PAGE, skip } },
      )
    }
    catch (error) {
      console.error('[chats] could not list conversations:', error)
      rows = undefined
    }

    if (!Array.isArray(rows)) {
      // Keep whatever earlier pages produced and do not cache it. Callers decide
      // what a short listing means: the table says so and shows what it has, and
      // `listChats` refuses a page past the first rather than letting a failure
      // read as the end of the list.
      failed = true
      break
    }

    for (const row of rows) {
      if (typeof row?.remoteJid !== 'string') continue
      const jid = row.remoteJid
      if (byJid.has(jid)) continue
      const localPart = jid.split('@')[0]!
      byJid.set(jid, {
        jid,
        localPart,
        isGroup: jid.endsWith('@g.us'),
        chatName: meaningfulName(row.pushName, localPart),
        profilePicUrl: row.profilePicUrl ?? undefined,
        updatedAt: row.updatedAt ?? undefined,
        lastMessageAt: isoFromEpochSeconds(row.lastMessage?.messageTimestamp),
        unreadCount: Number(row.unreadCount ?? 0),
        // Unwrapped for the same reason the read path is: an album item or an
        // edited caption previews as blank otherwise. A control record has no
        // payload once classified, so it previews blank either way.
        lastMessagePreview: previewOf(classifyContent(row.lastMessage?.message).payload),
      })
    }

    if (rows.length < CHAT_LISTING_PAGE) break
    if (byJid.size >= CHAT_LISTING_CAP) {
      truncated = true
      break
    }
  }

  const drafts = [...byJid.values()]

  // Only pay for the group listing when it can change an answer — every group
  // that the chat rows alone already name is a round trip per group we skip.
  const needsGroups = drafts.some(draft => draft.isGroup && !draft.chatName)

  const [contacts, groups] = await Promise.all([
    contactDirectory(instance, evolution),
    needsGroups ? fetchGroups(instance, evolution) : Promise.resolve(emptyGroups),
  ])

  const chats = drafts.map((draft) => {
    const contact = contacts.get(draft.jid)
    const group = groups.get(draft.jid)

    // A group's subject is authoritative; for a person the saved contact name is
    // what they expect to read. Everything falls through to the bare id, which is
    // still a truthful label — just not a helpful one.
    const name = draft.isGroup
      ? group?.subject ?? draft.chatName ?? contact?.name ?? draft.localPart
      : contact?.name ?? draft.chatName ?? draft.localPart

    return {
      jid: draft.jid,
      name,
      isGroup: draft.isGroup,
      number: draft.isGroup ? undefined : draft.localPart,
      participantCount: group?.size,
      profilePicUrl: draft.profilePicUrl ?? contact?.profilePicUrl ?? group?.pictureUrl,
      updatedAt: draft.updatedAt,
      lastMessageAt: draft.lastMessageAt,
      unreadCount: draft.unreadCount,
      lastMessagePreview: draft.lastMessagePreview,
    }
  })

  return { listing: { chats, truncated, failed }, cacheable: !failed }
}

/**
 * Recent conversations, newest activity first.
 *
 * Kept for the token scope picker and the `list-chats` tool, which page with
 * `take`/`skip` and want Evolution's own order. A slice of the memoised listing,
 * so it and the dashboard's table can never disagree about what exists.
 */
export async function listChats(instance: AppInstance, query: ChatQuery = {}): Promise<ChatPage> {
  const { take = 200, skip = 0 } = query
  const { chats, failed } = await chatListing(instance)

  // An empty first page is already the honest answer for a freshly paired
  // account, and must not break the picker or the MCP tool when Evolution is
  // down. A page past the first was asked for by a deliberate click, and a short
  // listing served there would render as the end of the list instead.
  if (failed && skip > 0) {
    throw createError({
      statusCode: 503,
      statusMessage: 'Listing conversations is temporarily unavailable',
    })
  }

  return {
    chats: chats.slice(skip, skip + take),
    hasMore: skip + take < chats.length,
  }
}

/** Which column the chats table is ordered by. */
export type ChatSortKey = 'name' | 'number' | 'type' | 'last'

export interface ChatTableQuery {
  /** Matched against name, JID and number. Case-insensitive, substring. */
  q?: string
  sort?: ChatSortKey
  dir?: 'asc' | 'desc'
  limit?: number
  /** 1-based. */
  page?: number
}

export interface ChatTablePage extends ChatPage {
  /** Conversations matching `q`, across the whole listing — not on this page. */
  total: number
  /**
   * The listing itself is capped — the account holds more than it will hold.
   *
   * Deliberately separate from `hasMore`: "there is another page of what I
   * have" and "there is more than I have" are different statements, and
   * collapsing them offers a next page that comes back empty.
   */
  truncated: boolean
  /**
   * Evolution could not be asked for all of it, so the table may be short.
   *
   * Not the same as the request failing — the page in hand is real. It is the
   * difference between "this is everything" and "this is what I could get".
   */
  incomplete: boolean
}

/**
 * One page of the chats table: searched, sorted and sliced over the whole
 * listing, here rather than in the browser.
 */
export async function listChatsPage(instance: AppInstance, query: ChatTableQuery = {}): Promise<ChatTablePage> {
  const { q, sort = 'last', dir = sort === 'last' ? 'desc' : 'asc', limit = 100, page = 1 } = query

  const { chats, truncated, failed } = await chatListing(instance)

  const matching = chats.filter(chat => matchesSearch(q, chat.name, chat.jid, chat.number))

  const sorted = [...matching].sort(chatComparator(sort, dir))
  const skip = (page - 1) * limit

  return {
    chats: sorted.slice(skip, skip + limit),
    hasMore: skip + limit < sorted.length,
    total: sorted.length,
    truncated,
    incomplete: failed,
  }
}

/**
 * Rows with nothing in the sorted column sink to the bottom in **both**
 * directions. Flipping the sort to bring the blanks to the top is never what
 * anyone wanted.
 */
function missingLast<T>(a: T | undefined, b: T | undefined, cmp: (x: T, y: T) => number, dir: number): number {
  if (a === undefined && b === undefined) return 0
  if (a === undefined) return 1
  if (b === undefined) return -1
  return dir * cmp(a, b)
}

function chatComparator(sort: ChatSortKey, dir: 'asc' | 'desc'): (a: ChatSummary, b: ChatSummary) => number {
  const sign = dir === 'asc' ? 1 : -1
  const byName = (a: ChatSummary, b: ChatSummary) => a.name.localeCompare(b.name)
  const activity = (chat: ChatSummary) => {
    const iso = chat.lastMessageAt ?? chat.updatedAt
    if (!iso) return undefined
    const ms = Date.parse(iso)
    return Number.isNaN(ms) ? undefined : ms
  }

  switch (sort) {
    case 'name':
      return (a, b) => sign * byName(a, b)
    case 'number':
      return (a, b) => missingLast(a.number, b.number, (x, y) => x.localeCompare(y, undefined, { numeric: true }), sign) || byName(a, b)
    case 'type':
      return (a, b) => sign * (Number(a.isGroup) - Number(b.isGroup)) || byName(a, b)
    case 'last':
      return (a, b) => missingLast(activity(a), activity(b), (x, y) => x - y, sign) || byName(a, b)
  }
}

export interface MessageQuery {
  /** Page size. Evolution calls this `offset`, confusingly. */
  limit?: number
  /** 1-based. Paging is how you reach anything older than `limit` messages. */
  page?: number
  /** Inclusive lower bound, ISO 8601. */
  since?: string
  /** Inclusive upper bound, ISO 8601. */
  until?: string
  /**
   * Keep reaction messages in the result.
   *
   * Defaults to true, which is what this helper has always done — nothing
   * changes without an explicit argument. The MCP tool is the thing that opts
   * out; see `read-messages`.
   */
  includeReactions?: boolean
}

/**
 * One page of a chat's history.
 *
 * The envelope matters as much as the rows. Evolution answers newest-first and
 * caps the response at the page size, so truncating a `since`-bounded window
 * drops the *old* end — precisely the part a caller who named a date range asked
 * for, while keeping the part they would have got without asking. A page that
 * does not say it is a page reads as a complete answer, and a summary written
 * from it has a hole in it. `searchMessages` in `evolution-db.ts` carries a
 * `truncated` flag for the same reason.
 */
export interface MessagePage {
  messages: ChatMessage[]
  /**
   * There may be another page behind this one.
   *
   * Derived from "the page came back full", never from `total`: a count that is
   * wrong upstream must not be able to drive a caller into paging forever. Being
   * wrong this way is wrong in the safe direction — an exactly-full final page
   * costs one extra call that returns nothing, and a page with more behind it is
   * never reported as complete.
   */
  hasMore: boolean
  /**
   * Distinct messages in the range, counted over the same deduplicated set the
   * page was cut from — so it counts the range asked for, not the chat, and not
   * the rows Evolution happens to hold for it.
   *
   * Reported as a number, never as a decision: `hasMore` does not read it. Absent
   * for a page past the end of the range, where there was nothing to count from.
   *
   * It does **not** exclude the control records dropped below: the query counts
   * the deduplicated set before this module reads a payload, so across a range it
   * can exceed the number of messages actually handed back.
   */
  total?: number
  /**
   * Control records dropped from this page — see `classifyContent`.
   *
   * Reported rather than silently subtracted, for the same reason `hasMore`
   * exists: a page that quietly loses a class of row reads as a complete one.
   * Required, not optional, so a new caller has to decide what to do with it
   * instead of reaching for `?? 0`.
   */
  protocolMessagesExcluded: number
}

/**
 * Message history for one chat, newest first.
 *
 * Reads Evolution's database rather than its API, which is not a preference: one
 * message is stored two or three times over a re-pair, and only SQL can collapse
 * those before the page is cut. `listMessagesPage` in `evolution-db.ts` explains
 * the duplicates and what the query does about them.
 *
 * What is left here is the shaping: a payload becomes a line of text, a sender
 * becomes a name. Both need the same name directory, so it is built once and used
 * for the authors and the @-mentions alike.
 *
 * There is no text search on this path — `searchMessages` is that — and no
 * `where` to widen: the range bounds are ordinary SQL predicates, so a one-sided
 * range means one predicate, and `read-messages` pins its own `until` only so
 * that paging a window is repeatable, not because a missing bound is ignored.
 */
export async function listMessages(
  instance: AppInstance,
  remoteJid: string,
  query: MessageQuery = {},
): Promise<MessagePage> {
  const { limit = 50, page = 1, since, until, includeReactions = true } = query

  const { records, hasMore, total } = await listMessagesPage(instance, {
    jid: remoteJid,
    limit,
    page,
    since,
    until,
    includeReactions,
  })

  // What is in the payload at all, which the SQL cannot ask: see
  // `classifyContent`. The reaction filter has no second layer here — the query
  // reads `message->'reactionMessage'`, which is the payload the old
  // `isReaction` existed to consult.
  const classified = records.map(row => ({
    row,
    content: classifyContent(row.message, row.messageType ?? undefined),
  }))
  const protocolMessagesExcluded = classified.filter(({ content }) => content.noise).length

  const drafts = classified
    .filter(({ content }) => !content.noise)
    .map(({ row, content }) => ({
      id: row.key?.id,
      fromMe: Boolean(row.key?.fromMe),
      sender: senderOf(row),
      timestamp: isoFromEpochSeconds(row.messageTimestamp),
      type: content.type ?? undefined,
      text: previewOf(content.payload),
      editOf: content.editOf,
      unreadable: content.unreadable,
      // The `contextInfo` column stays authoritative — see `MessageRow.mentioned`
      // in `evolution-db.ts`. But 2.3.7's `extendedTextMessage` rewrite only
      // touches the *top level*, so a message nested inside an edit or a wrapper
      // keeps its own `contextInfo` while the column may hold nothing. Those are
      // exactly the rows the classifier just surfaced for the first time, and
      // without the fallback their @-mentions read as raw LIDs.
      mentioned: row.mentioned?.length
        ? mentionedJidsOf(row.mentioned)
        : mentionedJidsOf(nestedContextInfo(content.payload)),
    }))

  const directory = await nameDirectory(instance, remoteJid, drafts)

  return {
    messages: drafts.map(draft => ({
      id: draft.id,
      fromMe: draft.fromMe,
      author: authorName({ fromMe: draft.fromMe, ...draft.sender }, directory),
      timestamp: draft.timestamp,
      type: draft.type,
      text: directory ? applyMentions(draft.text, draft.mentioned, directory) : draft.text,
      ...(draft.editOf && { editOf: draft.editOf }),
      ...(draft.unreadable && { unreadable: draft.unreadable }),
    })),
    // Comes from the query's over-fetch, and is measured on the deduplicated rows
    // it returned — never on `drafts`. Measuring the list after the control
    // records were dropped would report a bookkeeping-heavy page as the end of
    // the conversation. Deliberately not computed from `total` either, exact
    // though that now is; see `MessagePage`.
    hasMore,
    total,
    protocolMessagesExcluded,
  }
}

/** One message on the account-wide table, carrying the chat it belongs to. */
export interface AccountMessage extends ChatMessage {
  chatJid: string
  chatName: string
}

export interface AccountMessageQuery {
  /** Page size. */
  limit?: number
  /** 1-based, counting back from the newest. */
  page?: number
  /** Every term must appear in the body. Matched in SQL, across the account. */
  terms?: string[]
  /** Which end to start from. The only ordering this table offers — see below. */
  order?: 'newest' | 'oldest'
}

export interface AccountMessagePage {
  messages: AccountMessage[]
  hasMore: boolean
  total?: number
  protocolMessagesExcluded: number
  /** Always true. Stated rather than assumed — see `listAccountMessages`. */
  reactionsExcluded: boolean
}

/**
 * Every message on the account, newest first, as one searchable page.
 *
 * The dashboard's table. Search and paging are SQL, across the whole account —
 * a message table can hold six figures of rows, so neither can be done over a
 * loaded pool. Ordering is by time only, and that is a limit rather than an
 * omission: a sender's and a chat's *name* are resolved after the query, from
 * Evolution's contact table and its group subjects, so an ORDER BY can only
 * reach the raw JID and a name sort would quietly order one page.
 *
 * Reactions are left out, as the read tools leave them out: Evolution stores
 * every emoji as its own `Message` row, and in an active account they are a
 * large share of the table and almost never what someone is looking for. Said
 * out loud in `reactionsExcluded`, because a table that silently drops a class
 * of row reads as a complete one.
 *
 * Naming is best effort and deliberately cheap: contacts and group subjects,
 * both already memoised, and **no** per-group participant lookup. A page of a
 * hundred rows can span a hundred groups, and `search-messages` already
 * documents that pass as the expensive one. An unresolved sender falls back to
 * `pushName` through `authorName`, which still refuses a number or a JID as a
 * name.
 */
export async function listAccountMessages(
  instance: AppInstance,
  query: AccountMessageQuery = {},
): Promise<AccountMessagePage> {
  const { limit = 100, page = 1, terms, order = 'newest' } = query

  const { records, hasMore, total } = await listMessagesPage(instance, {
    limit,
    page,
    terms,
    order,
    includeReactions: false,
  })

  const classified = records.map(row => ({
    row,
    content: classifyContent(row.message, row.messageType ?? undefined),
  }))
  const protocolMessagesExcluded = classified.filter(({ content }) => content.noise).length

  const drafts = classified
    .filter(({ content }) => !content.noise)
    .map(({ row, content }) => ({
      id: row.key?.id,
      chatJid: row.key?.remoteJid ?? '',
      fromMe: Boolean(row.key?.fromMe),
      sender: senderOf(row),
      timestamp: isoFromEpochSeconds(row.messageTimestamp),
      type: content.type ?? undefined,
      text: previewOf(content.payload),
      editOf: content.editOf,
      unreadable: content.unreadable,
      mentioned: row.mentioned?.length
        ? mentionedJidsOf(row.mentioned)
        : mentionedJidsOf(nestedContextInfo(content.payload)),
    }))

  const names = await accountNames(instance, drafts.map(draft => draft.chatJid))

  return {
    messages: drafts.map(draft => ({
      id: draft.id,
      chatJid: draft.chatJid,
      chatName: names.chatName(draft.chatJid),
      fromMe: draft.fromMe,
      author: authorName({ fromMe: draft.fromMe, ...draft.sender }, names.directory),
      timestamp: draft.timestamp,
      type: draft.type,
      text: names.directory ? applyMentions(draft.text, draft.mentioned, names.directory) : draft.text,
      ...(draft.editOf && { editOf: draft.editOf }),
      ...(draft.unreadable && { unreadable: draft.unreadable }),
    })),
    hasMore,
    total,
    protocolMessagesExcluded,
    reactionsExcluded: true,
  }
}

/**
 * Chat labels and a mention directory for a page that spans many chats.
 *
 * Both halves come from caches this account already keeps warm, and both
 * degrade: a disconnected account resolves nothing and must still return its
 * messages, with a bare JID as the label. A raw id is honest; a wrong name is
 * the failure `mentions.ts` exists to prevent.
 */
async function accountNames(
  instance: AppInstance,
  chatJids: string[],
): Promise<{ chatName: (jid: string) => string, directory?: MentionDirectory }> {
  const localPart = (jid: string) => jid.split('@')[0] || jid

  try {
    const evolution = evolutionClientForInstance(instance)
    const needsGroups = chatJids.some(jid => jid.endsWith('@g.us'))

    const [contacts, groups] = await Promise.all([
      contactDirectory(instance, evolution),
      needsGroups ? fetchGroups(instance, evolution) : Promise.resolve(emptyGroups),
    ])

    return {
      directory: contactsToDirectory(contacts),
      // Same precedence as `listChats`: a group's subject is authoritative, a
      // person's saved contact name is what they expect to read.
      chatName: (jid) => {
        const contact = contacts.get(jid)
        return jid.endsWith('@g.us')
          ? groups.get(jid)?.subject ?? contact?.name ?? localPart(jid)
          : contact?.name ?? localPart(jid)
      },
    }
  }
  catch (error) {
    console.error('[messages] could not resolve names:', error)
    return { chatName: localPart }
  }
}

/**
 * Names for everyone a page refers to — senders and mentions together.
 *
 * One chat means one participant lookup, so unlike `search-messages` there is
 * nothing to ration here. It is skipped entirely when the page needs no names at
 * all: a 1:1 chat of your own messages resolves nobody.
 *
 * Best effort by design. Group membership needs a live socket, so a disconnected
 * account resolves nothing — and must still return its messages, with authors
 * falling back to whatever `pushName` was stored.
 */
async function nameDirectory(
  instance: AppInstance,
  remoteJid: string,
  drafts: Array<{ fromMe: boolean, sender: { identity?: string }, mentioned: string[] }>,
): Promise<MentionDirectory | undefined> {
  const needed = drafts.some(draft => draft.mentioned.length || (!draft.fromMe && draft.sender.identity))
  if (!needed) return undefined

  try {
    const evolution = evolutionClientForInstance(instance)
    const contacts = await contactDirectory(instance, evolution)
    return await mentionDirectory({ instance, evolution, chatJids: [remoteJid], contacts })
  }
  catch (error) {
    console.error('[read] could not resolve names:', error)
    return undefined
  }
}

// ── naming ─────────────────────────────────────────────────────────────────

/**
 * `fetchContacts`, memoised per account.
 *
 * The endpoint has no JID-list filter, so naming anything costs the whole contact
 * table — and it was previously paid again on every `listChats` call, i.e. once
 * per page while walking `skip`, plus once more for every mention lookup. Contact
 * names change on a human timescale, so a short TTL removes almost all of that
 * without anyone noticing a stale name.
 *
 * Failures are deliberately **not** cached here: unlike the group and participant
 * lookups this is a plain database read on Evolution's side that answers even
 * while the account is disconnected, so a failure is a real fault worth retrying
 * rather than an expected offline state to back off from.
 */
const CONTACT_CACHE_TTL_MS = 5 * 60_000
const contactCache = new Map<string, { expiresAt: number, contacts: Map<string, ContactInfo> }>()
const contactFetches = new Map<string, Promise<Map<string, ContactInfo>>>()

export async function contactDirectory(
  instance: AppInstance,
  evolution: EvolutionClient,
): Promise<Map<string, ContactInfo>> {
  const cached = contactCache.get(instance.id)
  if (cached && Date.now() < cached.expiresAt) return cached.contacts

  // Concurrent callers share one fetch, as `appDb()` does. A search
  // labels its chats and resolves its mentions at the same time, so a cold cache
  // would otherwise pull the entire contact table twice for one request.
  const inFlight = contactFetches.get(instance.id)
  if (inFlight) return inFlight

  const fetching = fetchContacts(instance, evolution)
    .then((contacts) => {
      if (contacts.size) {
        contactCache.set(instance.id, { expiresAt: Date.now() + CONTACT_CACHE_TTL_MS, contacts })
      }
      return contacts
    })
    .finally(() => contactFetches.delete(instance.id))

  contactFetches.set(instance.id, fetching)
  return fetching
}

/** One row of the contacts table. */
export interface ContactSummary {
  jid: string
  name: string
  /** Bare phone number of a personal contact. Groups and LIDs do not have one. */
  number?: string
  isGroup: boolean
  profilePicUrl?: string
}

export type ContactSortKey = 'name' | 'number'

export interface ContactTableQuery {
  /** Matched against name, JID and number. Case-insensitive, substring. */
  q?: string
  sort?: ContactSortKey
  dir?: 'asc' | 'desc'
  limit?: number
  /** 1-based. */
  page?: number
}

export interface ContactTablePage {
  contacts: ContactSummary[]
  hasMore: boolean
  /** Contacts matching `q`, across the whole table — not on this page. */
  total: number
}

/**
 * One page of the account's contacts: searched, sorted and sliced over the
 * whole table.
 *
 * `findContacts` has no filter for a set of JIDs and no ordering, so it returns
 * everything or nothing — which is why `contactDirectory()` memoises it, and why
 * searching and sorting happen here. No second fetch path: this reads the same
 * cached map every name lookup in the app already reads.
 *
 * Unlike the chats listing, the number on the dashboard card and this table count
 * the same Evolution table, so a shortfall here is not expected and is not
 * explained away.
 */
export async function listContacts(
  instance: AppInstance,
  query: ContactTableQuery = {},
): Promise<ContactTablePage> {
  const { q, sort = 'name', dir = 'asc', limit = 100, page = 1 } = query

  const evolution = evolutionClientForInstance(instance)
  const contacts = await contactDirectory(instance, evolution)

  const rows: ContactSummary[] = [...contacts].map(([jid, info]) => {
    const localPart = jid.split('@')[0] || jid
    return {
      jid,
      name: info.name ?? localPart,
      // Only a real phone-number JID carries a number. A LID is a per-user
      // identity with no country code to read off it, and presenting one as a
      // phone number is the misattribution `mentions.ts` exists to prevent.
      number: jid.endsWith('@s.whatsapp.net') ? localPart : undefined,
      isGroup: jid.endsWith('@g.us'),
      profilePicUrl: info.profilePicUrl,
    }
  })

  const matching = rows.filter(row => matchesSearch(q, row.name, row.jid, row.number))

  const sign = dir === 'asc' ? 1 : -1
  const byName = (a: ContactSummary, b: ContactSummary) => a.name.localeCompare(b.name)
  const sorted = [...matching].sort((a, b) =>
    sort === 'number'
      ? missingLast(a.number, b.number, (x, y) => x.localeCompare(y, undefined, { numeric: true }), sign) || byName(a, b)
      : sign * byName(a, b),
  )

  const skip = (page - 1) * limit

  return {
    contacts: sorted.slice(skip, skip + limit),
    hasMore: skip + limit < sorted.length,
    total: sorted.length,
  }
}

/**
 * Evolution's contact table, keyed by JID.
 *
 * Cheap: a plain database read on Evolution's side, so it answers even while the
 * account is disconnected. Its `pushName` is `contact.name || verifiedName ||
 * <bare number>` — the saved address-book name whenever there is one, which is
 * what a person expects to read.
 *
 * There is no way to filter this to a set of JIDs (the endpoint's `where` takes
 * one `remoteJid`, not a list), so it returns the whole table and we index it.
 */
async function fetchContacts(instance: AppInstance, evolution: EvolutionClient): Promise<Map<string, ContactInfo>> {
  const byJid = new Map<string, ContactInfo>()

  const rows = await evolution<EvolutionContactRow[]>(
    `/chat/findContacts/${encodeURIComponent(instance.name)}`,
    { method: 'POST', body: {} },
  ).catch(() => [] as EvolutionContactRow[])

  if (!Array.isArray(rows)) return byJid

  for (const row of rows) {
    if (typeof row?.remoteJid !== 'string') continue
    byJid.set(row.remoteJid, {
      name: meaningfulName(row.pushName, row.remoteJid.split('@')[0]!),
      profilePicUrl: row.profilePicUrl ?? undefined,
    })
  }

  return byJid
}

/**
 * Group subjects, keyed by group JID.
 *
 * **This one is expensive.** Evolution answers it from Baileys rather than its
 * database, and fetches a profile picture — an uncached round trip to WhatsApp —
 * for every group, sequentially. An account in thirty groups pays thirty round
 * trips. Hence the caller only asks when a group would otherwise show a raw id,
 * and hence the two guards here:
 *
 *   timeout  a picker that renders ids is better than a modal that hangs. The
 *            account may simply be disconnected, in which case this never returns.
 *   cache    `staleWhileFailing` — serve stale on a failed refresh, cache the
 *            failure for a shorter window, never throw. That file explains why
 *            each of those matters; `fetchParticipants` in `mentions.ts` is the
 *            other lookup with the same shape and shares the mechanism.
 */
const GROUP_TIMEOUT_MS = 8_000
const emptyGroups: Map<string, GroupInfo> = new Map()

const groupCache = staleWhileFailing<Map<string, GroupInfo>>({
  ttlMs: 5 * 60_000,
  retryTtlMs: 60_000,
  empty: emptyGroups,
})

async function fetchGroups(instance: AppInstance, evolution: EvolutionClient): Promise<Map<string, GroupInfo>> {
  return groupCache(instance.id, async () => {
    // `getParticipants` is required — Evolution answers 400 without it.
    const rows = await evolution<EvolutionGroupRow[]>(
      `/group/fetchAllGroups/${encodeURIComponent(instance.name)}?getParticipants=false`,
      { timeout: GROUP_TIMEOUT_MS },
    ).catch(() => undefined)

    // `undefined` and not an empty map: an account really can be in no groups,
    // and that answer should be cached for the full window rather than retried.
    if (!Array.isArray(rows)) return undefined

    const byJid = new Map<string, GroupInfo>()
    for (const row of rows) {
      if (typeof row?.id !== 'string') continue
      byJid.set(row.id, {
        subject: row.subject?.trim() || undefined,
        size: typeof row.size === 'number' ? row.size : undefined,
        pictureUrl: row.pictureUrl ?? undefined,
      })
    }

    return byJid
  })
}

// ── internals ──────────────────────────────────────────────────────────────

/**
 * What `POST /chat/findChats` actually returns.
 *
 * `pushName` is **not** the sender's push name, despite the key. Evolution 2.3.7
 * builds this row with a raw query that aliases two different columns as
 * `pushName` — a CASE over the contact and message names, and then `Chat.name` —
 * and the second silently wins when the row is deserialised. `Chat.name` is only
 * written from an inbound 1:1 message, and never for a group, so it is empty for
 * most rows. That upstream bug is why names are enriched above rather than read
 * from here.
 */
interface EvolutionChatRow {
  remoteJid?: string
  pushName?: string
  profilePicUrl?: string
  updatedAt?: string
  unreadCount?: number
  lastMessage?: { message?: unknown, messageTimestamp?: number | string }
}

interface EvolutionContactRow {
  remoteJid?: string
  pushName?: string
  profilePicUrl?: string
}

interface EvolutionGroupRow {
  id?: string
  subject?: string
  size?: number
  pictureUrl?: string
}

interface ContactInfo {
  name?: string
  profilePicUrl?: string
}

interface GroupInfo {
  subject?: string
  size?: number
  pictureUrl?: string
}

/** `ProtocolMessage.Type.MESSAGE_EDIT` — the only subtype carrying readable content. */
const PROTOCOL_MESSAGE_EDIT = 14

/**
 * Transparent `FutureProofMessage` wrappers: `{ message: Message }` and nothing
 * else.
 *
 * Baileys' `normalizeMessageContent` unwraps this shape, but the rc.9 Evolution
 * 2.3.7 pins does not know `associatedChildMessage` (added upstream later, PR
 * #1874) — and `prepareMessage` types a row with `getContentType()` on the
 * *raw*, un-normalized payload regardless, so the wrapper name is what reaches
 * us as `messageType`. Official WhatsApp clients produce these for album media
 * and for a caption edit; Baileys' own album sender does not, which is why they
 * went unnoticed until a caller reported empty rows.
 *
 * `ephemeralMessage` and the `viewOnceMessage*` family are deliberately absent.
 * They are transparent wrappers too, but unwrapping a view-once photo to a bare
 * `[image]` presents it as an ordinary photo, which it is not — doing that
 * honestly needs its own marker, and that is a separate decision.
 */
const WRAPPER_KEYS = ['associatedChildMessage', 'editedMessage', 'documentWithCaptionMessage'] as const

/**
 * Bounded rather than recursive. The payload is always JSON-derived, so a cycle
 * is not reachable and no visited-set is needed; this only caps an absurdly
 * nested one. Falling out of the loop still wrapped leaves the row reading
 * exactly as it did before this existed: wrapper type, no text.
 */
const MAX_UNWRAP_DEPTH = 4

interface NormalizedMessage {
  /** WhatsApp control plane. Drop the row and count it. */
  noise: boolean
  payload?: Record<string, any>
  type?: string
  editOf?: string
  unreadable?: UnreadableReason
}

/**
 * What is actually in a message payload, once the wrappers are off.
 *
 * Three types arrive with nothing readable at the level the extractors look at,
 * and they need three different answers:
 *
 * - `protocolMessage` is the control plane — a deletion, a disappearing-message
 *   timer, a key exchange, a history-sync notification. No body, nothing a
 *   caller can act on, so it is dropped and counted. The exception is
 *   `type: 14` (MESSAGE_EDIT), which nests the whole edited message. That one
 *   must survive: Evolution's live path skips top-level protocol messages
 *   entirely, so these rows come only from history sync, where nothing patches
 *   the original — the edit row is the *only* copy of the new text.
 * - `associatedChildMessage` wraps a real message (see `WRAPPER_KEYS`). Unwrap
 *   it; filtering it would delete album media and captioned video outright.
 * - `secretEncryptedMessage` is an encrypted edit and stays, labelled — see
 *   `UnreadableReason`.
 *
 * Takes the payload *and* the type hint, and trusts the payload: `messageType` is
 * `getContentType()` verbatim and describes the outermost key, so it names the
 * wrapper rather than the content.
 *
 * None of this can move into the query, which is why the drop is local. Filtering
 * on `messageType` would be filtering on the wrapper — and even reading the
 * payload in SQL, excluding `protocolMessage` there would delete every edit along
 * with the bookkeeping, while `associatedChildMessage` has to be kept outright.
 * So `total` counts rows this function then discards, and the count is reported
 * rather than subtracted — see `MessagePage`.
 */
function classifyContent(message: unknown, messageType?: string): NormalizedMessage {
  let payload = asRecord(message)

  // Nothing to read: the type hint is all there is, and the only hint meaning
  // "control record" is this one.
  if (!payload) return { noise: messageType === 'protocolMessage', type: messageType }

  let unwrapped = false
  let editOf: string | undefined

  for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth++) {
    const protocol = asRecord(payload.protocolMessage)
    if (protocol) {
      const edited = protocolSubtype(protocol) === PROTOCOL_MESSAGE_EDIT
        ? asRecord(protocol.editedMessage)
        : undefined
      if (!edited) return { noise: true }
      editOf = idOf(protocol.key) ?? editOf
      payload = edited
      unwrapped = true
      continue
    }

    const wrapped = firstWrapped(payload)
    if (!wrapped) break
    payload = wrapped
    unwrapped = true
  }

  const secret = asRecord(payload.secretEncryptedMessage)

  return {
    noise: false,
    payload,
    // Recomputed only when something was unwrapped. For an ordinary row the
    // stored `messageType` is Evolution's own answer; recomputing it locally
    // would risk disagreeing with it over key ordering, for no gain.
    type: unwrapped ? contentTypeOf(payload) ?? messageType : messageType,
    ...(secret
      ? { editOf: idOf(secret.targetMessageKey) ?? editOf, unreadable: secretEncReason(secret.secretEncType) }
      : { editOf }),
  }
}

function asRecord(value: unknown): Record<string, any> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : undefined
}

function idOf(key: unknown): string | undefined {
  const id = asRecord(key)?.id
  return typeof id === 'string' && id ? id : undefined
}

function firstWrapped(payload: Record<string, any>): Record<string, any> | undefined {
  for (const key of WRAPPER_KEYS) {
    const inner = asRecord(asRecord(payload[key])?.message)
    if (inner) return inner
  }
  return undefined
}

/**
 * Baileys' `getContentType`, for an already-decoded payload: the first own key
 * that is `conversation` or *contains* `Message`, minus the one it excludes.
 * `messageContextInfo` deliberately does not match — no capital `M` — which is
 * why a sibling context never shadows real content.
 */
function contentTypeOf(payload: Record<string, any>): string | undefined {
  return Object.keys(payload).find(key =>
    (key === 'conversation' || key.includes('Message')) && key !== 'senderKeyDistributionMessage')
}

/**
 * `protocolMessage.type`, as a number.
 *
 * An absent value means **REVOKE**, not "keep": proto3 omits a zero on the wire,
 * so a deletion arrives carrying no `type` at all. Reading that as "unknown, so
 * keep it" would surface every deletion as an empty message — the bug this
 * exists to fix, restored.
 *
 * It is an integer because Evolution's `deserializeMessageBuffers` rebuilds
 * every nested object as a plain object and so discards protobufjs' name-
 * emitting `toJSON`. The string branch is defensive: a tag bump that restored it
 * would otherwise silently reclassify every edit as noise.
 */
function protocolSubtype(protocol: Record<string, any>): number {
  const raw = protocol.type
  if (raw === undefined || raw === null) return 0
  if (typeof raw === 'number') return raw
  if (typeof raw === 'string') {
    if (/^\d+$/.test(raw)) return Number(raw)
    return raw === 'MESSAGE_EDIT' ? PROTOCOL_MESSAGE_EDIT : -1
  }
  return -1
}

/**
 * `SecretEncType`: 1 EVENT_EDIT, 2 MESSAGE_EDIT, 0 or absent UNKNOWN. Absent is
 * UNKNOWN and not MESSAGE_EDIT — proto3 omits a zero here too — so an unlabelled
 * one is reported as encrypted content rather than as an edit we cannot show it
 * is.
 */
function secretEncReason(raw: unknown): UnreadableReason {
  const value = typeof raw === 'string'
    ? ({ EVENT_EDIT: 1, MESSAGE_EDIT: 2 } as Record<string, number>)[raw] ?? Number(raw)
    : raw
  return value === 1 || value === 2 ? 'encrypted-edit' : 'encrypted-content'
}

/**
 * The `contextInfo` of an unwrapped payload, for the mention fallback in
 * `listMessages`. Display-only, like everything in `mentions.ts` — no JID is
 * constructed from it.
 */
function nestedContextInfo(payload: Record<string, any> | undefined): unknown {
  if (!payload) return undefined
  const key = contentTypeOf(payload)
  return asRecord(payload.extendedTextMessage)?.contextInfo
    ?? (key ? asRecord(payload[key])?.contextInfo : undefined)
}

/**
 * WhatsApp timestamps are epoch **seconds**, and arrive as a number or a string
 * depending on where in Evolution's response they sit. Returns undefined rather
 * than an "Invalid Date" for anything that does not parse — the callers all treat
 * a missing timestamp as a thing to render as a dash, not as an error.
 */
function isoFromEpochSeconds(value: number | string | undefined | null): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined
  return new Date(seconds * 1000).toISOString()
}

/**
 * WhatsApp message payloads are a union of a few dozen shapes. Pull out the text
 * ones and describe the rest rather than dumping raw protobuf JSON at the model.
 */
function previewOf(message: unknown): string | undefined {
  if (!message || typeof message !== 'object') return undefined
  const m = message as Record<string, any>

  if (typeof m.conversation === 'string') return m.conversation
  if (typeof m.extendedTextMessage?.text === 'string') return m.extendedTextMessage.text
  if (typeof m.imageMessage?.caption === 'string') return `[image] ${m.imageMessage.caption}`
  if (m.imageMessage) return '[image]'
  // Captions on video and on a document were readable by `searchMessages` long
  // before they were readable here, so a message could be found by text this
  // function then rendered as a bare `[video]`. Unwrapping album items made that
  // the common case rather than an oddity.
  if (typeof m.videoMessage?.caption === 'string') return `[video] ${m.videoMessage.caption}`
  if (m.videoMessage) return '[video]'
  if (m.audioMessage) return '[voice message]'
  if (m.documentMessage) return `[document] ${m.documentMessage.fileName ?? m.documentMessage.caption ?? ''}`.trim()
  if (m.stickerMessage) return '[sticker]'
  if (typeof m.reactionMessage?.text === 'string') return `[reaction] ${m.reactionMessage.text}`

  return undefined
}
