import type { InstanceKind } from '#shared/connection'
import postgres from 'postgres'
import type { Sql, TransactionSql } from 'postgres'
import { APP_MIGRATIONS } from '../db/migrations'

/**
 * The app's own database: users, sessions, organizations, connections and their
 * credentials, connector tokens.
 *
 * One pool, in the `app` schema of the Postgres this deployment already runs for
 * Evolution (and the Telegram bridge, under `telegram`). Every query names
 * `app.<table>` explicitly rather than trusting a search path — the same rule
 * `telegram-db.ts` follows, for the same reason: the database is shared, and an
 * unqualified name that resolved into `public` would land among Evolution's
 * tables.
 *
 * **This credential is read-write and holds every secret the app has** — every
 * connection's Evolution key and DSN, every token hash, every password hash.
 * It is never handed to anything a user chose: `NUXT_DATABASE_URL` is in
 * net-guard's list of this deployment's own backends, so a user-supplied DSN
 * pointing at it is refused whatever `NUXT_ALLOW_PRIVATE_TARGETS` says.
 *
 * ── Failure semantics ───────────────────────────────────────────────────────
 *
 * A database that cannot be reached answers **503**, never 401, on both auth
 * surfaces. With PocketBase the hard part was telling "no such row" from "no
 * such collection" (both 404); here a query that finds nothing returns an empty
 * array and a fault throws, so the distinction comes for free. Keep it: any auth
 * read that catches a throw must turn it into `appDbUnavailable()`, never into
 * `undefined`.
 *
 * ── Row shape ───────────────────────────────────────────────────────────────
 *
 * Rows come back with `NULL` as `undefined` and timestamps as ISO strings, so
 * the `App*` types below can say `?: string` and mean it, and a row serialises to
 * JSON the way the UI has always received it.
 */

const SCHEMA = 'app'

/**
 * Something to run a query on: the pool, or a transaction a caller opened.
 * Functions that must stand or fall with their caller's other writes take one.
 */
export type Db = Sql | TransactionSql

/** `pg_advisory_xact_lock` key for migrations. Arbitrary, fixed, and unique to this app. */
const MIGRATE_LOCK = '7204118533901244'

/** How long a failed preparation is answered from memory before it is retried. */
const RETRY_AFTER_MS = 10_000

let pool: Sql | undefined
let ready: Promise<Sql> | undefined

/**
 * The pool, with the schema migrated.
 *
 * The first caller in a process prepares it; everyone else awaits the same
 * promise. A failure is kept for a few seconds and then forgotten, so the
 * process recovers on its own — a database that was still starting when Nuxt
 * booted is the ordinary case in compose — without every request in an outage
 * re-running the whole preparation.
 */
export function appDb(): Promise<Sql> {
  if (!ready) {
    ready = prepare().catch((cause) => {
      setTimeout(() => { ready = undefined }, RETRY_AFTER_MS).unref?.()
      throw cause
    })
  }
  return ready
}

async function prepare(): Promise<Sql> {
  const url = useRuntimeConfig().databaseUrl
  if (!url) {
    console.error('[app-db] NUXT_DATABASE_URL is not set. The app keeps its users, connections and tokens in Postgres and cannot run without it.')
    throw createError({ statusCode: 500, statusMessage: 'NUXT_DATABASE_URL is not set' })
  }

  pool ??= postgres(url, {
    max: 10,
    idle_timeout: 30,
    connect_timeout: 10,
    // A RAISE NOTICE has no business in the process log.
    onnotice: () => {},
    connection: { application_name: 'automata-web' },
    transform: {
      // Lets a write pass an object with optional fields straight through.
      undefined: null,
      value: {
        from: (value: unknown) => value === null ? undefined : value instanceof Date ? value.toISOString() : value,
      },
    },
  })

  try {
    const applied = await migrateAppDb(pool)
    if (applied.length) console.log(`[app-db] applied migrations: ${applied.join(', ')}`)
  }
  catch (cause) {
    console.error(
      '[app-db] could not prepare the app database. Check NUXT_DATABASE_URL — the host, the port, '
      + 'and that its role may create the `app` schema (or that it already exists):',
      cause,
    )
    throw appDbUnavailable(cause)
  }

  return pool
}

/**
 * Apply every migration not yet recorded, in order, in one transaction.
 *
 * The advisory lock makes two replicas booting together take turns rather than
 * both creating the same table. Existence of the schema is tested before
 * creating it because `CREATE SCHEMA IF NOT EXISTS` still demands CREATE on the
 * database, which a restricted role may lack even when the schema is there.
 */
async function migrateAppDb(sql: Sql): Promise<string[]> {
  const [existing] = await sql`SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = ${SCHEMA}`
  if (!existing) await sql`CREATE SCHEMA IF NOT EXISTS ${sql(SCHEMA)}`

  return await sql.begin(async (tx) => {
    await tx`SET LOCAL statement_timeout = 0`
    await tx`SELECT pg_advisory_xact_lock(${MIGRATE_LOCK}::bigint)`
    await tx`CREATE TABLE IF NOT EXISTS app.migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`

    const done = new Set((await tx<{ name: string }[]>`SELECT name FROM app.migrations`).map(row => row.name))
    const applied: string[] = []

    for (const migration of APP_MIGRATIONS) {
      if (done.has(migration.name)) continue
      // This app's own SQL, several statements each, so the simple protocol is
      // the intent: nothing in these strings comes from a request.
      await tx.unsafe(migration.sql)
      await tx`INSERT INTO app.migrations (name) VALUES (${migration.name})`
      applied.push(migration.name)
    }
    return applied
  })
}

/**
 * The 503 for an app database fault on an auth path.
 *
 * A handled `createError` is not logged by Nitro, so a caller that turns a
 * fault into this must have logged the cause itself — `prepare()` does, and so
 * does every auth read that uses it.
 */
export function appDbUnavailable(cause: unknown) {
  return createError({ statusCode: 503, statusMessage: 'Auth backend unavailable', cause })
}

/** A unique index refused the write — a taken email address, a duplicate assignment. */
export function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505'
}

// ── small row helpers ──────────────────────────────────────────────────────
//
// Table names are a closed union and go through `sql(identifier)`; values are
// always bind parameters. Nothing here builds SQL text from a request.

type AppTable = 'users' | 'organizations' | 'memberships' | 'instances' | 'instance_assignments' | 'invitations' | 'mcp_tokens'

type Writable = Record<string, unknown>

/** One row by primary key, or `undefined`. */
export async function getRow<T extends object>(table: AppTable, id: string | undefined): Promise<T | undefined> {
  if (!id) return undefined
  const sql = await appDb()
  const [row] = await sql<T[]>`SELECT * FROM ${sql(SCHEMA)}.${sql(table)} WHERE id = ${id}`
  return row
}

export async function insertRow<T extends object>(table: AppTable, values: Writable): Promise<T> {
  const sql = await appDb()
  const [row] = await sql<T[]>`INSERT INTO ${sql(SCHEMA)}.${sql(table)} ${sql(values)} RETURNING *`
  return row!
}

/**
 * Update one row and return it, or throw 404 if it is gone. `updated` is
 * stamped where the table has one.
 */
export async function updateRow<T extends object>(table: AppTable, id: string, values: Writable): Promise<T> {
  const sql = await appDb()
  const stamped = table === 'instance_assignments' ? values : { ...values, updated: new Date() }
  const [row] = await sql<T[]>`
    UPDATE ${sql(SCHEMA)}.${sql(table)} SET ${sql(stamped)} WHERE id = ${id} RETURNING *
  `
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Not found' })
  return row
}

// ── row shapes ─────────────────────────────────────────────────────────────

/**
 * A user, as every caller sees one. The password hash is deliberately not on
 * this type: only `account.ts` selects it, and nothing else should be able to
 * pass it around by accident.
 */
export interface AppUser {
  id: string
  email: string
  name?: string
}

/** An organization. Everything a user can reach hangs off exactly one of these. */
export interface AppOrganization {
  id: string
  name: string
  created?: string
}

export type OrgRole = 'admin' | 'member'

/**
 * One user's place in one organization. A unique index on `user_id` is what
 * enforces one organization per user, and why accepting an invitation updates
 * this row.
 */
export interface AppMembership {
  id: string
  org: string
  user_id: string
  role: OrgRole
  created?: string
}

/**
 * A grant of "may use, not manage" over one connection, to one member.
 *
 * Admins reach every connection in their organization and hold no rows here, so
 * an empty result is not the same as no access — always consult the role first.
 */
export interface AppInstanceAssignment {
  id: string
  instance: string
  user_id: string
  created?: string
}

/** A pending or spent invitation. `code_hash` is the SHA-256 of the link code. */
export interface AppInvitation {
  id: string
  org: string
  email: string
  role: OrgRole
  code_hash: string
  invited_by?: string
  accepted_by?: string
  expires_at?: string
  accepted_at?: string
  revoked: boolean
  created?: string
}

/**
 * One connection. `kind` says what sort — the row's other fields are read
 * according to it, and it decides which MCP tools a token on this row can see.
 * Read it through `instanceKind()` in mcp-scope.ts rather than directly.
 *
 * Six fields are secrets — `api_key`, `admin_key`, `dsn`,
 * `evolution_db_url`, `telegram_db_url` and `imap_password`. They never leave the server:
 * `toPublicInstance()` is the only projection the UI receives. They sit in
 * clear in the database and in every backup of it.
 *
 * `api_key` is Evolution's per-instance token. `admin_key` is a *global* key for
 * a user-supplied Evolution server and can create and delete instances on it, so
 * it is a wider secret than anything else on the row: never let it reach
 * `credentialsForInstance()`. `dsn` is a user-supplied database connection
 * string. `evolution_db_url` is a read-only URL for a bring-your-own Evolution
 * server's own database, and reaches every account on that server rather than
 * only this one.
 *
 * Text columns are `NOT NULL DEFAULT ''`, so an unset one reads as `''`; the
 * optional markers below are for rows built in code before they are written.
 */
export interface AppInstance {
  id: string
  /**
   * The owning organization. Authorization is decided against this and never
   * against `created_by`.
   */
  org: string
  /**
   * Who created the connection. Provenance only — it grants nothing, and it is
   * empty on a row whose creator has since been removed.
   */
  created_by?: string
  kind: InstanceKind
  name: string
  instance_id?: string
  api_key?: string
  admin_key?: string
  base_url?: string
  evolution_db_url?: string
  /**
   * Telegram only: a read-only URL for a bring-your-own bridge's database. Empty
   * means NUXT_TELEGRAM_DATABASE_URL, for a connection on the deployment's bridge.
   * See `telegramDbUrlFor` in telegram-db.ts.
   */
  telegram_db_url?: string
  /**
   * A database connection's connection string, shared by every SQL kind — the
   * name says nothing about an engine, and each engine's parser refuses the
   * others' schemes, so a DSN reaching the wrong reader fails at parse rather
   * than attempting a connection.
   */
  dsn?: string
  /**
   * Display-only mirrors of what `dsn` points at, so the dashboard and the
   * connection list can say where a connection goes without reading the secret.
   * Written once when the DSN is accepted; never consulted to connect.
   */
  db_host?: string
  db_port?: number
  db_database?: string
  /**
   * IMAP only: the mailbox. `imap_password` is a secret like `dsn`; the other
   * four are what the dashboard shows. Read only by imap-client.ts.
   */
  imap_host?: string
  imap_port?: number
  imap_security?: '' | 'tls' | 'starttls'
  imap_user?: string
  imap_password?: string
  label?: string
  created?: string
  /**
   * Outage state, written only by server/utils/alerts.ts. `down_since` empty
   * means healthy; `alerted_at` set means the current outage has already been
   * mailed.
   */
  down_since?: string
  alerted_at?: string
}

export interface AppMcpToken {
  id: string
  /**
   * The member this token was issued to. It authenticates only while that user
   * is still a member of the instance's organization and still reaches the
   * instance — see `resolveMcpAuth`.
   */
  assigned_to: string
  /** Who minted it. Provenance only; it confers nothing. */
  created_by?: string
  instance: string
  token_hash: string
  label?: string
  last_used_at?: string
  expires_at?: string
  revoked: boolean
  created?: string
  // Scope. See server/utils/mcp-scope.ts.
  all_chats: boolean
  chat_jids: unknown
  all_tables: boolean
  table_names: unknown
  all_tools: boolean
  tool_names: unknown
}

/**
 * A download link for one attachment. Holds where the file is, never what it
 * is: no bytes, and only the hash of the link's secret.
 */
export interface AppMediaLink {
  id: string
  token_hash: string
  instance: string
  /** The MCP token that created the link; its scope and liveness decide whether the link still works. */
  token_id: string
  message_id: string
  remote_jid: string
  file_name: string
  mime_type: string
  expires_at: string
  downloads: number
  created?: string
}
