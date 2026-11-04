# WhatsApp connections

## Reading and searching messages

`NUXT_EVOLUTION_DATABASE_URL` is **required** for accounts on this deployment's
Evolution server. Both `read-messages` and `search-messages` read Evolution's
Postgres directly, and neither can answer without it — pairing, `list-chats` and
`send-text-message` still work, and the app says so once at startup. It is the one
part of this app that does not go through the Evolution API, for two separate
reasons.

**Searching.** Evolution 2.3.7 cannot search message content. `POST
/chat/findMessages` accepts a `where.message` — its request schema even documents
the field — and then never reads it, so a content search comes back as an
unfiltered page that looks like a result set. The only filters it honours are
`id`, `source`, `messageType`, a `messageTimestamp` range, and
`key.{id,remoteJid,fromMe,participant}`. Reading the database instead also reaches
text WhatsApp stores a level or two down — an album item's caption under
`associatedChildMessage`, an edit's new wording under
`protocolMessage.editedMessage` — which no top-level extractor could see.

**Reading.** Evolution stores a message more than once. Its history import
deduplicates against an in-memory set of message ids rebuilt at the start of each
batch, and the `createMany` behind it asks to skip duplicates — which does
nothing, because the only unique constraint on `Message` is a generated primary
key that cannot collide. So two batches in flight together, or an import racing
live traffic, both insert; re-pairing an account is what puts them in flight. The
copies disagree about who sent the message, because each carries whatever push
name was on the wire at the time — a real name, a bare LID, or the sender's own
device-locale word for themselves. Left alone, one message is three, a five-day
range reports triple the messages it holds, and pages come back ragged. The
endpoint cannot fix it: it pages with `skip`/`take` over the duplicate rows, so
the page boundaries are already wrong by the time anything could collapse them.
`DISTINCT ON (key->>'id')` before `LIMIT` is the fix, and that means SQL.

Searching ignores accents by folding the column in SQL (`translate`) with the same
table the JavaScript side uses, so it needs no Postgres extension on Evolution's
database.

Reactions are dropped in the same query, on the payload rather than on
`messageType`. WhatsApp's own control records cannot be — `messageType` carries no
subtype, and excluding `protocolMessage` wholesale would delete every message edit
along with the bookkeeping — so those are dropped after the rows are read and
counted back to the caller as `protocolMessagesExcluded`.

**Which credential.** The same URL as `NUXT_DATABASE_URL` works, and it is what
the [Railway setup](deploy-railway.md) uses. Every query the app sends here is fixed SQL with
bound parameters — nothing a model or a user writes reaches this connection as
SQL — and the pool opens each session with `default_transaction_read_only`, so a
write fails even under a superuser. That setting is a backstop, not a boundary: a
superuser can switch it off, but only through SQL, and the app never sends any it
did not write.

```bash
NUXT_EVOLUTION_DATABASE_URL=postgres://evolution:change-me@localhost:5432/evolution
```

**Optional hardening: a role that can do nothing else.** This connection reaches
every user's messages in every instance. A dedicated role does not protect them
from a compromised web service — that process already holds `NUXT_DATABASE_URL`,
the database's owner — but it does contain a bug in the app's own message queries
to reading `"Message"`, where under the owner such a bug would reach every stored
credential in the `app` schema. If you want that, the one grant below serves both
reading and searching:

```sql
CREATE ROLE wamcp_search LOGIN PASSWORD 'change-me';
GRANT CONNECT ON DATABASE evolution TO wamcp_search;
GRANT USAGE ON SCHEMA public TO wamcp_search;
GRANT SELECT ON "Message" TO wamcp_search;
```

```bash
NUXT_EVOLUTION_DATABASE_URL=postgres://wamcp_search:change-me@localhost:5432/evolution
```

Evolution ships `@@index([instanceId])` and nothing else — no index on
`messageTimestamp`, none on the `key` JSONB — so reading and searching are both a
sequential scan within one account. History import makes that corpus much larger than it would
otherwise be: a number with years of conversations arrives all at once at
pairing, rather than accumulating. The queries carry a 10-second
`statement_timeout` so a slow scan surfaces as an error instead of a hung MCP
call. Once a scan starts timing out, add (as a Postgres superuser, not as the
app):

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS message_instance_ts_idx
  ON "Message" ("instanceId", "messageTimestamp" DESC);
```

Worth knowing before you go looking for a bug:

- Both cover whatever Evolution holds: the history imported at pairing plus
  everything since. An account paired before full-history sync was turned on has
  only what arrived after — see [Importing existing history](#importing-existing-history).
- Reads are deduplicated by message id, so `totalMatching` counts distinct
  messages and can be quoted as an answer. It will often be smaller than the row
  count Evolution's own API reports for the same range. The two are not
  comparable, and the smaller one is the true one.
- **The dashboard's chat count and `list-chats` count different things.** The
  count is every conversation the phone listed at pairing; `list-chats` lists
  conversations Evolution holds messages for, which is routinely fewer. The gap
  is not more pages — `hasMore` is the only signal that there are.
- The scope editor lists the tools of the connection's own kind, and lists both
  read tools whether or not the database URL is set. It deliberately does not
  hide a tool with an unmet prerequisite: both read tools need that URL, so
  hiding one would leave a scope editor that disagrees with the tool list a
  client actually sees. An unset URL is reported at startup instead.
- **A connection on your own Evolution server needs its own database URL.** This
  variable names one database — the one belonging to the Evolution server this
  app is configured with — and a bring-your-own connection's messages live in
  that server's database instead. Supply it when creating the connection, or from
  its dashboard afterwards (**Enable reading**); it is stored on the connection,
  not here. Until then reads answer 501 naming the missing setting rather than
  matching nothing and reporting an empty conversation. Pairing, chat listing and
  sending never need it.

  Same shape of role as above, in *your* database:

  ```sql
  CREATE ROLE evo_reader LOGIN PASSWORD 'change-me';
  GRANT CONNECT ON DATABASE evolution TO evo_reader;
  GRANT USAGE ON SCHEMA public TO evo_reader;
  GRANT SELECT ON "Message" TO evo_reader;
  ```

  It is checked before it is stored — including that `"Message"` is actually
  readable, because a URL that connects to the *wrong* database is otherwise
  indistinguishable from an account with no messages.

On Railway, Evolution's Postgres is its own service — use its private URL, and
note the port there is whatever that service actually listens on (see "Pin the
ports").

## Attachments (`get-message-media`)

`get-message-media` opens the attachment of one message, by the message `id` that
`search-messages` and `read-messages` return. It is **opt-in**: "all actions" does
not include it, and a token holds it only when it is ticked by name under "Extras
(off by default)" in the token dialog. Tokens that existed before it keep not
having it.

What a call does, in order:

1. Looks the message up in Evolution's database, limited to the chats in the
   token's scope. A message that does not exist, one in a chat outside the scope,
   and one that is only reachable through its other `@lid` or phone form all get
   the same 404, so ids cannot be probed.
2. Refuses what is not an image or a document: audio, voice notes, video,
   stickers, view-once media (422, naming the type). Files declared above 25 MB
   (`NUXT_WHATSAPP_MEDIA_MAX_BYTES`) are refused before anything is downloaded.
3. Downloads the file from WhatsApp, once, through Evolution
   (`getBase64FromMediaMessage`, sent the whole stored message, not just its id),
   with a 30 s timeout, a two-at-a-time limit per process (and only one PDF read at a time), a two-minute pause on a
   message after a timeout, and a check of the bytes against the message's own
   `fileSha256`. Only images and PDFs of up to 10 MB are read for the model;
   other documents (Word, Excel, text) and anything over 10 MB are never
   downloaded by the tool: they come back as details plus the link.
4. Gives the model what it can read. An image comes back as a picture, shrunk
   to fit the response (`processing.imageStep` says how far; the original is behind
   the link). A PDF comes back as its text with `[page N]` markers, up to 50
   pages, 10 s and the response size; a scanned PDF has no text and comes back as
   a link only. Everything fits in 120 000 characters, base64 included.
5. Creates a public download link, `<NUXT_PUBLIC_APP_URL>/api/media/<token>`,
   valid for 1 hour and 20 downloads, for the model to hand to the user. Opening
   it shows a page with a Download button; only the button fetches the file. Each
   call makes a new link, and the link stops working when its token is revoked,
   loses the connection or the tool, or loses the chat. Without
   `NUXT_PUBLIC_APP_URL` the tool still reads, and says there is no link.

Verified original bytes are kept in the server's memory for 10 minutes
(`NUXT_WHATSAPP_MEDIA_CACHE_BYTES`, default 50 MB, `0` turns it off), so a second
call or opening the link right after does not ask WhatsApp again. Nothing is
written to disk or to the database.

Failures say what happened: a file WhatsApp no longer serves ("it may have
expired; ask the sender to send it again"), no answer within 30 s, and, when the
live account state is not `open`, that the account is disconnected. The public
link page never states the account's state.

Things to know:

- Evolution has no size limit of its own and `fileLength` is written by the
  sender, so a message that lies about its size makes Evolution load the real
  file; the tool's cap protects this server's memory, not Evolution's. That gap
  exists for anyone holding an instance key.
- Your reverse proxy (Traefik on Coolify, Railway) logs the request path, and the
  link's secret is in the path. The app redacts it from its own logs, not from the
  proxy's.
- It needs `sharp` (a native binary, one per platform and libc) and `unpdf`; they are
  ordinary dependencies of the web app, so a build made on the platform it runs on
  (the published images build and run on Alpine) has them. Both Dockerfiles check
  this at build time and **fail the build** if either cannot load, so a missing
  binary shows up when you build, not on the first call. Proven on linux/arm64 and
  linux/amd64 for the web image; the all-in-one image is amd64-only (see
  [Single container](self-hosting.md#memory-and-architecture)).

### Memory for attachments

Everything is held in memory, so what the process needs is set by limits in the
code, not by what a chat sends: at most two downloads or image jobs at a time per
process, and **at most one PDF worker** (a second PDF waits up to 20 s, then
answers "busy"). Each PDF worker is killed at 320 MB of its own memory or after
10 s, whichever comes first.

Measured in the web image with a 1 GiB limit, with two PDF decompression bombs
(a few MB that inflate to about 2 GB) arriving together with ordinary reads:

| Limit | Result |
|---|---|
| 1 GiB | survived every run; peak 860-940 MiB of anonymous memory with two PDF workers (before the one-PDF limit) |
| 832 MiB | survived, 2% margin (the smallest that did) |
| 768 MiB | the whole container was OOM-killed |

With one PDF worker the expected peak is about **500-570 MiB**. That is an
estimate from the same measurements; it has not been measured again since the
limit went in. Idle, the web app uses 55-90 MiB, and reading realistic PDFs
(large, many fonts) stays near 250 MiB.

So: give the web container **1 GiB at least**, and 2 GiB for the all-in-one image
(not measured under full load). A cache hit takes a processing slot like a
download does, so `NUXT_WHATSAPP_MEDIA_CACHE_BYTES` (50 MB by default) raises the
floor but not the number of workers.

## Importing existing history

WhatsApp hands over past conversations **once**, in a burst it pushes while a
device is being linked. There is no endpoint — here or upstream — that fetches
history afterwards. Evolution exposes `/chat/findMessages`, but that reads
Evolution's own Postgres, not WhatsApp.

Three things have to line up, and two of them have to be true *before* the QR is
scanned:

| | Where | Effect if wrong |
|---|---|---|
| `DATABASE_SAVE_DATA_HISTORIC=true` | evolution service env | Evolution receives the burst and drops it |
| `syncFullHistory: true` | sent at `POST /instance/create`, in `server/utils/instances.ts` | Only recent messages arrive, and groups are skipped |
| A fresh device link | scanning the QR | Reconnecting an existing session sends no history |

New accounts get all three automatically. An account paired before this was
turned on cannot be backfilled in place — **Import full history** on the
connection's dashboard sets the flag, signs the device out and puts the QR back
up; the import rides in on the re-scan. Nothing already stored is lost: Evolution
skips messages whose `key.id` it already has, so re-importing merges rather than
duplicates.

Watch it land with `pnpm services:logs` while scanning:

```
recv 412 chats, 1180 contacts, 39204 msgs (is latest: false, progress: 34%), type: 2
```

`type: 2` is a full sync, `type: 3` is the recent-only one. Anything but `2` means
`syncFullHistory` never reached the socket.

Caveats worth knowing before you rely on it:

- **Media is not downloaded.** History gives message records; the bytes still need
  `getBase64FromMediaMessage` per message, which is what
  [`get-message-media`](#attachments-get-message-media) does on request.
- **Depth is whatever the phone volunteers.** `syncFullHistory` asks for
  everything; it is not a guarantee of everything.
- **Groups come too.** `syncFullHistory` overrides Evolution's group filter, so
  group chats appear in `list-chats` and in the token scope picker.
- **Reads get slower as it grows.** Evolution indexes its `Message` table on
  `instanceId` only; `remoteJid` lives inside a JSONB column with no index.

## Bring your own Evolution server

A WhatsApp connection can be created against a user's own Evolution server: the
create form takes the base URL and that server's `AUTHENTICATION_API_KEY`, and
the app provisions an instance on it exactly as it does on the default server.
Both halves or neither — half a configuration is never completed from this
deployment's own, because sending our global key to a server someone else
controls would hand them every account on ours.

With `NUXT_EVOLUTION_URL` and `NUXT_EVOLUTION_ADMIN_KEY` unset there is no
default server, and supplying one becomes required to create a WhatsApp
connection. Everything else in the app still works.

Server URLs are compared by origin, so a trailing slash on `NUXT_EVOLUTION_URL`
does not reclassify this deployment's own connections as bring-your-own. If a
connection's server has no global key available any more — the variables were
unset, or the row no longer matches the configured server — deleting it still
removes the row and its tokens, and logs the instance left behind on that server.

## ⚠️ WhatsApp pairing burns a real phone number

Scanning the QR binds a real WhatsApp account to an instance. WhatsApp rate-limits
and can ban numbers that pair and unpair repeatedly, or that send unsolicited
messages from a freshly-paired session. **Use a spare SIM, not your primary
number**, and keep test traffic to conversations you control.

Routine restarts must never use `docker compose down -v` — see [Self-hosting](self-hosting.md).
