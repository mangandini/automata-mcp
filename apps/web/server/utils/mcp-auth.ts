import { assertNever } from '#shared/connection'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { H3Event } from 'h3'
import type { AppInstance, AppMcpToken, AppUser, Db, OrgRole } from './app-db'
import type { McpScope } from './mcp-scope'
import type { EvolutionCredentials } from './evolution'
import type { TelegramCredentials } from './telegram'

/**
 * Auth for the MCP surface — and ONLY the MCP surface.
 *
 * This module has no access to, and no fallback to, the browser session. A
 * request that fails token auth here fails outright; it never degrades into
 * "well, there is a session cookie, use that". See server/utils/session.ts
 * for the other, entirely separate path.
 *
 * Tokens are minted by this app. A token is bound to exactly one connected
 * WhatsApp account, so the instance is implicit at every call site and no tool
 * takes an instance argument. Evolution's per-instance `apikey` is read from
 * that instance's record server-side and never leaves this process.
 */

const TOKEN_PREFIX = 'wamcp_'

interface McpAuthBase {
  user: AppUser
  instance: AppInstance
  tokenId: string
  /** Which chats, tables and tools this token may reach. See mcp-scope.ts. */
  scope: McpScope
}

/**
 * The resolved credential for one MCP request, discriminated by connection kind.
 *
 * A union rather than a bag of optional fields, so a handler that reaches for
 * `evolution` has to establish it is talking to a WhatsApp connection first —
 * the type says what the kind gate on every tool's `enabled` also says.
 *
 * Postgres carries no separate credential object: the DSN lives on the instance
 * row and `pgFor(instance)` is the only thing that reads it, so copying it here
 * would put a second live copy of a user's database password in request context
 * for no gain. IMAP follows the same rule for the mailbox password, which only
 * imap-client.ts reads.
 */
export type McpAuth =
  | (McpAuthBase & { kind: 'whatsapp', evolution: EvolutionCredentials })
  | (McpAuthBase & { kind: 'postgres' })
  | (McpAuthBase & { kind: 'telegram', telegram: TelegramCredentials })
  | (McpAuthBase & { kind: 'imap' })

/**
 * One row per token, joined to everything that decides whether it still works.
 * The joins are LEFT so a missing piece reads as a missing piece (and is logged
 * as one) rather than as no such token.
 */
export interface McpTokenFacts extends Pick<AppMcpToken,
  'id' | 'assigned_to' | 'instance' | 'token_hash' | 'expires_at' | 'revoked'
  | 'all_chats' | 'chat_jids' | 'all_tables' | 'table_names' | 'all_tools' | 'tool_names'> {
  user_email?: string
  user_name?: string
  member_role?: OrgRole
  member_org?: string
  assigned: boolean
}

/** Which token to load the facts of: by the hash of the secret presented, or by id. */
export type TokenLookup = { hash: string } | { id: string }

/**
 * The token's row joined to everything that decides whether it still works —
 * the single copy of that query, shared by every caller that has to answer "may
 * this token be used right now". It only reads: what a missing piece means, and
 * which failure it maps to, stays with the caller (see `resolveMcpAuth`).
 *
 * `assigned` is about the token's own `instance`, and `member_org` is the org of
 * the holder's membership: a caller compares that against the org of the
 * instance **of the token**, never one it was handed from somewhere else.
 */
export async function selectTokenFacts(sql: Db, by: TokenLookup): Promise<McpTokenFacts | undefined> {
  const [facts] = await sql<McpTokenFacts[]>`
    SELECT t.id, t.assigned_to, t.instance, t.token_hash, t.expires_at, t.revoked,
           t.all_chats, t.chat_jids, t.all_tables, t.table_names, t.all_tools, t.tool_names,
           u.email AS user_email, u.name AS user_name,
           m.role AS member_role, m.org AS member_org,
           EXISTS (
             SELECT 1 FROM app.instance_assignments a
             WHERE a.user_id = t.assigned_to AND a.instance = t.instance
           ) AS assigned
    FROM app.mcp_tokens t
    LEFT JOIN app.users u ON u.id = t.assigned_to
    LEFT JOIN app.memberships m ON m.user_id = t.assigned_to
    WHERE ${'hash' in by ? sql`t.token_hash = ${by.hash}` : sql`t.id = ${by.id}`}
  `
  return facts
}

/** Neither revoked nor past its expiry. Says nothing about whether the holder still reaches the connection. */
export function isTokenLive(facts: Pick<McpTokenFacts, 'revoked' | 'expires_at'>, now: number = Date.now()): boolean {
  if (facts.revoked) return false
  return !(facts.expires_at && new Date(facts.expires_at).getTime() <= now)
}

/** Mint a new token. The plaintext is returned once and never stored. */
export function mintMcpToken(): { token: string, hash: string } {
  const token = TOKEN_PREFIX + randomBytes(32).toString('base64url')
  return { token, hash: hashMcpToken(token) }
}

export function hashMcpToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Pull the presented token off the request.
 *
 * `Authorization: Bearer <token>` is the primary form. The `/mcp/<token>` path
 * segment is a fallback for MCP clients that cannot attach custom headers.
 */
function extractToken(event: H3Event): string | undefined {
  const header = getRequestHeader(event, 'authorization')
  if (header) {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (match) return match[1]!.trim()
    // An Authorization header that is present but malformed is a hard failure —
    // do not silently fall through to the path segment.
    return undefined
  }

  // Registered by modules/mcp-token-route.ts. Undefined on the plain /mcp route.
  const param = getRouterParam(event, 'token')
  return param ? decodeURIComponent(param) : undefined
}

/**
 * Resolve a request to a user and the one instance its token is bound to, or
 * `undefined`. Callers must treat `undefined` as 401 — never as anonymous
 * access.
 */
export async function resolveMcpAuth(event: H3Event): Promise<McpAuth | undefined> {
  const token = extractToken(event)
  if (!token || !token.startsWith(TOKEN_PREFIX)) return undefined

  // ── who this token still reaches ─────────────────────────────────────────
  //
  // A token names a member and a connection. It authenticates only while that
  // member is still in the connection's organization and still reaches the
  // connection — so removing someone, or unassigning a connection from them,
  // kills their tokens on the very next request even if an explicit revoke was
  // missed. That is the whole reason this is read live and neither cached nor
  // denormalized onto the token: a cache would delay exactly the effect this
  // exists to produce, and a copied `org` would go stale on every one of those
  // transitions.
  //
  // One query for the token and the facts about its holder, then the instance
  // row by primary key. Failure semantics, which are the point of this block:
  //
  //   no such token hash               → 401           not a credential
  //   any read THROWS                  → 503           an outage, not a revocation
  //   holder or instance row gone      → 401           a dead credential
  //   no membership                    → 401, logged   the holder is in no org
  //   membership.org !== instance.org  → 401, logged   they left the org
  //   no assignment, role member       → 401, logged   assignment revoked
  //   role admin                       → authorized, assignments not consulted
  const hash = hashMcpToken(token)
  let record: McpTokenFacts | undefined
  let instance: AppInstance | undefined
  try {
    const sql = await appDb()
    record = await selectTokenFacts(sql, { hash })
    if (record) instance = await getRow<AppInstance>('instances', record.instance)
  } catch (error) {
    // Answering 401 here would tell a client its valid token had been revoked
    // and invite it to throw the token away.
    console.error('[mcp-auth] could not resolve a token against the app database:', error)
    throw appDbUnavailable(error)
  }

  if (!record) return undefined

  // Defence in depth: the lookup above already proves equality, but compare the
  // stored hash explicitly so a future change to the query cannot weaken this.
  const presented = Buffer.from(hash)
  const stored = Buffer.from(record.token_hash)
  if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) {
    return undefined
  }

  if (!isTokenLive(record)) return undefined

  // The token points at a row that is gone. A dead credential, not an outage.
  if (!instance || !record.user_email) return undefined
  const user: AppUser = { id: record.assigned_to, email: record.user_email, name: record.user_name }

  if (!record.member_role || !record.member_org) {
    console.error(`[mcp-auth] user ${record.assigned_to} is in no organization; token ${record.id} refused`)
    return undefined
  }

  // The rule itself lives in org.ts and is shared verbatim with the web UI, so
  // the two surfaces cannot drift on who may reach what while still loading
  // their own facts through their own credential path.
  if (!authorizesInstance(
    { role: record.member_role, orgId: record.member_org },
    instance.org,
    record.assigned,
  )) {
    console.error(
      `[mcp-auth] user ${user.id} (${record.member_role}, org ${record.member_org}) `
      + `does not reach instance ${instance.id} (org ${instance.org}); token ${record.id} refused`,
    )
    return undefined
  }

  // Per-kind credentials. A missing one means the connection was never finished,
  // which is a genuine "this credential does not work" and so a 401 — not the
  // 503 that a backend outage gets. It is also invisible in the logs otherwise,
  // and "my token stopped working" with nothing in the logs is the failure that
  // rule exists to prevent, so say which connection and why.
  // A kind this build cannot interpret is refused, never guessed at — see
  // `instanceKind()`. `instanceKind` has already logged which value it was.
  let kind: InstanceKind
  try {
    kind = instanceKind(instance)
  }
  catch {
    console.error(`[mcp-auth] instance ${instance.id} has an unsupported kind; token ${record.id} refused`)
    return undefined
  }
  const base = { user, instance, tokenId: record.id, scope: scopeFromRecord(record) }

  let auth: McpAuth
  switch (kind) {
    case 'postgres': {
      if (!instance.dsn) {
        console.error(`[mcp-auth] instance ${instance.id} is kind=postgres with no dsn; token ${record.id} refused`)
        return undefined
      }
      auth = { ...base, kind: 'postgres' }
      break
    }
    case 'whatsapp': {
      const evolution = credentialsForInstance(instance)
      if (!evolution) {
        console.error(`[mcp-auth] instance ${instance.id} has no Evolution credentials; token ${record.id} refused`)
        return undefined
      }
      auth = { ...base, kind: 'whatsapp', evolution }
      break
    }
    case 'telegram': {
      const telegram = telegramCredentialsForInstance(instance)
      if (!telegram) {
        console.error(`[mcp-auth] instance ${instance.id} has no Telegram bridge credentials; token ${record.id} refused`)
        return undefined
      }
      auth = { ...base, kind: 'telegram', telegram }
      break
    }
    case 'imap': {
      if (!instance.imap_host || !instance.imap_user) {
        console.error(`[mcp-auth] instance ${instance.id} is kind=imap with no mailbox; token ${record.id} refused`)
        return undefined
      }
      auth = { ...base, kind: 'imap' }
      break
    }
    default:
      return assertNever(kind, 'connection kind')
  }

  // Best-effort; a write failure must not fail an otherwise valid request.
  void appDb()
    .then(sql => sql`UPDATE app.mcp_tokens SET last_used_at = now() WHERE id = ${record.id}`)
    .catch(() => {})

  return auth
}

/**
 * The authenticated instance, for MCP tool handlers.
 *
 * Same async-context mechanism as `useEvolutionClient()`: the MCP SDK calls
 * handlers without an H3 event, so `useEvent()` recovers it. Fails closed if the
 * auth middleware was somehow bypassed.
 */
export function useMcpAuth(): McpAuth {
  const event = useEvent()
  const auth = event.context.mcpAuth as McpAuth | undefined
  if (!auth) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }
  return auth
}

/**
 * 401 with a `WWW-Authenticate` challenge, shaped as a JSON-RPC error so MCP
 * clients can surface something useful. Never return 200 on an auth failure —
 * a 200 with an error body reads as "the tool ran and said no".
 */
export function mcpUnauthorized(reason = 'invalid_token'): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32001, message: 'Unauthorized' },
    }),
    {
      status: 401,
      headers: {
        'content-type': 'application/json',
        'www-authenticate': `Bearer realm="claude-whatsapp-mcp", error="${reason}"`,
      },
    },
  )
}
