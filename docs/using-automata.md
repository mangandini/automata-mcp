# Using Automata

## Getting started

1. Sign up at your deployment's address (<http://localhost:3000> locally).
2. Create a connection: pick **WhatsApp account**, **Telegram account**,
   **Email (IMAP)** or **PostgreSQL database**, and name it.
3. **WhatsApp:** continue to the QR code and scan it — WhatsApp → Settings →
   Linked devices → Link a device. To use an Evolution server other than this
   app's, tick **Use my own Evolution API server** first (see [Bring your own Evolution server](whatsapp.md#bring-your-own-evolution-server)).
   **Telegram:** on the connection's page press **Show QR code** and scan it —
   Telegram → Settings → Devices → Link Desktop Device. An account with two-step
   verification is then asked for its password, which goes to Telegram and is
   stored nowhere. Chats start syncing as soon as it links.
   **Postgres:** paste a connection string. It is proved by connecting before
   anything is saved (see [Database connections](postgres.md)).
   **Email:** enter the IMAP server and an app password. It is proved by logging
   in before anything is saved, and headers start syncing at once (see
   [Email (IMAP) connections](imap.md)).
4. On the connection's dashboard, create a **New connector token**: a name, an
   expiry (30 days, 90 days — the default — 1 year, or never) and a scope.
5. Add it to Claude. The **How to connect** dialog has the steps for Claude.ai
   (Settings → Connectors → Add custom connector), Claude Code
   (`claude mcp add --transport http <name> <url>`), clients that send an
   `Authorization: Bearer` header, and the MCP Inspector.

**One connection per connector.** A token is bound to the connection it was
created on, so no tool takes a connection argument, and Claude cannot address the
wrong number or the wrong database. Connect several and give each its own token.

## Organizations and roles

Connections belong to an **organization**, not to a person. Signing up creates
one and makes you its admin; you join someone else's only by accepting an
invitation, and an account belongs to exactly one organization.

- **Admins** manage the organization (**Team** page): invite people, change
  roles, remove members, create and delete connections, assign them, and mint
  or edit tokens for anyone.
- **Members** use the connections assigned to them. They see only their own
  tokens there, and may revoke a token or rotate its secret but never widen its
  scope. Reconnecting, re-pairing and deleting are management, so a member is
  told what is wrong and that an admin can fix it.

An invitation names an email address and can be accepted only by an account
with that address, so a forwarded link is useless to anyone else. The link is
shown once when it is created and can also be emailed (see [Connection alerts](alerts.md)
for SMTP). Accepting moves you out of your current organization, which is
refused while that organization still owns connections or while you are its
only admin with other members left.

Anything that takes away someone's access to a connection — unassigning it,
demoting an admin, removing a member — revokes the tokens they held on it, and
asks first. A connection you cannot see answers 404; one you can see but may not
manage answers 403.

## MCP tools

Every tool is gated twice: by the connection's kind — a Postgres token never sees
a WhatsApp tool, whatever its scope — and by the token's scope. The server also
sends per-kind instructions telling the model how to page and how to read what
comes back.

| Tool | Kind | | What it does |
|---|---|---|---|
| `get-connection-status` | WhatsApp | read | Whether the account is paired and connected (`open`) |
| `list-chats` | WhatsApp | read | Conversations in scope with the `jid` other tools take; filter by name, number or jid with `query`, by `type` (`group` / `direct`) or `unreadOnly`; `sort` by `last` activity (default) or `name`; pages of up to 200 (`page`, `limit`), with `hasMore`/`nextPage` and `truncated` / `incomplete` / `unnamedGroups` flags when the listing is partial |
| `list-contacts` | WhatsApp | read | Address-book contacts (groups excluded) with their `jid`, number and name; optional `query`, `page`, `limit` (default 100); says `hasMore` when there is another page |
| `read-messages` | WhatsApp | read | One chat, newest first, 1–200 per page (default 50), optional `since` / `until`; reports `hasMore`, `nextPage`, `covered` and `totalMatching` |
| `search-messages` | WhatsApp | read | Messages containing every word of `query`, across chats in scope or one `jid`; optional date range and `fromMe`; up to 100 matches (default 20) |
| `send-text-message` | WhatsApp | **write** | Send text to a number in international format |
| `get-telegram-status` | Telegram | read | Whether the account is linked and online, who it is signed in as, and how far sync has got |
| `list-telegram-chats` | Telegram | read | Synced chats in scope — private, groups, supergroups, channels — most recently active first, with the `chatId` other tools take |
| `read-telegram-messages` | Telegram | read | One chat, newest first, with the same paging envelope as `read-messages`; optional forum `topicId`; says when older history was never synced |
| `search-telegram-messages` | Telegram | read | Messages containing every word of `query` (text and captions), across chats in scope or one `chatId` |
| `send-telegram-message` | Telegram | **write** | Send plain text to a `chatId` or an @username |
| `get-mailbox-status` | Email | read | Which mailbox, whether its sync works, when it last ran, and which folders are still backfilling |
| `list-mail-folders` | Email | read | Folders in scope with synced and unread counts; skipped folders (All Mail, Junk, Trash) marked `synced: false` |
| `list-emails` | Email | read | Headers newest first from one folder or all in scope, 1–100 per page; filters for date, unread, flagged, attachments |
| `search-emails` | Email | read | `from`, `to`, `subject` against synced headers and `text` through the mail server's own search |
| `read-email` | Email | read | One email's headers, body as plain text (fetched live, never stored) and attachment list |
| `get-email-attachment` | Email | read | One attachment, fetched live: images as images, text as text, other files embedded; 10 MB cap by default |
| `get-database-info` | Postgres | read | Server version, database, connecting role, and what this token is scoped to |
| `list-tables` | Postgres | read | Tables in scope, filterable by schema and name, paged (1–500, default 100) |
| `describe-table` | Postgres | read | Columns, keys, constraints, indexes and comments for one table |
| `run-query` | Postgres | read | One `SELECT` / `WITH` / `VALUES` / `TABLE` in a read-only transaction; pages of `maxRows` rows (≤ 1000, default 200) walked with `page`; cells clipped at 2000 chars unless `fullValues`; 10 s timeout by default, 30 s max |
| `run-statement` | Postgres | **write, destructive** | One `INSERT` / `UPDATE` / `DELETE` / `MERGE`; rolled back whole if it would change more than `maxRows` (default 100, no ceiling); no `WHERE` refused without `allowWholeTable`; 15 s timeout by default, 60 s max |

`read-messages` and `search-messages` leave reactions out unless called with
`includeReactions: true`, and say so with `reactionsExcluded`.

## Scoping a token

A token is narrowed on independent axes, set when it is created and editable from
the connection's dashboard. Which axes appear depends on the kind:

- **Actions** (every kind) — all tools, or a chosen few, listed from the
  connection's own kind. Enforced by refusing to register the others for that
  request, so a tool outside scope is not merely hidden from the tool list:
  calling it fails. A new Postgres token starts read-only — the read tools
  ticked, `run-statement` not.
- **Chats** (WhatsApp and Telegram) — all conversations, or an allowlist. `list-chats` returns
  only allowed conversations; `read-messages` and `send-text-message` refuse
  anything else, naming the chat so the assistant can explain why.
  `search-messages` does both: asked for a chat outside scope it refuses by name,
  while an unrestricted search is narrowed to the allowed chats — out-of-scope
  messages are excluded by the query itself, not filtered out after being read.
  **Telegram** works the same way through its own tools, with chats named by
  `chatId`; a send to an @username is resolved first and then checked against
  the allowlist, so a name cannot reach a chat the id could not.
- **Folders** (Email) — all folders, or an allowlist, stored on the chat axis.
  Listings and searches are narrowed in SQL; reading an email or fetching an
  attachment from a folder outside it is refused by name. An email filed in
  several folders is reachable only through a copy in an allowed one.
- **Tables** (Postgres) — every table the connecting role can read, or an
  allowlist. `list-tables` and `describe-table` apply it in their own SQL, so a
  table outside it is neither listed nor described. `run-query` and
  `run-statement` check the statement's query plan before a row is read and
  refuse anything that touches a table outside it. Names match case-sensitively
  (`public.Orders` is not `public.orders`), and allowing a partitioned table
  allows its partitions. What this does and does not protect against is in
  [Database connections](postgres.md).

The chat picker lists conversations Evolution has recorded — the history imported
at pairing, plus everything since. An account paired before full-history sync was
switched on shows only the latter until it is re-imported. Either way a number
that has never messaged you can be added directly; it is checked against WhatsApp
before it is accepted.

Scope is read fresh on every request, so **editing a token's scope takes effect
immediately and does not reissue it**. The connector already configured in Claude
keeps working; only what it can reach changes.

A scoped send refuses when it cannot verify the recipient — if the account is
disconnected, the message is not sent rather than sent unchecked.

The token is shown exactly once — only its SHA-256 hash is stored. Lost tokens
are replaced, not recovered. Revoking one takes effect immediately, and revoking
stays available while an account is disconnected or a database is unreachable.

Inspect the endpoint by hand with:

```bash
pnpm dlx @modelcontextprotocol/inspector
```

Point it at `http://localhost:3000/mcp/<token>`, or at `http://localhost:3000/mcp`
with an `Authorization: Bearer <token>` header. On a deployment, the same paths
under its `NUXT_PUBLIC_APP_URL`.
