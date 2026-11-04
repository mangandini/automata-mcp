import { assertNever } from '#shared/connection'
import { keepOptInNames } from '#shared/tool-optin'

export interface McpToolInfo {
  name: string
  title: string
  description: string
  readOnly: boolean
  /** Granted only when ticked by name; "all actions" does not include it. */
  optIn: boolean
}

export interface ScopedChat {
  jid: string
  name: string
  isGroup?: boolean
  /** Bare phone number of a 1:1 WhatsApp chat. Groups do not have one. */
  number?: string
  /** Telegram only: the chat's public @username, without the @. */
  username?: string
  /** IMAP only: emails synced in this folder. */
  messages?: number
  /** IMAP only: false for a folder that exists but is not synced (Junk, Trash, All Mail). */
  synced?: boolean
  /** Members in a group. Absent when the group lookup was skipped as unnecessary. */
  participantCount?: number
  profilePicUrl?: string
  /** Evolution's Chat row mtime, ISO 8601. A fallback when lastMessageAt is absent. */
  updatedAt?: string
  /** When the last message was sent, ISO 8601, when Evolution's row carries one. */
  lastMessageAt?: string
}

/** One reachable Postgres relation, `schema.table`, case-sensitive. */
export interface ScopedTable {
  qname: string
  schema: string
  name: string
  kind: string
  comment?: string
  estimatedRows?: number | null
}

export interface TokenScope {
  all_tools: boolean
  tool_names: string[]
  all_chats: boolean
  chat_jids: string[]
  all_tables: boolean
  table_names: string[]
}

export function openScope(): TokenScope {
  return {
    all_tools: true,
    tool_names: [],
    all_chats: true,
    chat_jids: [],
    all_tables: true,
    table_names: [],
  }
}

/**
 * Initial scope for a new token on a Postgres connection: every read tool, no
 * write tool.
 *
 * Read-only is the default because the cost of the two mistakes is not
 * symmetric — a token that turns out to need writes is one edit away, and a
 * token that turns out not to have needed them may already have made some.
 * The caller passes the catalogue because only the server knows what the tools
 * are. An opt-in tool is left unticked even when it only reads: it is not part
 * of any default, whatever its annotations say.
 */
export function readOnlyScope(tools: McpToolInfo[]): TokenScope {
  return {
    all_tools: false,
    tool_names: tools.filter(t => t.readOnly && !t.optIn).map(t => t.name),
    all_chats: true,
    chat_jids: [],
    all_tables: true,
    table_names: [],
  }
}

/**
 * One-line summary for the tokens table.
 *
 * Only the axis that applies to this connection's kind is mentioned: a Postgres
 * token leaves `all_chats` at its default `true`, and reporting "All chats" for
 * a database would be noise at best.
 */
export function describeScope(scope: TokenScope, kind: InstanceKind): string {
  let dataOpen: boolean
  let data: string
  switch (kind) {
    case 'postgres':
      dataOpen = scope.all_tables
      data = scope.all_tables ? 'All tables' : plural(scope.table_names.length, 'table')
      break
    case 'whatsapp':
    case 'telegram':
      dataOpen = scope.all_chats
      data = scope.all_chats ? 'All chats' : plural(scope.chat_jids.length, 'chat')
      break
    // Folders ride the chat axis (`chat_jids` holds paths on a mail token).
    case 'imap':
      dataOpen = scope.all_chats
      data = scope.all_chats ? 'All folders' : plural(scope.chat_jids.length, 'folder')
      break
    default:
      return assertNever(kind, 'connection kind')
  }

  // "All actions" never includes an opt-in tool, so it is named when held.
  const attachments = scope.all_tools && keepOptInNames(scope.tool_names).length > 0 ? ' + attachments' : ''
  if (scope.all_tools && dataOpen) return `Full access${attachments}`
  return [data, scope.all_tools ? `all actions${attachments}` : plural(scope.tool_names.length, 'action')].join(' · ')
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}
