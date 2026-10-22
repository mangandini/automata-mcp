import type { H3Event } from 'h3'
import type { AppInstance } from './app-db'
import type { McpAuth } from './mcp-auth'
import type { InstanceKind } from '#shared/connection'

/**
 * Connector token scope: which chats a token may touch, and which tools it may
 * call. This module is the only place scope is interpreted.
 *
 * Both axes default open. A token with `allChats` and `allTools` behaves exactly
 * as tokens did before scoping existed.
 *
 * Enforcement happens in two different places, because they have to:
 *
 *   tools  `enabled(event)` on each tool definition. The toolkit evaluates it
 *          before building the request's MCP server, so a disallowed tool is
 *          never registered — `tools/call` fails just like `tools/list` omits
 *          it. This is real enforcement, not hiding.
 *   chats  inside handlers. `enabled` cannot see tool arguments, and the chat a
 *          call targets is an argument.
 */

// Declared in `shared/connection.ts` so the UI cannot hold a second copy that
// drifts. Re-exported here because this module is where the app reaches for it.
export type { InstanceKind }

/**
 * A connection's kind, checked against what this build understands.
 *
 * The column is `NOT NULL` with a `CHECK`, so in the ordinary case this is a
 * plain read. It still refuses a value it does not recognise rather than
 * assuming one: a rollback to an older build after a migration added a kind
 * leaves rows this code has never heard of, and treating one as WhatsApp would
 * hand its
 * `base_url`/`api_key` to the Evolution client and authenticate its tokens as a
 * WhatsApp connection. A loud refusal is the only safe reading of a value we
 * cannot interpret.
 */
export function instanceKind(instance: Pick<AppInstance, 'kind'>): InstanceKind {
  const kind = instance.kind as string | undefined
  switch (kind) {
    case 'whatsapp':
    case 'postgres':
    case 'telegram':
    case 'imap':
      return kind
    default:
      console.error(`[kind] connection kind ${JSON.stringify(kind)} is not supported by this build`)
      throw createError({ statusCode: 500, statusMessage: 'Unsupported connection kind' })
  }
}

/**
 * Whether `instanceKind()` can interpret this row, for the one caller that must
 * not throw on a row it cannot: the listing, where one unreadable connection
 * would otherwise take every other connection off the screen with it.
 */
export function isSupportedInstance(instance: Pick<AppInstance, 'id' | 'kind'>): boolean {
  try {
    instanceKind(instance)
    return true
  }
  catch {
    console.error(`[kind] connection ${instance.id} left out of the listing: its kind is not supported by this build`)
    return false
  }
}

export interface McpScope {
  allChats: boolean
  chatJids: string[]
  /** `schema.table`, exactly as Postgres reports it. Case-sensitive. */
  allTables: boolean
  tableNames: string[]
  allTools: boolean
  toolNames: string[]
}

export const OPEN_SCOPE: McpScope = {
  allChats: true,
  chatJids: [],
  allTables: true,
  tableNames: [],
  allTools: true,
  toolNames: [],
}

/**
 * Read scope off a token row. The columns are `NOT NULL` with defaults, so
 * every row carries all six; `!== false` keeps a partial object (a hand-built
 * record) reading as open rather than as a token with no access.
 */
export function scopeFromRecord(record: {
  all_chats?: boolean
  chat_jids?: unknown
  all_tables?: boolean
  table_names?: unknown
  all_tools?: boolean
  tool_names?: unknown
}): McpScope {
  return {
    allChats: record.all_chats !== false,
    chatJids: toStringArray(record.chat_jids),
    allTables: record.all_tables !== false,
    tableNames: toStringArray(record.table_names),
    allTools: record.all_tools !== false,
    toolNames: toStringArray(record.tool_names),
  }
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string' && v.length > 0)
}

// ── tools ──────────────────────────────────────────────────────────────────

/**
 * For the `enabled` guard on a tool definition.
 *
 * Two independent gates, both fail closed. No auth context means no tools —
 * unreachable while server/mcp/index.ts returns 401 before any tool is resolved,
 * but an empty toolset is the safe outcome if that ever changes.
 *
 * `kind` is not decoration. Which tools *exist* is a property of the connection;
 * which of those a token may call is a property of the token. Without the kind
 * gate, a Postgres token minted with `allTools` would register
 * `send-text-message`, whose handler calls `useEvolutionClient()` on a row that
 * has no Evolution credentials at all.
 *
 * Keep this synchronous. The toolkit evaluates `enabled` twice per request per
 * tool — once in `filterRawDefinitions`, once again in its own `filterByEnabled`.
 */
export function isToolAllowed(event: H3Event, toolName: string, kind: InstanceKind): boolean {
  const auth = event.context.mcpAuth as McpAuth | undefined
  if (!auth) return false
  // `auth.kind` and not `instanceKind(auth.instance)`: the discriminant is
  // resolved once in `resolveMcpAuth`, and reading it here is what makes the
  // union the single post-resolution reader of `instance.kind`.
  if (auth.kind !== kind) return false

  const scope = auth.scope
  if (scope.allTools) return true
  return scope.toolNames.includes(toolName)
}

// ── tables ─────────────────────────────────────────────────────────────────

/**
 * Qualified name of a Postgres relation, as this app writes it everywhere:
 * `schema.table`, both parts exactly as `pg_namespace.nspname` and
 * `pg_class.relname` report them.
 *
 * **Case-sensitive, deliberately.** Postgres folds unquoted identifiers to lower
 * case at parse time but stores whatever was actually created — Evolution's own
 * tables are `public.Message` and `public.Chat`. Folding case here would refuse
 * a legitimately allowlisted table, and loosening the comparison would let
 * `public.orders` match `public.Orders`, which is a different table.
 */
export function qualifiedName(schema: string, table: string): string {
  return `${schema}.${table}`
}

function isTableAllowed(scope: McpScope, qname: string): boolean {
  if (scope.allTables) return true
  return scope.tableNames.includes(qname)
}

/**
 * Refuse loudly, naming the table and what is reachable instead.
 *
 * Same reasoning as `assertChatAllowed`: a model told "no such table" will
 * report that the table does not exist, which sends the user looking for a
 * schema bug. A model told which tables it may reach can either rewrite the
 * query or ask for the grant.
 *
 * The list is included because it is not a secret from this caller — the token
 * holder chose it — and it is the difference between a refusal a model can act
 * on and one it can only relay.
 */
export function assertTableAllowed(scope: McpScope, qname: string): void {
  if (isTableAllowed(scope, qname)) return
  throw createError({
    statusCode: 403,
    message: `This connector token is not scoped to ${qname}. `
      + `The tables it may reach are: ${scope.tableNames.join(', ') || '(none)'}. `
      + `Ask the account owner to add ${qname} to the token's allowed tables, `
      + `or rewrite the query to use only the tables above.`,
  })
}

// ── chats ──────────────────────────────────────────────────────────────────

function isChatAllowed(scope: McpScope, jid: string): boolean {
  if (scope.allChats) return true
  return scope.chatJids.includes(jid)
}

/**
 * Refuse loudly, naming the chat.
 *
 * A model that gets a clear refusal can tell the user what happened. One that
 * gets an empty result assumes the chat is empty and says so, which is worse
 * than an error.
 */
export function assertChatAllowed(scope: McpScope, jid: string): void {
  if (isChatAllowed(scope, jid)) return
  throw createError({
    statusCode: 403,
    message: `This connector token is not scoped to ${jid}. Ask the account owner to add this chat to the token's allowed list.`,
  })
}

/**
 * Turn a phone number into the JID Evolution would use for it.
 *
 * **Never normalise JIDs locally.** Evolution's `createJid` carries
 * country-specific rules — Brazil's ninth digit, Mexico and Argentina prefixes —
 * so a hand-rolled comparison would let a scoped token reach a chat it was not
 * granted, or refuse one it was. Asking Evolution is the only way to be sure the
 * two sides agree.
 *
 * Requires a connected instance: the lookup goes through Baileys. Callers must
 * treat a failure as "cannot verify", never as "allowed".
 */
export async function resolveNumberToJid(
  instance: AppInstance,
  number: string,
): Promise<{ jid: string, exists: boolean, name?: string }> {
  const evolution = evolutionClientForInstance(instance)

  const results = await evolution<Array<{ jid: string, exists: boolean, number: string, name?: string }>>(
    `/chat/whatsappNumbers/${encodeURIComponent(instance.name)}`,
    { method: 'POST', body: { numbers: [number] } },
  )

  const match = Array.isArray(results) ? results[0] : undefined
  if (!match?.jid) {
    throw createError({
      statusCode: 422,
      message: `Could not resolve "${number}" to a WhatsApp account.`,
    })
  }

  return { jid: match.jid, exists: Boolean(match.exists), name: match.name }
}

/**
 * Scope check for a send, which addresses a chat by phone number rather than JID.
 *
 * Resolves through Evolution and compares exact JIDs. **Fails closed** — if the
 * lookup throws (instance offline, Evolution unreachable) the send is refused,
 * because an unverifiable recipient is exactly the case scope exists to stop.
 */
export async function assertNumberAllowed(
  instance: AppInstance,
  scope: McpScope,
  number: string,
): Promise<string> {
  if (scope.allChats) {
    // Nothing to check, so do not pay for the round trip.
    return number
  }

  let resolved: { jid: string }
  try {
    resolved = await resolveNumberToJid(instance, number)
  } catch (error) {
    if (httpStatusOf(error) === 422) throw error
    throw createError({
      statusCode: 503,
      message: 'Could not verify the recipient against this token\'s allowed chats, so the message was not sent. The WhatsApp account may be disconnected.',
      cause: error,
    })
  }

  assertChatAllowed(scope, resolved.jid)
  return resolved.jid
}
