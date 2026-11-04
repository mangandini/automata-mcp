import type { Sql } from 'postgres'
import postgres from 'postgres'
import type { AppInstance } from './app-db'
import { mentionedJidsOf } from './mentions'
import { foldForSql, SQL_FOLD_ANY, SQL_FOLD_STAGES } from './search-text'

/**
 * Read-only access to Evolution's own Postgres — every message this app reads.
 *
 * **Why this exists.** Evolution 2.3.7 cannot search message content. Its
 * `POST /chat/findMessages` looks like it can — the request schema in
 * `src/validate/chat.schema.ts` declares `where.message` as an object — but the
 * field is read exactly zero times in `fetchMessages`. Sending a `where.message`
 * returns the whole unfiltered page, which reads as "these are your matches" and
 * is not. The seven filters it does honour are `id`, `source`, `messageType`,
 * `messageTimestamp` (both bounds or none) and `key.{id,remoteJid,fromMe,participant}`.
 * No other endpoint offers body search. So there is no HTTP route to this.
 *
 * **Why it is dangerous.** Every other credential in this app is scoped to one
 * account: an instance's Evolution token reaches that instance and Evolution
 * enforces it. A database connection reaches *every* user's messages in *every*
 * instance. It is the same shape of risk as the admin-key fallback that
 * `credentialsForInstance()` deliberately refuses. Three rules keep it contained,
 * and none of them is optional:
 *
 *   1. The role is read-only. Only SELECT on "Message" is granted (docs/whatsapp.md).
 *      Nothing here writes, and nothing here runs DDL — the schema belongs to
 *      Evolution's Prisma migrations.
 *   2. Every query carries `"instanceId" = <this account>`. `searchMessages`
 *      cannot be called without one; a missing id throws rather than widening.
 *   3. Chat scope is a predicate in the SQL, not a filter applied to rows after
 *      they are read. Out-of-scope messages never enter this process.
 *
 * **This is not optional.** It began as a search-only escape hatch, and now both
 * read paths run through it: Evolution's `findMessages` hands back every stored
 * row, and its history import writes duplicates — one message id can hold two or
 * three rows, disagreeing about who sent it. Collapsing them has to happen before
 * `LIMIT`, which means in SQL. Without `NUXT_EVOLUTION_DATABASE_URL` the MCP
 * surface cannot answer at all.
 *
 * **Why the duplicates exist**, since it decides where the fix belongs: 2.3.7
 * dedupes a history import against an in-memory `Set` of `key.id`, rebuilt from
 * the database at the top of each `messaging-history.set`, and the `createMany`
 * behind it sets `skipDuplicates` — which is inert, because the only unique
 * constraint on `Message` is a `@default(cuid())` primary key that can never
 * collide. So nothing in the schema stops a second write, and two batches in
 * flight together, or an import racing live traffic, both insert. Re-pairing an
 * account (`enableFullHistorySync()`) is what puts them in flight.
 */

/**
 * Whether the *deployment's own* Evolution database is configured.
 *
 * Checked at startup rather than gating a tool: hiding `read-messages` from a
 * client that has already been told the connector reads WhatsApp is a worse
 * answer than an error saying what is missing.
 *
 * It says nothing about a connection that brought its own Evolution server —
 * that one carries its own URL and can read whether or not this is set.
 */
export function messageDatabaseConfigured(): boolean {
  return Boolean(useRuntimeConfig().evolutionDatabaseUrl)
}

/**
 * Whether this connection lives on the Evolution server this deployment
 * configured, as opposed to one the user supplied.
 *
 * The single test, because three things depend on it and the merge that
 * introduced bring-your-own servers already produced one bug from computing it
 * slightly differently in two places. A row carrying its own global key is
 * definitively its own server; so is one pointing somewhere other than our
 * configured URL.
 */
export function onDeploymentServer(instance: Pick<AppInstance, 'admin_key' | 'base_url'>): boolean {
  if (instance.admin_key) return false
  const configUrl = useRuntimeConfig().evolutionUrl
  if (!instance.base_url || !configUrl) return true
  return sameEvolutionServer(instance.base_url, configUrl)
}

/**
 * Which database this account's messages are in, and whether the URL came from
 * a user (and so must be host-guarded and address-pinned).
 *
 * The only place the precedence rule exists. A connection's own
 * `evolution_db_url` wins; otherwise a connection on our server falls back to
 * the deployment's variable; otherwise there is no answer, and the caller
 * refuses rather than querying a database that cannot contain the rows.
 */
export function canReadMessages(instance: AppInstance): boolean {
  return messageDbUrlFor(instance) !== undefined
}

function messageDbUrlFor(instance: AppInstance): { url: string, guard: boolean } | undefined {
  if (instance.evolution_db_url) return { url: instance.evolution_db_url, guard: true }
  if (!onDeploymentServer(instance)) return undefined

  const url = useRuntimeConfig().evolutionDatabaseUrl
  // Ours, on our own network: `net-guard` would (correctly) refuse it as this
  // deployment's own infrastructure, so it is deliberately not guarded.
  return url ? { url, guard: false } : undefined
}

/**
 * The pool for this account's message database.
 *
 * One pool per database URL in play rather than one for the process, because a
 * connection can now bring its own. Everything that makes that safe — the host
 * guard, the address pin, fingerprint invalidation when a URL is rotated, the
 * LRU ceiling — lives in `pg-pool.ts` and is shared with the Postgres
 * connection kind rather than reimplemented here.
 *
 * `statement_timeout` matters more than it looks: Evolution ships
 * `@@index([instanceId])` and nothing else, so reading or searching a large
 * account is a sequential scan. A slow query has to surface as an error the
 * caller can report, not as an MCP call that never returns.
 */
async function evolutionDbFor(instance: AppInstance): Promise<Sql> {
  const resolved = messageDbUrlFor(instance)

  if (!resolved) {
    if (onDeploymentServer(instance)) {
      // 500, not 503: a missing variable will not resolve itself on a retry, and
      // saying "temporarily" about a deployment that can never answer sends the
      // operator looking for an outage. Logged because a handled createError is
      // not, and this one is the whole diagnosis.
      console.error(
        '[evolution-db] NUXT_EVOLUTION_DATABASE_URL is not set — read-messages and '
        + 'search-messages cannot answer for accounts on this deployment\'s Evolution '
        + 'server. See docs/whatsapp.md "Reading and searching messages".',
      )
      throw createError({
        statusCode: 500,
        statusMessage: 'NUXT_EVOLUTION_DATABASE_URL is not set',
      })
    }

    // A user fixes this one, not an operator, so it names the thing to add.
    // 501 rather than an empty page: this account's messages exist, in a
    // database this app has not been given, and reporting "no messages" would
    // be indistinguishable from an empty conversation.
    throw createError({
      statusCode: 501,
      statusMessage: 'Claude cannot read messages for this account yet. Add your Evolution '
        + 'server\'s database connection string to this connection to enable reading and '
        + 'searching. Pairing, listing chats and sending already work without it.',
    })
  }

  return keyedPool(
    resolved.guard ? `evo:${instance.id}` : 'evo:default',
    resolved.url,
    { guard: resolved.guard, max: 3, statementTimeoutMs: STATEMENT_TIMEOUT_MS, readOnly: true },
  )
}

const STATEMENT_TIMEOUT_MS = 10_000

export async function resolveEvolutionInstanceId(instance: AppInstance): Promise<string> {
  if (instance.instance_id) return instance.instance_id

  const evolution = evolutionClientForInstance(instance)

  let rows: Array<{ id?: string, name?: string }> = []
  try {
    rows = await evolution<Array<{ id?: string, name?: string }>>('/instance/fetchInstances')
  }
  catch (error) {
    // A handled createError is never logged by Nitro; without this the operator
    // sees a 503 with nothing behind it.
    console.error('[search] could not reach Evolution to resolve an instance id:', error)
    throw createError({
      statusCode: 503,
      statusMessage: 'Could not reach Evolution to identify this WhatsApp account',
      cause: error,
    })
  }

  // An instance token scopes fetchInstances to its own instance, but match on
  // name anyway rather than trusting position.
  const id = (Array.isArray(rows) ? rows.find(row => row?.name === instance.name) : undefined)?.id
  if (!id) {
    throw createError({
      statusCode: 409,
      statusMessage: 'This WhatsApp account is not fully provisioned',
    })
  }

  // Best effort. Search works this time either way; the backfill just saves the
  // round trip next time.
  try {
    await updateRow('instances', instance.id, { instance_id: id })
  }
  catch (error) {
    console.error('[search] could not backfill instance_id:', error)
  }

  return id
}

/**
 * Who sent the messages to keep, as resolved by `resolveAuthor` in
 * `author-filter.ts` — never as typed by a caller.
 *
 * `identities` are **local parts** (`localPartOf`), not JIDs: the same person is
 * `…@lid` in one copy of a message and `…@s.whatsapp.net` in another, and
 * comparing the part before the `@` is what `authorName` already does for its
 * directory. It also means this module builds and compares no JID form, which the
 * repo forbids doing locally. `pushName` (as typed; folded when the query is built) is the
 * fallback and is read only when `identities` is empty. A filter with neither matches nothing.
 */
export interface AuthorFilter {
  identities: string[]
  pushName?: string
}

export interface MessageSearchOptions {
  /**
   * Words to find in the message text. Already split, not yet escaped. May be
   * empty (a search by author alone): then no text predicate is emitted at all,
   * since `ILIKE ANY ('{}')` would match nothing rather than everything.
   */
  terms: string[]
  /** `all`: every term must appear. `any`: at least one. Defaults to `all`. */
  match?: 'all' | 'any'
  /**
   * Restrict to these chats. An empty list matches nothing, like an empty
   * `allowedJids`: a scope that resolved to no chat must not read as no scope.
   */
  jids?: string[]
  /** The only chats this token may see. Omit for an all-chats token. */
  allowedJids?: string[]
  since?: string
  until?: string
  fromMe?: boolean
  /** Only messages sent by this person; see `AuthorFilter`. Never matches `fromMe` rows. */
  author?: AuthorFilter
  /**
   * Match reaction messages too.
   *
   * Defaults to false, which is what this query has always done — before the
   * `reactionMessage` arm below existed a reaction row produced no `body` at all
   * and `body IS NOT NULL` dropped it. Silently, rather than by decision. The
   * default keeps that outcome and makes it a choice.
   */
  includeReactions?: boolean
  limit: number
  /** 1-based, counting back from the newest. */
  page: number
}

export interface MessageSearchHit {
  jid: string
  id?: string
  fromMe: boolean
  /**
   * Who sent it, unresolved: the sender's JID and the push name stored beside it.
   *
   * Turned into a display name by the caller, for the same reason `mentioned` is
   * — both need the same directory, and the tool is what decides how much of one
   * to pay for. `pushName` is never an answer on its own; see `authorName` in
   * `mentions.ts`.
   */
  sender: { identity?: string, pushName?: string }
  timestamp?: string
  type?: string
  text: string
  /**
   * JIDs this message mentions, for the caller to resolve to names.
   *
   * Left unresolved here on purpose: a hit set spans arbitrarily many chats, and
   * naming a group's members is a live round trip per group. The tool decides how
   * much of that to pay — see `search-messages.ts`.
   */
  mentioned: string[]
  /**
   * The `id` of the message this hit edits, when it is an edit.
   *
   * WhatsApp delivers an edit as its own record and never rewrites the original,
   * so the message it replaces may be a separate hit in the same result set,
   * still carrying its old text. Prefer this one when the two disagree.
   */
  editOf?: string
}

export async function searchMessages(
  instance: AppInstance,
  options: MessageSearchOptions,
): Promise<{ hits: MessageSearchHit[], hasMore: boolean, total?: number }> {
  // Database first, deliberately. `resolveEvolutionInstanceId` may call the
  // account's Evolution API, and its 409/503 would otherwise mask the clearer
  // "add your database connection string" refusal for a connection that can
  // never read — and would pay for a round trip to learn nothing.
  const sql = await evolutionDbFor(instance)
  const instanceId = await resolveEvolutionInstanceId(instance)

  const patterns = options.terms.length
    ? options.terms.map(term => `%${escapeLike(foldForSql(term))}%`)
    : undefined
  const since = toUnixSeconds(options.since, 'since')
  const until = toUnixSeconds(options.until, 'until')

  // One extra row tells us there were more matches than we returned, for a
  // fraction of the cost of a second COUNT(*) over the same scan. `hasMore` comes
  // from it and never from `total`, so a wrong count cannot page a caller forever.
  const take = options.limit + 1
  const skip = (options.page - 1) * options.limit

  let rows: MessageRow[]
  try {
    // `DISTINCT ON (key->>'id')` is what stops one message being reported as two
    // or three matches; `bestNamed` decides which of the duplicate rows survives.
    // It has to run before `LIMIT`, so the dedupe is a CTE and the ordering the
    // caller sees is applied outside it.
    //
    // The `reactionMessage` arm in the COALESCE is what makes an emoji findable
    // at all; the predicate near the bottom is what keeps reactions out by
    // default. That predicate reads the payload rather than `messageType`,
    // because `messageType` is Baileys' `getContentType()` verbatim — the *first*
    // key of the payload that is `conversation` or ends in `Message` — so a
    // reaction arriving alongside a `messageContextInfo` is stored under that
    // type instead, with `message.reactionMessage` sitting right there. The
    // payload is the authority. It costs nothing next to the scan already
    // happening — `@@index([instanceId])` is the only index on
    // `Message`. None of it touches scope: `instanceId`, `jids` and `allowedJids`
    // still bound the query, so an included reaction is only ever one from a
    // chat this token already reaches.
    rows = await sql<MessageRow[]>`
      WITH matched AS (
        SELECT DISTINCT ON (m.key->>'id')
               m.key, m."pushName", m."messageType", m."messageTimestamp", t.body, t.filename,
               m."contextInfo"->'mentionedJid' AS mentioned,
               -- Which message this one edits, when it is an edit. Not decoration:
               -- without it a search can return both the stale original and its
               -- edit, with different text and no way to tell which is current.
               -- The alias quoting is load-bearing — unquoted, postgres.js folds it
               -- to editof and the field is silently always undefined.
               COALESCE(
                 m.message->'protocolMessage'->'key'->>'id',
                 m.message->'associatedChildMessage'->'message'->'protocolMessage'->'key'->>'id'
               ) AS "editOf",
               ${bestNamed(sql)} AS named, m.id AS "rowId"
        FROM "Message" m
        ${messageBodyJoin(sql)}
        WHERE m."instanceId" = ${instanceId}
          AND (t.body IS NOT NULL OR t.filename IS NOT NULL)
          ${patterns === undefined
            ? sql``
            : options.match === 'any'
              ? sql`AND ${searchableText(sql)} ILIKE ANY (${patterns}::text[])`
              : sql`AND ${searchableText(sql)} ILIKE ALL (${patterns}::text[])`}
          ${options.jids ? sql`AND m.key->>'remoteJid' = ANY(${options.jids}::text[])` : sql``}
          ${options.allowedJids ? sql`AND m.key->>'remoteJid' = ANY(${options.allowedJids}::text[])` : sql``}
          ${since === undefined ? sql`` : sql`AND m."messageTimestamp" >= ${since}`}
          ${until === undefined ? sql`` : sql`AND m."messageTimestamp" <= ${until}`}
          ${options.fromMe === undefined ? sql`` : sql`AND (m.key->>'fromMe')::boolean = ${options.fromMe}`}
          ${authorPredicate(sql, options.author)}
          ${options.includeReactions ? sql`` : sql`AND r."reactionMessage" IS NULL`}
          -- Control records are excluded by intent, not only by accident. Today
          -- this is a no-op: no arm above reads anything out of a non-edit
          -- protocolMessage, so such a row has no body and no filename, and the
          -- (body OR filename) IS NOT NULL predicate above already dropped it.
          -- It is here so a future arm cannot quietly start surfacing
          -- bookkeeping. It cannot drop an unwrapped edit: any row whose body
          -- came from the edit arms has editedMessage non-null. Never let this
          -- grow into something that inspects where the body came from; that is
          -- where it would start dropping real edits.
          AND (r."protocolMessage" IS NULL
               OR r."protocolMessage"->'editedMessage' IS NOT NULL)
        ORDER BY m.key->>'id', named DESC, m."messageTimestamp" DESC, "rowId"
      )
      SELECT key, "pushName", "messageType", "messageTimestamp", body, filename, mentioned, "editOf",
             COUNT(*) OVER () AS total
      FROM matched
      ORDER BY "messageTimestamp" DESC, key->>'id' DESC
      LIMIT ${take} OFFSET ${skip}
    `
  }
  catch (error) {
    console.error('[search] Evolution database query failed:', error)
    throw createError({
      statusCode: 503,
      statusMessage: 'Message search is temporarily unavailable',
      cause: error,
    })
  }

  // Counts the deduplicated set, so it is distinct matching messages — not rows.
  // It rides on the returned rows: a page past the end carries no count rather
  // than a zero, because "not measured" and "none" are different answers.
  const total = Number(rows[0]?.total)

  return {
    hits: rows.slice(0, options.limit).map(row => ({
      jid: row.key?.remoteJid ?? '',
      id: row.key?.id,
      fromMe: Boolean(row.key?.fromMe),
      sender: senderOf(row),
      timestamp: row.messageTimestamp
        ? new Date(Number(row.messageTimestamp) * 1000).toISOString()
        : undefined,
      type: row.messageType ?? undefined,
      // A document sent without a caption has no body; its file name is what
      // matched, so it is also what the hit shows. `||`, not `??`: a client may
      // send the caption as an empty string, which is a body that is not null
      // and shows nothing — the file name has to win over it too.
      text: row.body || row.filename || '',
      mentioned: mentionedJidsOf(row.mentioned),
      ...(row.editOf && { editOf: row.editOf }),
    })),
    hasMore: rows.length > options.limit,
    total: Number.isFinite(total) ? total : undefined,
  }
}

/**
 * The other `remoteJid` forms the stored history relates to one 1:1 chat.
 *
 * Almost half of the 1:1 chats are stored under a `@lid` JID, not the phone
 * `@s.whatsapp.net` one, and resolving a number only ever yields the phone form.
 * The one link the data carries is `key.remoteJidAlt`, so this follows it in
 * both directions: chats whose messages name `jid` as their alternate form, and
 * the alternate forms named by messages stored under `jid`.
 *
 * Only 1:1 forms (`@s.whatsapp.net`, `@lid`) are returned, filtered in the SQL so
 * `LIMIT` counts valid forms: a group, broadcast or newsletter value must never
 * become a "form" of someone's chat.
 *
 * It can return nothing even when the chat exists under another form:
 * `remoteJidAlt` is written only by live traffic, never by history sync (see
 * `MessageKey`). Callers must say so rather than treat an empty answer as "there
 * is only one form".
 *
 * Scope. `allowed` is the token's chat allowlist (`undefined` = every chat). It
 * is a predicate here, not a filter on what comes back: otherwise whether a form
 * survives would depend on rows of chats the token does not reach, and a scoped
 * token could use that to test whether a number belongs to an in-scope `@lid`
 * chat, or to learn that an out-of-scope phone chat exists. The first arm
 * (`remoteJidAlt = jid`) only returns in-scope `remoteJid`s. The second arm reads
 * the rows stored under `jid` itself, so it runs only when `jid` is in scope.
 * What remains is the first arm reading in-scope rows' `remoteJidAlt`: a scoped
 * `@lid` chat can be reached by the phone number it is linked to. That is the
 * convenience this exists for and it exposes nothing outside the allowlist.
 *
 * Cost: `"instanceId"` is the only index on `"Message"`, so this scans the
 * account's rows. That is why it is meant to run once per number-addressed call,
 * never per page, and why it selects DISTINCT values with a `LIMIT` — a 1:1 chat
 * has a handful of forms, and an unbounded result would only ever be a bug.
 * Ordered, so the cap cuts the same forms on every call.
 */
export async function relatedChatJids(
  instance: AppInstance,
  jid: string,
  allowed?: string[],
): Promise<string[]> {
  const sql = await evolutionDbFor(instance)
  const instanceId = await resolveEvolutionInstanceId(instance)

  // Arm 2 reads rows stored under `jid`: only for a chat the token reaches.
  const readsOwnRows = allowed === undefined || allowed.includes(jid)

  let rows: Array<{ jid: string | null }>
  try {
    rows = await sql<Array<{ jid: string | null }>>`
      SELECT forms.jid
      FROM (
        SELECT DISTINCT m.key->>'remoteJid' AS jid
        FROM "Message" m
        WHERE m."instanceId" = ${instanceId}
          AND m.key->>'remoteJidAlt' = ${jid}
          AND (m.key->>'remoteJid' LIKE '%@s.whatsapp.net' OR m.key->>'remoteJid' LIKE '%@lid')
          ${allowed === undefined ? sql`` : sql`AND m.key->>'remoteJid' = ANY(${allowed}::text[])`}
        ${readsOwnRows
          ? sql`
        UNION
        SELECT DISTINCT m.key->>'remoteJidAlt' AS jid
        FROM "Message" m
        WHERE m."instanceId" = ${instanceId}
          AND m.key->>'remoteJid' = ${jid}
          AND (m.key->>'remoteJidAlt' LIKE '%@s.whatsapp.net' OR m.key->>'remoteJidAlt' LIKE '%@lid')`
          : sql``}
      ) forms
      ORDER BY forms.jid
      LIMIT 20
    `
  }
  catch (error) {
    console.error('[chat-target] Evolution database query failed:', error)
    throw createError({
      statusCode: 503,
      statusMessage: 'Chat lookup is temporarily unavailable',
      cause: error,
    })
  }

  return [...new Set(rows.map(row => row.jid).filter((value): value is string => Boolean(value) && value !== jid))]
}

export interface MessagePageOptions {
  /**
   * The one chat to read. A predicate in the SQL, never a filter over rows read.
   *
   * Absent means the whole account, which exists for the **session** surface —
   * the dashboard's message table — and is unreachable from MCP: every tool goes
   * through `listMessages()` in `chats.ts`, which takes `remoteJid` as a required
   * positional argument, so no tool can widen to every chat by omitting a field.
   * `instanceId` below is unconditional either way.
   */
  jid?: string
  /**
   * Several chats at once — the same `remoteJid = ANY(...)` predicate as
   * `searchMessages`. If both `jid` and `jids` are given, `jids` wins and `jid` is
   * ignored. An empty array matches nothing (`= ANY('{}')`), so a caller whose
   * scope resolved to no chats reads zero rows rather than the whole account.
   */
  jids?: string[]
  limit: number
  /** 1-based, counting back from the newest. */
  page: number
  since?: string
  until?: string
  includeReactions?: boolean
  /** Only messages sent by this person; see `AuthorFilter`. Never matches `fromMe` rows. */
  author?: AuthorFilter
  /**
   * Every term must appear in the message body. Already split, not yet escaped —
   * matched against the same `messageBodyJoin` expression `searchMessages` uses,
   * so a listing and a search agree on what the text of a message is.
   */
  terms?: string[]
  /** Which end of the range the first page comes from. Defaults to newest first. */
  order?: 'newest' | 'oldest'
}

/**
 * One stored message, still in Evolution's shape.
 *
 * Deliberately not `ChatMessage`: rendering a payload and naming a sender both
 * belong to `chats.ts`, which owns `previewOf` and the name directory. This module
 * reads rows and nothing else.
 */
export interface MessageRecord {
  key: MessageKey | null
  pushName: string | null
  messageType: string | null
  /** Unix seconds — the column is an `Int`, and never null. */
  messageTimestamp: number | null
  message: unknown
  mentioned: string[] | null
}

/**
 * One page of a chat's history, deduplicated, newest first.
 *
 * This replaced `POST /chat/findMessages`, which cannot do the one thing that
 * matters here. Evolution's `Message` table holds two or three rows for a single
 * message across a re-pair, and its endpoint pages with `skip`/`take` over those
 * rows — so a caller asking for 50 messages got 50 *rows*, perhaps 20 distinct
 * ones, and a `total` that counted every copy. Collapsing after the fact cannot
 * fix either: the page boundaries were already drawn in the wrong place. Hence
 * `DISTINCT ON` inside a CTE, with `LIMIT`/`OFFSET` applied to what comes out.
 *
 * Two details in the ordering carry weight. `bestNamed` makes the surviving row of
 * a duplicate set deterministic — otherwise a message's author changes between
 * identical calls. And the outer sort breaks ties on the message id, which
 * Evolution's own `orderBy: { messageTimestamp: 'desc' }` does not: without a
 * tiebreaker, rows sharing a timestamp can appear on two pages or on neither.
 */
export async function listMessagesPage(
  instance: AppInstance,
  options: MessagePageOptions,
): Promise<{ records: MessageRecord[], hasMore: boolean, total?: number }> {
  // Database first, deliberately. `resolveEvolutionInstanceId` may call the
  // account's Evolution API, and its 409/503 would otherwise mask the clearer
  // "add your database connection string" refusal for a connection that can
  // never read — and would pay for a round trip to learn nothing.
  const sql = await evolutionDbFor(instance)
  const instanceId = await resolveEvolutionInstanceId(instance)

  const since = toUnixSeconds(options.since, 'since')
  const until = toUnixSeconds(options.until, 'until')

  // Same over-fetch trick as `searchMessages`, and `hasMore` still comes from it
  // rather than from `total`, even though `total` is now exact. A count that went
  // wrong upstream must never be able to drive a caller into paging forever.
  const take = options.limit + 1
  const skip = (options.page - 1) * options.limit

  // Joined only when there is something to match, so an ordinary read pays
  // nothing for it. The body expression is shared with `searchMessages`.
  const terms = options.terms?.length ? options.terms : undefined
  const patterns = terms?.map(term => `%${escapeLike(foldForSql(term))}%`)

  // The tiebreaker travels with the direction. Evolution's own ordering has
  // none, and rows sharing a timestamp then land on two pages or on neither —
  // reversing one half of the pair would reintroduce exactly that.
  const ordering = options.order === 'oldest'
    ? sql`"messageTimestamp" ASC, key->>'id' ASC`
    : sql`"messageTimestamp" DESC, key->>'id' DESC`

  let rows: MessagePageRow[]
  try {
    rows = await sql<MessagePageRow[]>`
      WITH deduped AS (
        SELECT DISTINCT ON (m.key->>'id')
               m.key, m."pushName", m."messageType", m."messageTimestamp", m.message,
               m."contextInfo"->'mentionedJid' AS mentioned,
               ${bestNamed(sql)} AS named, m.id AS "rowId"
        FROM "Message" m
        ${patterns ? messageBodyJoin(sql) : sql``}
        WHERE m."instanceId" = ${instanceId}
          ${options.jids !== undefined
            ? sql`AND m.key->>'remoteJid' = ANY(${options.jids}::text[])`
            : options.jid === undefined ? sql`` : sql`AND m.key->>'remoteJid' = ${options.jid}`}
          ${patterns === undefined ? sql`` : sql`AND (t.body IS NOT NULL OR t.filename IS NOT NULL) AND ${searchableText(sql)} ILIKE ALL (${patterns}::text[])`}
          ${since === undefined ? sql`` : sql`AND m."messageTimestamp" >= ${since}`}
          ${until === undefined ? sql`` : sql`AND m."messageTimestamp" <= ${until}`}
          ${authorPredicate(sql, options.author)}
          ${options.includeReactions ? sql`` : sql`AND m.message->'reactionMessage' IS NULL`}
        ORDER BY m.key->>'id', named DESC, m."messageTimestamp" DESC, "rowId"
      )
      SELECT key, "pushName", "messageType", "messageTimestamp", message, mentioned,
             COUNT(*) OVER () AS total
      FROM deduped
      ORDER BY ${ordering}
      LIMIT ${take} OFFSET ${skip}
    `
  }
  catch (error) {
    // A handled createError is never logged by Nitro, so a 503 would otherwise
    // reach the operator as a response with nothing at all behind it.
    console.error('[read] Evolution database query failed:', error)
    throw createError({
      statusCode: 503,
      statusMessage: 'Reading messages is temporarily unavailable',
      cause: error,
    })
  }

  // The window function counts the deduped set, so this is the number of distinct
  // messages in the range — not of rows, and not of the chat. It rides on the
  // returned rows, so a page past the end carries no count rather than a zero:
  // "I did not measure" and "there are none" are different answers.
  const total = Number(rows[0]?.total)

  return {
    records: rows.slice(0, options.limit).map(({ total: _total, ...record }) => record),
    hasMore: rows.length > options.limit,
    total: Number.isFinite(total) ? total : undefined,
  }
}

/**
 * The messages around one message, in one chat, in chronological order.
 *
 * The anchor is looked up by `key->>'id'` **inside the given `remoteJid`**: the
 * caller's scope was checked against that chat, and a message id alone could be a
 * message in a chat the token never reached. Not found there is not found.
 *
 * Neighbours are taken on the pair `("messageTimestamp", key->>'id')`, the same
 * ordering `listMessagesPage` uses, compared as a row: "before" is strictly less
 * than the anchor's pair, "after" strictly greater. Timestamps are whole seconds,
 * so several messages share one — comparing the timestamp alone would drop or
 * repeat the ones tied with the anchor. Each window reads the deduplicated set
 * (`DISTINCT ON` in the CTE, same `bestNamed`), so a duplicate copy never uses up
 * a slot, and over-fetches one row to answer `hasMore*` without a count.
 */
export async function listMessageRecordsAround(
  instance: AppInstance,
  params: { jid: string, id: string, before: number, after: number, includeReactions?: boolean },
): Promise<{ found: boolean, records: MessageRecord[], hasMoreBefore: boolean, hasMoreAfter: boolean }> {
  const sql = await evolutionDbFor(instance)
  const instanceId = await resolveEvolutionInstanceId(instance)

  // `LIMIT 0 + 1` still answers "is there anything on that side".
  const beforeTake = params.before + 1
  const afterTake = params.after + 1
  // Applied to the neighbours only, never to the anchor: the caller named that
  // message, and a reaction they were pointed at should not turn into "not found".
  const noReactions = params.includeReactions ? sql`` : sql`AND d.message->'reactionMessage' IS NULL`

  let rows: AroundRow[]
  try {
    rows = await sql<AroundRow[]>`
      WITH deduped AS (
        SELECT DISTINCT ON (m.key->>'id')
               m.key, m."pushName", m."messageType", m."messageTimestamp", m.message,
               m."contextInfo"->'mentionedJid' AS mentioned,
               ${bestNamed(sql)} AS named, m.id AS "rowId"
        FROM "Message" m
        WHERE m."instanceId" = ${instanceId}
          AND m.key->>'remoteJid' = ${params.jid}
        ORDER BY m.key->>'id', named DESC, m."messageTimestamp" DESC, "rowId"
      ),
      anchor AS (
        SELECT * FROM deduped WHERE key->>'id' = ${params.id}
      ),
      older AS (
        SELECT d.* FROM deduped d, anchor a
        WHERE (d."messageTimestamp", d.key->>'id') < (a."messageTimestamp", a.key->>'id')
          ${noReactions}
        ORDER BY d."messageTimestamp" DESC, d.key->>'id' DESC
        LIMIT ${beforeTake}
      ),
      newer AS (
        SELECT d.* FROM deduped d, anchor a
        WHERE (d."messageTimestamp", d.key->>'id') > (a."messageTimestamp", a.key->>'id')
          ${noReactions}
        ORDER BY d."messageTimestamp" ASC, d.key->>'id' ASC
        LIMIT ${afterTake}
      )
      SELECT 'older' AS side, ROW_NUMBER() OVER (ORDER BY "messageTimestamp" DESC, key->>'id' DESC) AS rank,
             key, "pushName", "messageType", "messageTimestamp", message, mentioned FROM older
      UNION ALL
      SELECT 'anchor', 0, key, "pushName", "messageType", "messageTimestamp", message, mentioned FROM anchor
      UNION ALL
      SELECT 'newer', ROW_NUMBER() OVER (ORDER BY "messageTimestamp" ASC, key->>'id' ASC),
             key, "pushName", "messageType", "messageTimestamp", message, mentioned FROM newer
    `
  }
  catch (error) {
    console.error('[read] Evolution database query failed:', error)
    throw createError({
      statusCode: 503,
      statusMessage: 'Reading messages is temporarily unavailable',
      cause: error,
    })
  }

  const strip = ({ side: _side, rank: _rank, ...record }: AroundRow): MessageRecord => record
  const anchorRow = rows.find(row => row.side === 'anchor')
  if (!anchorRow) return { found: false, records: [], hasMoreBefore: false, hasMoreAfter: false }

  // `rank` is the SQL's own order within each window (nearest the anchor first),
  // so the tie-break between rows sharing a timestamp is Postgres's, not a second
  // comparison in JS that could disagree under the database's collation.
  const byRank = (a: AroundRow, b: AroundRow) => Number(a.rank) - Number(b.rank)
  const older = rows.filter(row => row.side === 'older').sort(byRank)
  const newer = rows.filter(row => row.side === 'newer').sort(byRank)

  return {
    found: true,
    records: [
      ...older.slice(0, params.before).reverse().map(strip),
      strip(anchorRow),
      ...newer.slice(0, params.after).map(strip),
    ],
    hasMoreBefore: older.length > params.before,
    hasMoreAfter: newer.length > params.after,
  }
}

interface AroundRow extends MessageRecord { side: 'older' | 'anchor' | 'newer', rank: number | string }

/**
 * The readable text of a message, as a `CROSS JOIN LATERAL ... AS t` yielding
 * `t.body` — null for a row that carries nothing renderable — and `t.filename`,
 * the file name of a document message (null otherwise).
 *
 * One authority for what counts as a body, shared by `searchMessages` (which
 * matches on it) and `listMessagesPage` (which joins it only when there are
 * terms to match). Two copies of this COALESCE would drift, and a search that
 * reads one definition while a listing reads another is a set of results that
 * cannot be paged.
 *
 * Two things here are about cost, not meaning. Both come from one fact: a
 * `message` that carries media is large (thumbnails, media keys, link previews)
 * and so TOASTed, and Postgres detoasts — fetches and
 * decompresses — it again for **every** `->` / `->>` / `?|` that reads it. The
 * ~30 arms of a body that has no caption therefore decompressed the same
 * payload ~30 times, per message, over the whole account. So:
 *
 *  1. `r` reads the payload once. `jsonb_to_record` pulls the ten top-level
 *     keys every arm starts from into in-memory `jsonb` values; every later
 *     lookup (the arms, and the reaction / control-record predicates in
 *     `searchMessages`, which read `r` too) works on those copies and never
 *     touches the TOASTed column again. A function scan, not `OFFSET 0`, so the
 *     stage can still run inside a parallel worker. The `CASE` is not
 *     decoration: `jsonb_to_record` raises on a payload that is not an object
 *     (where `->` returns NULL), and one stray row must not fail the account's
 *     whole search. A JSON `null` under one of the ten keys reads as SQL NULL
 *     here and as the non-NULL `'null'` through `->`: for the arms that changes
 *     nothing (they return NULL either way), and the reaction / control-record
 *     predicates of `searchMessages` therefore treat such a key as absent (Evolution
 *     never writes one; `listMessagesPage` keeps the plain `->` test).
 *  2. `t` is a plain subquery that Postgres pastes into each place it is read.
 *     That is fine now — the arms run on small in-memory values — and cheaper
 *     than a second function scan per row, which an earlier version used to keep
 *     the arms from being re-evaluated (needed only while each evaluation
 *     re-decompressed the payload).
 *
 * The cheap predicates on `m` still run first, so only rows that survived them
 * pay. The file name is looked up only for messages that have one of the four
 * top-level keys every file-name arm starts from; for the rest it would be ten
 * lookups that can only return NULL. The gate is a superset test, so it can be
 * wrong only by running the arms for nothing, never by skipping one.
 */
function messageBodyJoin(sql: Sql) {
  return sql`
    CROSS JOIN LATERAL jsonb_to_record(
      CASE WHEN jsonb_typeof(m.message) = 'object' THEN m.message ELSE '{}'::jsonb END
    ) AS r("conversation" jsonb, "extendedTextMessage" jsonb, "imageMessage" jsonb, "videoMessage" jsonb, "documentMessage" jsonb, "documentWithCaptionMessage" jsonb, "speechToText" jsonb, "reactionMessage" jsonb, "associatedChildMessage" jsonb, "protocolMessage" jsonb)
    CROSS JOIN LATERAL (SELECT COALESCE(
        (r."conversation" #>> '{}'),
        r."extendedTextMessage"->>'text',
        r."imageMessage"->>'caption',
        r."videoMessage"->>'caption',
        r."documentMessage"->>'caption',
        r."documentWithCaptionMessage"->'message'->'documentMessage'->>'caption',
        (r."speechToText" #>> '{}'),
        r."reactionMessage"->>'text',
        -- Album media and captioned video from an official WhatsApp client
        -- arrive wrapped: associatedChildMessage is a FutureProofMessage,
        -- a transparent { message: Message }, which the rc.9 Baileys that
        -- 2.3.7 pins does not unwrap. Explicit paths only — a $.** recursive
        -- jsonb path would also match contextInfo.quotedMessage.conversation
        -- and make a reply findable by the text it quoted, which is
        -- misattribution by construction.
        r."associatedChildMessage"->'message'->>'conversation',
        r."associatedChildMessage"->'message'->'extendedTextMessage'->>'text',
        r."associatedChildMessage"->'message'->'imageMessage'->>'caption',
        r."associatedChildMessage"->'message'->'videoMessage'->>'caption',
        r."associatedChildMessage"->'message'->'documentMessage'->>'caption',
        -- A plaintext edit (protocolMessage.type = 14). In history-synced
        -- data this row is the ONLY copy of the edited text — nothing patches
        -- the original — so without these arms the new wording is unfindable.
        r."protocolMessage"->'editedMessage'->>'conversation',
        r."protocolMessage"->'editedMessage'->'extendedTextMessage'->>'text',
        r."protocolMessage"->'editedMessage'->'imageMessage'->>'caption',
        r."protocolMessage"->'editedMessage'->'videoMessage'->>'caption',
        r."protocolMessage"->'editedMessage'->'documentMessage'->>'caption',
        -- Both at once: a caption edit on an album item.
        r."associatedChildMessage"->'message'->'protocolMessage'->'editedMessage'->>'conversation',
        r."associatedChildMessage"->'message'->'protocolMessage'->'editedMessage'->'extendedTextMessage'->>'text',
        r."associatedChildMessage"->'message'->'protocolMessage'->'editedMessage'->'imageMessage'->>'caption',
        r."associatedChildMessage"->'message'->'protocolMessage'->'editedMessage'->'videoMessage'->>'caption',
        r."associatedChildMessage"->'message'->'protocolMessage'->'editedMessage'->'documentMessage'->>'caption'
        -- speechToText and reactionMessage are not repeated in the nested
        -- groups: Evolution writes the first at top level only, and a reaction
        -- is never an album child or an edit target. COALESCE short-circuits,
        -- so an ordinary text row still stops at the first arm — the extra
        -- lookups are paid only by rows that produce no body at all, which
        -- this scan already touches and discards.
      ) AS body,
      -- The file name of a document, so "contrato.pdf" is findable although the
      -- document has no caption. fileName first, title as the fallback some
      -- clients fill instead. Explicit paths only, for the reason above; the
      -- same wrappers as the body arms.
      CASE WHEN (r."documentMessage" IS NOT NULL OR r."documentWithCaptionMessage" IS NOT NULL OR r."associatedChildMessage" IS NOT NULL OR r."protocolMessage" IS NOT NULL) THEN COALESCE(
        r."documentMessage"->>'fileName',
        r."documentMessage"->>'title',
        r."documentWithCaptionMessage"->'message'->'documentMessage'->>'fileName',
        r."documentWithCaptionMessage"->'message'->'documentMessage'->>'title',
        r."associatedChildMessage"->'message'->'documentMessage'->>'fileName',
        r."associatedChildMessage"->'message'->'documentMessage'->>'title',
        r."protocolMessage"->'editedMessage'->'documentMessage'->>'fileName',
        r."protocolMessage"->'editedMessage'->'documentMessage'->>'title',
        r."associatedChildMessage"->'message'->'protocolMessage'->'editedMessage'->'documentMessage'->>'fileName',
        r."associatedChildMessage"->'message'->'protocolMessage'->'editedMessage'->'documentMessage'->>'title'
      ) END AS filename) AS t`
}

/**
 * The author predicate, as a `WHERE` fragment (`AND …`) that sits before the
 * dedupe so it bounds the scan like every other filter.
 *
 * Copies of one message disagree on `pushName` but carry the same `key`, so the
 * identity arm is stable across them: the predicate neither duplicates a message
 * nor loses it. That is why identity is the primary arm and `pushName` only a
 * fallback — matching a name alone would merge two people who share one.
 *
 * `fromMe = false` is required by both arms: a message you sent has no author
 * (`authorName`), so it can never be "what X said". The `::boolean` cast of a
 * missing `fromMe` is NULL, which excludes the row — fail closed.
 *
 * An empty filter yields `AND false`, never nothing: a resolver bug must not turn
 * "messages from this person" into "every message". Every value is a bind
 * parameter; the needle is folded and LIKE-escaped before it is bound.
 */
function authorPredicate(sql: Sql, author: AuthorFilter | undefined) {
  if (!author) return sql``

  const identities = [...new Set(author.identities.filter(identity => identity.length > 0))]
  if (identities.length) {
    return sql`AND (m.key->>'fromMe')::boolean = false
          AND (split_part(m.key->>'participant', '@', 1) = ANY(${identities}::text[])
               OR split_part(m.key->>'participantAlt', '@', 1) = ANY(${identities}::text[]))`
  }

  const name = author.pushName ? foldForSql(author.pushName).trim() : ''
  if (name) {
    return sql`AND (m.key->>'fromMe')::boolean = false
          AND ${fold(sql, sql`m."pushName"`)} ILIKE ${`%${escapeLike(name)}%`}`
  }

  return sql`AND false`
}

/**
 * The distinct (identity, `pushName`) pairs that posted under a name containing
 * `name` (as typed; folded here the way the SQL folds `pushName`) in one chat, for `resolveAuthor` to tell one person from two when
 * the participant list could not.
 *
 * Group members are mostly not saved contacts, so what they publish as their own
 * name is often the only name there is. `identity` is the local part of
 * `participant` and of `participantAlt` — one message can yield two pairs — and the
 * caller groups by folded name, so one person seen as both a LID and a phone number
 * is one candidate, not two. Scoped to the one chat by `jid` (an argument the caller
 * has already authorised), `fromMe = false`, capped at 20: enough to see that a
 * name is ambiguous, not a roster. The order is fixed so the cap cuts the same
 * rows on every call.
 */
export async function distinctSenders(
  instance: AppInstance,
  params: { jid: string, name: string },
): Promise<Array<{ identity: string, pushName: string }>> {
  const sql = await evolutionDbFor(instance)
  const instanceId = await resolveEvolutionInstanceId(instance)

  const needle = foldForSql(params.name).trim()
  if (!needle) return []

  try {
    const rows = await sql<Array<{ identity: string, pushName: string }>>`
      SELECT DISTINCT i.identity AS identity, m."pushName" AS "pushName"
      FROM "Message" m
      CROSS JOIN LATERAL (VALUES
        (split_part(m.key->>'participant', '@', 1)),
        (split_part(m.key->>'participantAlt', '@', 1))
      ) AS i(identity)
      WHERE m."instanceId" = ${instanceId}
        AND m.key->>'remoteJid' = ${params.jid}
        AND (m.key->>'fromMe')::boolean = false
        AND i.identity <> ''
        AND ${fold(sql, sql`m."pushName"`)} ILIKE ${`%${escapeLike(needle)}%`}
      ORDER BY m."pushName", i.identity
      LIMIT 20
    `
    return rows.map(row => ({ identity: row.identity, pushName: row.pushName }))
  }
  catch (error) {
    console.error('[search] Evolution database sender lookup failed:', error)
    throw createError({
      statusCode: 503,
      statusMessage: 'Reading messages is temporarily unavailable',
      cause: error,
    })
  }
}

/**
 * Accent-folds `expr` in SQL with the table `foldForSql` applies to needles in JS,
 * passed as bind parameters. It does not lowercase: ASCII capitals are not in
 * the table, so the comparison stays `ILIKE` against needles already folded in
 * JS with `foldForSql`. Module-level so other columns (a sender's `pushName`)
 * fold identically.
 *
 * The result is the same as `translate(expr, FROM, TO)` over the whole table,
 * but not computed that way. That `translate` compares every character of the
 * text against ~440 table entries — about 100 µs per message, and the fold ran
 * over every message of the account before anything else could drop it. A regex
 * class test is nearly free per character, so: a text with nothing the table
 * maps (most of them) is returned as it is; one that does gets only the stages
 * of the table it needs (`SQL_FOLD_STAGES`, cheapest first). Same function —
 * a text with no character of a stage is unchanged by that stage's `translate`.
 *
 * `expr` appears several times in the SQL this builds. Pass a column, or an
 * expression that is cheap to repeat (see `messageBodyJoin`: `t` reads in-memory values).
 */
function fold(sql: Sql, expr: ReturnType<Sql>) {
  const upTo = (last: number) => SQL_FOLD_STAGES
    .slice(0, last + 1)
    .reduce(
      (text, stage) => sql`translate(${text}, ${stage.from}, ${stage.to})`,
      expr,
    )

  // WHEN expr holds none of the characters stages k+1.. handle THEN stages 0..k.
  const branches = SQL_FOLD_STAGES.slice(0, -1).reduce(
    (acc, stage, k) => sql`${acc} WHEN ${expr} !~ ${stage.remainder} THEN ${upTo(k)}`,
    sql``,
  )

  return sql`CASE
    WHEN ${expr} !~ ${SQL_FOLD_ANY} THEN ${expr}
    ${branches}
    ELSE ${upTo(SQL_FOLD_STAGES.length - 1)}
  END`
}

/**
 * What a search matches against: the body and the document's file name, folded.
 * Built on `messageBodyJoin`'s `t`, so it is only valid where that join is.
 * `concat_ws` skips NULLs, so a captionless document is matched by its name
 * alone and a plain text message by its body alone.
 */
function searchableText(sql: Sql) {
  return fold(sql, sql`concat_ws(' ', t.body, t.filename)`)
}

/**
 * Which row of a duplicate set to keep — as a select-list expression, aliased
 * `named`, because `DISTINCT ON` will not sort on anything the select list does
 * not carry. The same reason `m.id` is selected as `"rowId"`: it is the final
 * tiebreaker and nothing reads it.
 *
 * The copies differ in `pushName`, and only some of them carry a name: a history
 * import can store the sender's own device-locale word for themselves, a bare LID,
 * or a LID JID. Prefer a value that is none of those, so the row that survives is
 * the one with something worth reading — and prefer it *deterministically*, since
 * this decides what an identical second call returns.
 *
 * A last resort, not the mechanism: `authorName` still resolves the sender through
 * the directory first, and refuses a numeric "name" outright.
 */
function bestNamed(sql: Sql) {
  return sql`(m."pushName" IS NOT NULL AND m."pushName" !~ '^[+0-9]' AND m."pushName" NOT LIKE '%@%')`
}

/**
 * The sender's identity as stored, preferring the group participant.
 *
 * Baileys writes `participant` for a group message on both the live and the
 * history path, and `participantAlt` — the same person's other addressing form —
 * only on the live one. Either resolves, because the directory is keyed on the
 * local part. For a 1:1 chat there is no participant and the chat's own JID *is*
 * the sender, which is why `remoteJid` is the fallback rather than nothing.
 */
export function senderOf(row: { key: MessageKey | null, pushName: string | null }): { identity?: string, pushName?: string } {
  return {
    identity: row.key?.participant ?? row.key?.participantAlt ?? row.key?.remoteJid,
    pushName: row.pushName ?? undefined,
  }
}

/**
 * The parts of Baileys' message key this app reads.
 *
 * `participantAlt` and `remoteJidAlt` exist only on rows written by live traffic:
 * history sync hands over the bare protobuf key, which carries exactly
 * `remoteJid`, `fromMe`, `id` and `participant`. So the same conversation yields
 * richer keys for recent messages than for imported ones, and nothing may require
 * the alternate forms to be there.
 */
export interface MessageKey {
  id?: string
  fromMe?: boolean
  remoteJid?: string
  remoteJidAlt?: string
  /** The sender, in a group. Absent in a 1:1 chat. */
  participant?: string
  participantAlt?: string
}

interface MessagePageRow extends MessageRecord {
  /** `COUNT(*) OVER ()`. A bigint, so it arrives as a string. */
  total: string | number
}

interface MessageRow {
  key: MessageKey | null
  pushName: string | null
  messageType: string | null
  /** Unix seconds, not milliseconds — the column is an Int. */
  messageTimestamp: number | null
  body: string | null
  /** File name of a document message, null for anything else. */
  filename: string | null
  /** `COUNT(*) OVER ()` on the search query; a bigint arrives as a string. Absent elsewhere. */
  total?: number | string | null
  /**
   * `contextInfo.mentionedJid`, or null where the message mentions nobody.
   *
   * Taken from the `contextInfo` **column** rather than from `message`, because
   * 2.3.7 rewrites `extendedTextMessage` into `conversation` and deletes it on
   * the way in — so the copy nested under `message` is not there to be read. It
   * is a column of `"Message"`, which the read-only search role already selects,
   * so this needs no grant change.
   */
  mentioned: string[] | null
  /** `protocolMessage.key.id`, or null where the row is not an edit. */
  editOf: string | null
}

/**
 * A range bound, parsed once and refused loudly.
 *
 * The refusal matters more than the parse: an unreadable date silently floored
 * into a timestamp matches nothing, so it would come back as "no messages" —
 * indistinguishable from an empty conversation, which is the answer this whole
 * module exists not to give by accident. Shared with `read-messages`, which
 * needs the same bound as an ISO string to echo back as `window`, so the query
 * and the envelope cannot disagree about what a date is.
 */
export function parseDateBound(value: string | undefined, field: string): Date | undefined {
  if (!value) return undefined

  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) {
    throw createError({
      statusCode: 400,
      message: `\`${field}\` is not a date I can read: ${value}. Use a format like 2024-03-01 or 2024-03-01T12:00:00Z.`,
    })
  }

  return new Date(parsed)
}

function toUnixSeconds(value: string | undefined, field: string): number | undefined {
  const parsed = parseDateBound(value, field)
  return parsed && Math.floor(parsed.getTime() / 1000)
}
