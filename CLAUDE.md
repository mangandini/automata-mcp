> **Antes de explorar código, lee `CODEMAP.md`** (mapa de archivos + recetas). Para despliegue/Coolify/incidentes, lee `OPS.md`. Mejoras de tools MCP: `docs/mcp-roadmap.md`. Luego solo la sección relevante de este archivo.

# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repo.

## What this is

One Nuxt/Nitro server, two surfaces:

1. **Web UI** — users create *connections*, mint connector tokens for them. Session cookie.
2. **MCP endpoint** — Claude connects to `/mcp` as custom connector. App-minted bearer token.

Connection = row in `instances` with `kind`; connector token bound to exactly one row. Four kinds:

- **`whatsapp`** — [Evolution API](https://doc.evolution-api.com/) instance, paired by QR, on deployment's configured Evolution server *or* user-supplied one.
- **`postgres`** — user-supplied PostgreSQL DSN.
- **`telegram`** — personal Telegram account linked by QR through `apps/telegram-bridge`, deployment's own bridge *or* user-supplied one. See "Telegram bridge".
- **`imap`** — user-supplied IMAP mailbox, username + app password. Read-only. Headers synced, bodies and attachments fetched live. See "IMAP connections".

`kind` read through `instanceKind()` in `mcp-scope.ts`. Column `NOT NULL` with `CHECK`, but function still refuses value running build doesn't know rather than serving it as WhatsApp — rollback after migration added a kind leaves such rows. Every per-kind branch = `switch` ending in `assertNever` (`shared/connection.ts`), never `if … else`, so adding kind fails to compile everywhere not yet decided.

App's own data (users, sessions, organizations, connections + credentials, tokens) in Postgres, `app` schema migrated at boot — `NUXT_DATABASE_URL`, required. Same Postgres Evolution writes into (`public`) and Telegram bridge uses (`telegram`); that Postgres is only compose service not behind profile. Evolution API + its Redis needed **only for WhatsApp connections** — behind `whatsapp` compose profile; `NUXT_EVOLUTION_*` vars optional.

`README.md` = public landing page (logo, links, screenshots, features, quick start) — keep short. Operator's manual lives in `docs/`: `self-hosting.md` (root `docker-compose.yml` + `.env.selfhost.example`, published images), `deploy-railway.md`, `development.md` (local setup, networking tables, Linux firewall rule), `whatsapp.md`, `telegram.md`, `postgres.md`, `imap.md`, `alerts.md`, `using-automata.md`, `releases.md`. Read before anything involving Docker or local stack; this file covers code. Two compose files: `docker-compose.dev.yml` = services only for dev; `docker-compose.yml` = full self-host stack, separate project name `automata`. Third self-host path: `docker/aio/` = all-in-one image, everything in one container — see "All-in-one image".

**Status:** product loop works end to end for all four kinds — sign up (creates organization), invite colleagues, create connection, pair by QR (importing number's WhatsApp history as it connects), link Telegram by QR, or paste DSN, per-connection dashboard, assign connections to members, connector token provisioning with per-chat, per-folder or per-table scoping. Twenty-one MCP tools, gated by kind:

- `whatsapp`: `get-connection-status`, `list-chats`, `read-messages`, `search-messages`, `send-text-message`
- `telegram`: `get-telegram-status`, `list-telegram-chats`, `read-telegram-messages`, `search-telegram-messages`, `send-telegram-message`
- `postgres` (the `sql/` group): `get-database-info`, `list-tables`, `describe-table`, `run-query`, `run-statement` (write)
- `imap`: `get-mailbox-status`, `list-mail-folders`, `list-emails`, `search-emails`, `read-email`, `get-email-attachment` (all read)

WhatsApp or Telegram connection that drops emails everyone who can reach it, emails again on recovery — see "Disconnect alerts".

Organization may hold **several** connections of any kind. Each = row in `instances`, owned by organization not person; each MCP token bound to exactly one, issued to exactly one member. See "Organizations and roles".

## Commands

Package manager **pnpm**, pinned `pnpm@11.22.0` via `packageManager`. No npm/yarn.

Run from repo root — root scripts delegate with `pnpm --filter web`:

```bash
pnpm install          # postinstall runs `nuxt prepare` in apps/web
pnpm services:up      # postgres only (compose)
pnpm services:up:whatsapp   # + redis, evolution
pnpm services:up:telegram   # + telegram-bridge
pnpm bridge:dev       # the Telegram bridge on the host, http://localhost:8095
pnpm bridge:typecheck # the bridge; `pnpm typecheck` does not cover it
pnpm dev              # Nuxt on the host, http://localhost:3000
pnpm typecheck        # nuxt typecheck across app + server
pnpm build            # production build -> apps/web/.output/
pnpm services:down / :logs / :ps
```

Nuxt deliberately **not** in compose (HMR); no `predev` hook — bring services up yourself. No lint config, **no test framework**; `pnpm typecheck` + `pnpm bridge:typecheck` only automated checks.

## Environment

One `.env` at repo root serves all. Compose reads by adjacency; Nuxt reads because every `apps/web` script passes `--dotenv ../../.env`. `.env.example` documents every var.

Nuxt overrides `runtimeConfig` only from `NUXT_`-prefixed vars, so some values duplicated under two names (`WEBHOOK_URL` for compose, `NUXT_WEBHOOK_URL` for Nuxt) — **keep pair in sync**. That pair = only dev/prod difference; no environment branch in code.

## Layout

```
apps/web/                    Nuxt 4 app. srcDir = app/. Own Dockerfile (context = repo root).
  app/pages/                 login, signup, no-organization, team, profile, invite/[code],
                             instances/{index,new,[id]}
  app/components/            app components + ui/ (shadcn-vue, bare names)
  app/composables/           useSession (user + org + role), useOrg, useConnectionState,
                             useReconnect, useTablePage, useTokenScope, …
  app/middleware/            auth.global.ts — session + organization gate
  modules/mcp-token-route.ts local Nuxt module — registers /mcp/:token
  server/api/                auth/, org/, invites/, instances/, tokens/, telegram/,
                             webhook/
  server/mcp/index.ts        default MCP handler (auth middleware)
  server/mcp/tools/<group>/   one file per tool, auto-discovered. A group is
                              usually a kind; `sql/` is the exception and serves
                              every SQL kind. `defineKindTool` is what gates a
                              tool, not the directory
  server/db/migrations.ts    the app schema — append-only, applied at boot
  server/utils/              app-db, account, session, org, invites,
                             mcp-auth, instances, tokens, evolution, evolution-db,
                             mentions, redact, net-guard, keyed-resource,
                             db-rows, sql-engine, pg-pool, pg-guard,
                             pg-run, pg-catalog, chats, alerts, mailer,
                             mcp-kind-tool, telegram, telegram-db,
                             telegram-instances, imap-client, imap-sync, imap-db,
                             mail-format, mfa, totp, webauthn, …
  shared/connection.ts       InstanceKind, assertNever — imported as #shared
apps/telegram-bridge/        Telegram MTProto service (teleproto). Own Dockerfile,
                             `telegram` schema of the shared Postgres. See "Telegram bridge".
docker-compose.dev.yml       services only, NOT Nuxt
docker/aio/                  all-in-one image: Dockerfile + rootfs/ (s6 service tree,
                             automata-env). See "All-in-one image".
```

Aliases resolve relative to `apps/web` (Nuxt root), not repo root: `~`/`@` → `apps/web/app/`, `~~`/`@@` → `apps/web/`, `#shared` → `apps/web/shared/`. `apps/web/tsconfig.json` holds no compiler options — only references four generated `.nuxt/tsconfig.*.json` projects. Never hand-edit `.nuxt/`.

## The auth split (load-bearing)

Two surfaces have **entirely separate** credential paths; no shared "get current user" helper. Central invariant — don't collapse it.

| | Web UI | MCP |
|---|---|---|
| Credential | Session cookie (`automata_session`, `httpOnly`) | `Authorization: Bearer` or `/mcp/<token>` |
| Resolved by | `server/middleware/session.ts` → `utils/session.ts` | `server/mcp/index.ts` → `utils/mcp-auth.ts` |
| Context key | `event.context.user` | `event.context.mcpAuth` |
| Backend client | `evolutionClientForInstance(instance)` / `pgFor(instance)` | `useEvolutionClient()` / `pgFor(instance)` |
| On failure | 401 JSON | 401 **+ `WWW-Authenticate`**, JSON-RPC shaped |

Three things enforce it:

- `server/middleware/session.ts` returns early on any `/mcp*` path, so cookies never parsed there. Without early return, browser signed into app could authenticate MCP tool call with cookie.
- `useEvolutionClient()` reads `event.context.mcpAuth`, no branch reaching session user; throws 401 if key absent, again if connection not WhatsApp.
- MCP tokens minted by this app (`wamcp_` + 32 random bytes), stored **only** as SHA-256 hash in `app.mcp_tokens`. Browser sessions same: cookie = 32 random bytes, `app.sessions` holds only hash. Token resolves to one `instances` row, which carries that account's Evolution token.

`McpAuth` = **union discriminated on `kind`** — `{ kind: 'whatsapp', evolution }`, `{ kind: 'telegram', telegram }` or `{ kind: 'postgres' }`. Union not optional fields, so handler reaching for `evolution` must first establish it's WhatsApp. Postgres carries no credential object: DSN lives on instance row, `pgFor()` only reader; copying into request context = second live copy of user's DB password for nothing.

**Failure-mode semantics matter:** DB outage answers **503**, never 401. 401 tells client credential bad — MCP client discards token it should keep, browser user silently signed out mid-outage. Both surfaces distinguish: `resolveMcpAuth` and `getSessionUser` return `undefined` (→ 401) only when query ran and found no usable row; any thrown error → `appDbUnavailable()` (503). `checkPassword` same for login form. Preserve in any new auth code: `catch` on auth read must never produce `undefined`.

**Handled `createError` not logged by Nitro.** Only unhandled/fatal errors reach its error handler, so deliberate 503 produces response with *nothing* in server logs — outage becomes guesswork. Admin-auth and session failures log underlying cause themselves, say which of two fixes applies. Do same for any handled error operator needs to diagnose.

## Who may sign up

`server/utils/signup-policy.ts` gates every signup **without** invitation; invitation path untouched in every mode. `NUXT_SIGNUP` = `open` | `invite-only`, default `invite-only`, unknown value read as invite-only (typo must not open door). Invite-only + `NUXT_SIGNUP_CODE` set → code required, **first account included** — else whoever finds fresh public install first becomes admin. Invite-only, no code → first account on empty DB only, decided by `claimFirstAccount()` *inside* signup transaction under `pg_advisory_xact_lock`, so two racing first signups can't both win; read failure = 503, never allow. Wrong code throttled per IP (`login-throttle.ts`, `signup-ip:` key) and logged. `/api/auth/signup-policy` tells UI `open` / `code` / `closed`, never the code. Why it matters: every self-signup = new org admin on our Evolution and bridge, and with `NUXT_ALLOW_PRIVATE_TARGETS` a stranger's DSN reaches the private network.

## Email verification

`server/utils/email-verification.ts` = one file minting, resolving, spending. Covers self-signup, invited signup (holding forwarded link ≠ holding inbox), profile email change. `NUXT_EMAIL_VERIFICATION` = `auto` | `required` | `off`, default `auto` = on iff `NUXT_SMTP_HOST` set; unknown value read as `required`. `required` without SMTP → 503 + log, never unverified account.

**Signup has no `app.users` row until verified.** Pending signup = row in `app.email_verifications` carrying finished password hash, invite id, `first_account_only`; holds **no** unique claim on address, so several may name one, first to verify wins (`createUser` 409 for rest). That *is* the anti-squatting property — never add `email_verified` column on users with unverified rows taking the unique index. Same transaction as unverified signup runs at verify time (`claimFirstAccount`, `createUser`, org or invite acceptance), with row's `DELETE … RETURNING` as first statement, so spend rolls back with failure and two verifies of one row can't both win. Invitation re-read at verify — may be revoked meanwhile. Permanent refusal (409/422/403) deletes row.

Rules easy to undo:

- **Link built from `NUXT_PUBLIC_APP_URL` only**, never request origin — `Host` is requester's choice, link pointing there hands them token. Unset → mail carries code only. (`inviteUrl` does fall back to request origin; harmless there since link shown to admin who made it.)
- **Link spent only by POST** (`/api/auth/verify/link`, Confirm button on `/verify-email`), never on GET/page load — mail scanners open links.
- **Link proves address, signs in only browser holding that row's `automata_verify` cookie** (`pending_hash` returned by spend, compared in `complete()`). Any other browser: account created, answer `signedIn: false`, page sends to `/login`; its own unrelated verify cookie left alone. Else stranger signs up with own mailbox, forwards link, victim pressing Confirm is signed into stranger's org — every connection they set up lands there. Confirm screen names address first via `link-info` (POST, never spends).
- **Code bound to `automata_verify` cookie** (path `/api/auth/verify`, so `/verify-email` page fetches pending row client-side only — SSR request never carries it). Five wrong codes delete row; resend rotates code + link but resets **neither** attempts nor expiry.
- **Signup answer identical whether address registered.** Registered address gets "you already have an account" mail instead of code — no enumeration through signup form.
- **Wrong codes also capped per address, across all rows and clients** (`assertVerifyCodeAllowed` in `login-throttle.ts`, 10 per 15 min). Per-row five resets with every new signup for the address, so per-row alone = unbounded guessing. Locks **code only** — never put it on link path, link is owner's way out — and checked before any write so locked address can't burn owner's row. Never replace with per-address mail cap: that withholds mail itself.
- **Mail cooldown keyed on client IP + address, never address alone** — else stranger resubmitting victim's address each minute keeps owner from ever getting code: squatting moved into throttle. Per-IP hourly cap bounds flooding.
- **Email change: old address stays sign-in until confirmed**; one pending change per account; taken-address check runs first (signed-in user, 409 fine); old address mailed notice on success.
- Mail send failing deletes row and answers 503 — pending signup nobody can finish worse than error.

Existing accounts never asked to verify; mode `off` keeps old password-only email change.

## Two-factor sign-in

Web UI only — MCP tokens untouched, auth split intact. Opt-in per user: TOTP (`totp.ts`, hand-rolled RFC 6238 on `node:crypto`, verified against Appendix B vectors) and WebAuthn passkeys/security keys (`webauthn.ts`, `@simplewebauthn/server`), plus recovery codes. Passkey = **second factor only**, never passwordless. `docs/two-factor.md` = operator side.

**Row in `app.sessions` means fully signed in.** Password-OK-factor-owed sign-in = row in `app.mfa_challenges` + `automata_mfa` cookie scoped to `/api/auth/login`; becomes session only via `finishLoginChallenge()`. So `getSessionUser`, session middleware, every `requireSessionUser` caller unchanged and can't be handed half-finished login. Never add "mfa pending" flag to sessions — every reader of sessions would have to remember to check it.

Rules easy to undo:

- **`login.post.ts` fails closed.** Factor read throwing = 503, never fall through to `startSession` — that signs 2FA account in on password alone. Challenge lookup throwing = 503 (`resolveLoginChallenge`), same rule as `getSessionUser`.
- **Every single-use thing spent by conditional write**, so racing duplicates can't both pass: TOTP `last_step` moves forward only (`UPDATE … WHERE last_step < step`) = replay guard; recovery code `WHERE used_at IS NULL`; passkey prompt challenge nulled `WHERE webauthn_challenge = expected` *before* verifying; login challenge deleted `RETURNING` before `startSession`; attempt claimed `WHERE attempts < 5` *before* answer checked (`claimLoginAttempt`) — counting after check let parallel burst all read `attempts = 0`. Five answers spend challenge → password again. One live login challenge per user: `startLoginChallenge` deletes others under user row lock, else K password logins = K×5 guesses. In-memory per-account throttle (`claimAuthAttempt`, checked and counted with no `await` between, success forgiven) = speed bump only, like invite mail.
- **Adding a factor needs current password, not just removing.** Stolen session enrolling attacker's authenticator locks owner out. First factor (decided under `lockUserFactors` row lock, so two enrolments agree) mints recovery codes and calls `endOtherSessions`; last factor removed deletes recovery codes in same transaction. Recovery codes alone ≠ factor.
- **RP ID and origin from `NUXT_PUBLIC_APP_URL`, never request `Host`.** Unset → passkey routes 501, UI hides them. Domain change kills every passkey; TOTP survives.
- **Passkey and registration challenges in DB** (`mfa_challenges.purpose`), not memory — second replica must finish what first started.

TOTP secret = plain column, same trade as `instances` credentials. Recovery codes 60-bit random, stored SHA-256 (fast hash fine at that entropy).

## MCP wiring

Built on `@nuxtjs/mcp-toolkit` (**pinned to 0.19.0**). Auto-imports `defineMcpHandler` / `defineMcpTool`, configures server via `mcp` key in `nuxt.config.ts`.

**Adding tool:** drop file in `apps/web/server/mcp/tools/<group>/` — discovery automatic + recursive, no registration — define with `defineKindTool` from `server/utils/mcp-kind-tool.ts`, never `defineMcpTool` directly. Every tool: explicit `name`, `title` (shown in client UI), `description` written for model, accurate `readOnlyHint` / `destructiveHint`. Copy `whatsapp/get-connection-status.ts` (read) or `sql/run-statement.ts` (write).

**Every tool gated on kind and scope.** `isToolAllowed(event, name, kind)` checks both, both fail closed. Kind half not decoration: Postgres token minted with `all_tools` would otherwise register `send-text-message`, whose handler calls `useEvolutionClient()` on row with no Evolution credentials. Which tools *exist* = property of connection; which token may call = property of token; only order that composes.

**Tool declares one kind or several.** `defineKindTool`'s `kind` takes array for tool whose meaning genuinely identical across engines — `sql/` set, whose arguments and promises don't change with engine, because `sql-engine.ts` absorbs difference and per-kind `instructions` carry what model needs. **Not** the way to share tool whose arguments differ: why Telegram has `read-telegram-messages` rather than second kind on `read-messages`; reasoning stands. Multi-kind tool must state `group` explicitly — no single kind to infer from.

**`group` no longer names kind; nothing may assume it does.** Only directory label — `sql/` serves every SQL kind. Tool→kinds mapping lives in `TOOL_KINDS` in `mcp-kind-tool.ts`, written by same call installing `enabled` gate, read via `kindsForTool()` / `toolServesKind()`. `api/instances/[id]/mcp-tools.get.ts` is one consumer, must keep using that not `group`: it renders scope picker; picker matching nothing offers no tools → mints token that can call none.

Four facts about discovery, verified against 0.19.0, not worth rediscovering:

- **Tool name comes from file basename, never directory.** `_meta.filename` set with `path.split('/').pop()` (`loaders/utils.js:94-96`); fallback in `definitions/utils.js:13-16` kebab-cases only that. Moving tool between group dirs can't rename it — what made `tools/` → `tools/whatsapp/` move safe, later `tools/postgres/` → `tools/sql/`, for every `tool_names` row already minted. Every tool sets `name` explicitly anyway.
- **`group` = exactly directory segment** (`loaders/utils.js:167-178`), read back as `def.group ?? def._meta?.group`. Used only by `filterRawDefinitions` (`definitions/listings.js:29-32`) when caller passes explicit group filter — app never does — and as `_meta` on listing. Cosmetic here; makes non-kind group safe.
- **Basename collisions global, not per-group.** `loaders/index.js:19-34` only warns, then `McpServer.registerTool` throws on duplicate. Keep every basename unique across groups. (One shared file for several kinds satisfies this — other reason `sql/` is one dir not two.)
- **`filterByEnabled` runs before registration** (`utils.js:36` then `:73`), so tool disabled for request never registered. Makes kind gate real enforcement, not hiding.

**`enabled` evaluated twice per request per tool** — once in `filterRawDefinitions` via `handler.js:12`, again in toolkit's own `filterByEnabled` (`utils.js:17-24`). Keep it synchronous property read.

**Per-kind `instructions` cannot be getter, non-obvious.** `createMcpHandler` calls `resolveConfig(config, event)` as *first* statement (`utils.js:195`), reaches auth middleware only at `:208`, so anything read off handler object — getter included — fires before `event.context.mcpAuth` exists, would serve one kind's prose to other every request. Working seam: `mcp:config:resolved` Nitro hook at `:203`, fires inside `next()` on object handed to `createMcpServer`; `server/plugins/mcp-instructions.ts` uses it. `mcp.name` genuinely can't vary — read in same too-early pass. `nuxt.config`'s `instructions` stays WhatsApp text so regression degrades to today's behaviour; toolkit logs throwing hook rather than swallowing. Hook type declared locally in `server/types/mcp-hooks.d.ts` because toolkit ships augmentation outside its `exports` map. **Toolkit bump = re-check that ordering.**

**Reactions excluded from reads and searches by default.** Evolution stores every 👍 as ordinary `Message` row — own id, author, timestamp, type, to carry one emoji — so in active group they're large share of page, rarely help reconstruct conversation. `read-messages` and `search-messages` both take `includeReactions`, default `false`, both say `reactionsExcluded: true` in response when omitted; page silently dropping message class reads as "nobody reacted". Both exclude in SQL, on **payload** — `message->'reactionMessage' IS NULL` — never on `messageType`, because `messageType` is Baileys' `getContentType()` verbatim: returns *first* `conversation`/`*Message` key, so reaction arriving with `messageContextInfo` typed as that. Payload = authority; type = hint. `searchMessages()`' `COALESCE` also carries `reactionMessage->>'text'` arm — before it, reaction had no `body` and `body IS NOT NULL` dropped it silently, not by decision.

**Control records dropped; edits not.** Three types arrive with nothing readable where extractors look, need three answers — `classifyContent()` in `chats.ts` gives them. `protocolMessage` = WhatsApp control plane (deletions, disappearing-message timers, key exchanges, history-sync notifications): dropped, **counted** as `protocolMessagesExcluded` on `MessagePage` and in `read-messages` envelope, because page quietly losing row class reads as complete. Exception: `type: 14` (MESSAGE_EDIT), nests whole `editedMessage` — unwrapped and kept, `editOf` naming replaced message. Keeping it not nicety: Evolution's live path skips every top-level `protocolMessage` (`baileys.service.ts` checks `received.message.protocolMessage` and `continue`s before insert), so these rows exist only from history sync, where nothing patches original — edit row = *only* copy of new text. `associatedChildMessage` not noise: it's `FutureProofMessage`, transparent `{ message: Message }` wrapper official clients use for album media and caption edits, so **unwrapped, never filtered** — filtering deletes real messages. `secretEncryptedMessage` = *encrypted edit* (`SecretEncType`: `EVENT_EDIT=1`, `MESSAGE_EDIT=2`), not view-once, not disappearing; kept with no `text` and `unreadable: 'encrypted-edit'`, because caller told only "encrypted" reports wrong gap. Decryption out of scope — key derives from *original* message's `messageContextInfo.messageSecret`, which row doesn't carry; neither Baileys rc.9 nor Evolution 2.3.7 attempts it.

Four easy-to-break-later points. **`protocolMessage.type` is integer, absent means REVOKE** — proto3 omits zero, so deletion arrives with no `type`; reading as "unknown, keep" surfaces every deletion as empty message — the bug this fixes. Same trap in `secretEncType`, why `UnreadableReason` has second `'encrypted-content'` value rather than asserting edit it can't show. **None of it can move into `where.messageType`**: column carries no subtype, so excluding `protocolMessage` upstream deletes every edit with bookkeeping, and `associatedChildMessage` must be kept — so drop is local, `total` (and `totalMatching`) overcounts by dropped amount, count reported not subtracted. Subtracting right for one page, confidently wrong across range. **`hasMore` still counted on `records`**, before reaction and control-record filters, else bookkeeping-heavy page reads as end of conversation. In `searchMessages()` nested `COALESCE` arms name **explicit paths only** — `$.**` recursive jsonb path would match `contextInfo.quotedMessage.conversation`, making reply findable by quoted text = misattribution by construction.

Deliberate non-goals, not oversights: deletion dropped like any control record, not surfaced as "retracted" (original row stays with text, nothing marks it); `ephemeralMessage` and `viewOnceMessage*` family *not* unwrapped — flattening view-once photo to bare `[image]` presents it as ordinary photo; honest version needs own marker; album items surfaced individually, not grouped by `messageContextInfo.messageAssociation.parentMessageKey`.

**Tools take no connection argument.** Token bound to one instance, so `useMcpAuth()`, `useEvolutionClient()` and `pgFor()` already resolve to it. Instance param would reintroduce addressing wrong number — now wrong database. Never accept Evolution API key or DSN as tool argument.

**`nitro.experimental.asyncContext: true` required — don't turn off.** MCP SDK invokes tool handlers with its `RequestHandlerExtra`, not H3 event, so `useEvent()` only way to reach per-request credentials; needs async context.

**`modules/mcp-token-route.ts` deliberately fragile.** Deep-resolves file inside `@nuxtjs/mcp-toolkit` not in package's `exports` map, to register `/mcp/:token` against same handler (Claude and other clients can't attach `Authorization` header to custom connector). Middleware URL rewrite doesn't work — h3 1.15.x re-assigns `event._path` before every layer. If toolkit upgrade moves that file, module throws at build with pointer to documented fallback. Toolkit bump = re-verify this module.

**Token redaction:** `server/plugins/redact-mcp.ts` scrubs `event.node.req.originalUrl` (what Nitro's error handler reads — scrubbing `event.path` alone insufficient) and sets `event.context.noLog`. `mcp.logging` off for same reason. Route any added error reporter/logger through `redactPath` / `redactHeaders` in `server/utils/redact.ts`.

## Credential rules that are easy to break later

**No global-key fallback in per-instance credentials.** `credentialsForInstance()` returns `undefined` when instance has no `api_key`; callers must fail. Global-key fallback hands any MCP token holder *every* account on that Evolution server. Global keys have exactly two callers, both in `server/utils/instances.ts`: create and delete.

Sharper edge now: global key can sit **on instance row itself** — `instances.admin_key` holds key for bring-your-own Evolution server. `credentialsForInstance()` must never read it; why param typed `Pick<AppInstance, 'base_url' | 'api_key'>` — field not even in scope.

**Config global key used only against config URL; user's key only against their own URL.** `evolutionAdminCredentials()` returns `undefined` for half a bring-your-own config rather than completing it from ours. Our global key to user-chosen server hands them every account on ours; their key to our URL = probe of ours. Neither is fallback; no branch produces either pairing.

**User-supplied hosts go through `server/utils/net-guard.ts`.** DSN or Evolution URL = outbound connection to user-chosen address; `postgres://…@postgres:5432/evolution` pasted into create form reaches Evolution's own DB — every user's messages. Two checks: address class (loopback, RFC1918, CGNAT, link-local, NAT64, `::ffff:` v4-mapped), disableable via `NUXT_ALLOW_PRIVATE_TARGETS` since single-tenant self-hosted needs it; and deployment's own backends, resolved from config, matched on `address:port`, never disabled — still stops `postgres:5432` when first check off. Opt-out deployment-wide, must stay so — per-connection checkbox lets any user disable guard for themselves = whole attack.

Only Postgres **pins** approved address (`postgres({ host })`, driver never resolves name itself). Evolution path re-checks before every request but can't pin, because `$fetch` resolves DNS itself; closing window needs undici `Agent` with `connect` hook, and `undici` not direct dependency. Residual rebinding window documented at call site in `evolution.ts` — don't delete note without closing hole.

**Secrets on `instances` are plain columns, not encrypted.** `api_key`, `admin_key`, `dsn`, `evolution_db_url`, `telegram_db_url`, `imap_password` never leave server — `toPublicInstance()` only projection UI receives — sit in clear in DB and every backup. `NUXT_DATABASE_URL` in `net-guard`'s own-backends list, so user DSN resolving to it refused regardless of `NUXT_ALLOW_PRIVATE_TARGETS`.

**Evolution DB connection read-only, and now only way messages are read.** `server/utils/evolution-db.ts` = one file talking to Evolution's Postgres. Began as search escape hatch — 2.3.7's `POST /chat/findMessages` accepts `where.message` and never reads it, so content search returns unfiltered page that reads as result set; that field is trap — and `read-messages` joined for second reason, below. `NUXT_EVOLUTION_DATABASE_URL` therefore **required**; no HTTP fallback; missing value announced once at startup (`server/plugins/evolution-db-check.ts`), answers 500 not 503, since retry won't fix it.

**No longer one pool; URL source = precedence rule.** Connection with own Evolution server carries own read-only URL in hidden `instances.evolution_db_url`, since its messages in *that* server's DB. `messageDbUrlFor()` only place rule lives: connection's own URL wins; else connection on deployment's own server falls back to `NUXT_EVOLUTION_DATABASE_URL`; else no answer, read refused with **501** naming missing setting, never empty page. `onDeploymentServer()` = single test for "is this our server", shared not recomputed — bring-your-own merge already produced one bug from computing it slightly differently in two places.

Pooling delegated to `keyedPool()` in `pg-pool.ts`, shared with Postgres kind, so host guard, approved-address pin, fingerprint invalidation on rotated URL, LRU ceiling exist once. **`guard` flag asymmetric on purpose:** `true` for anything user typed, `false` *only* for `NUXT_EVOLUTION_DATABASE_URL`, which sits on our private network and `net-guard` would correctly refuse as own infra. Backwards either breaks default deployment or opens hole guard exists to close.

`probePgConnection(url, { requireTable: '"Message"' })` proves user URL before storing. `requireTable` half not belt-and-braces: URL with right host/user/password but wrong *database* connects fine then matches no rows, reads as account with no messages — same silent-empty answer this exists to prevent, one layer down.

Connection far wider than anything else app holds (every user's messages, every instance — for user's own server, every account on it, possibly not theirs if shared), so four things load-bearing: module issues only fixed, parameterised `SELECT`s, never writes or DDL; every query carries `"instanceId" = <this account>`, which neither `searchMessages()` nor `listMessagesPage()` can be called without; chat scope = **predicate in SQL**, not post-read filter; module returns rows, never rendered messages — naming sender and previewing payload belong to `chats.ts`, keeps import one-directional. `resolveEvolutionInstanceId()` throws rather than query without id — `createInstance()` can store `''`; empty id = query with no account predicate.

**Credential not assumed narrow.** Default deployment (and Railway template) points `NUXT_EVOLUTION_DATABASE_URL` at DB owner, same URL as `NUXT_DATABASE_URL`, since one-click deploy can't run `GRANT`s for dedicated role. Deliberate trade: web process already holds owner credential, so SELECT-only `wamcp_search` role only contains bug in this module's own queries — `docs/whatsapp.md` keeps it as optional hardening. Backstop instead: `readOnly: true` on pool (`KeyedPoolOptions` in `pg-pool.ts`), opens every session with `default_transaction_read_only`, so write fails 25006 even under superuser. Superuser can turn off, but only via SQL — why first load-bearing rule above = real control: no `.unsafe()`, no string-built SQL, nothing caller sends reaching this connection as text. `telegram-db.ts` passes `readOnly` same reason; Postgres connection kind never does, since `run-statement` must write.

**One message stored more than once; app must collapse.** 2.3.7 dedupes history import against in-memory `Set` of `key.id` rebuilt from DB at top of each `messaging-history.set`; `createMany` behind it passes `skipDuplicates` — inert, since only unique constraint on `Message` is `@default(cuid())` PK that never collides. Nothing in schema stops second write, so two batches in flight, or import racing live traffic, both insert; `enableFullHistorySync()` puts them in flight. Copies disagree about sender, each carrying whatever `pushName` was on wire — real name, bare LID, LID JID, or sender's device-locale self-label (`Você`). Raw, one message reads as three from three people, range reports triple size, pages ragged. Collapsing after can't fix: `skip`/`take` applied upstream to duplicate rows, page boundaries already wrong. Hence `DISTINCT ON (m.key->>'id')` inside CTE with `LIMIT`/`OFFSET` outside, on **both** queries. `bestNamed()` picks surviving copy, must stay deterministic — else identical second call returns different author.

## Postgres connections: what the allowlist does and does not close

`pg-pool.ts` connects, `pg-guard.ts` decides what statement may touch, `pg-run.ts` composes both, `pg-catalog.ts` introspects. Honest summary, belongs before every change here: **table allowlist keeps model inside tables it was pointed at; security boundary = DB role on DSN.** `docs/postgres.md` carries `GRANT` recipe.

**`sql-engine.ts` = seam in front of all four**, dispatch functions over `switch … assertNever`, not adapter interface. Reason is this section: interface makes each method's doc comment union of every engine's contract and hides guard reasoning behind boundary where call-site reader can't see which checks ran — argument below written for Postgres, can't be written once for two engines. Second engine gets own guard module, own composition function with own header; differences told to model via per-kind `instructions`, not hidden behind shared tool name. `sqlKindOf()` follows `alertableKind()` in `alerts.ts`, repo idiom for "kinds sharing a capability".

**Four checks, each closes something obvious design leaves open.** All verified on Postgres 16.

1. **One statement, enforced by protocol.** `sql.unsafe(text)` with no params defaults `simple: true` (`postgres/src/index.js:119-126`) — *simple* query protocol, runs everything after semicolon: `SELECT 1; DROP TABLE t` executes both. `unsafeSingle()` forces extended protocol, where Postgres answers 42601 to second statement. Exists as one function so no call site writes options inline and sits one `simple` away from bypass. `simple` honoured at runtime but missing from postgres.js's `UnsafeQueryOptions`, hence cast.
2. **`DECLARE CURSOR` = statement-kind gate for reads,** not `SELECT * FROM (…) LIMIT n` wrap. Grammar refuses `INSERT`/`UPDATE`/`DELETE`/`CREATE TABLE AS` outright, refuses `SELECT … INTO` by name, answers 0A000 to data-modifying `WITH`. `FETCH FORWARD n+1` = row cap; paging = `MOVE FORWARD (page-1)*n` on same cursor — never `OFFSET` wrap, reasons below. Wrap would break on trailing line comment and duplicate output column names — and miss shapes in (3).
3. **Plan inspection, four traps.** `EXPLAIN (FORMAT JSON, VERBOSE)`, walking *every* element of top-level array since rewriter emits one per rule.
   - `VERBOSE` **mandatory**: without it `ModifyTable` carries `Relation Name`, no `Schema`. Relation with no schema refused, never assumed `public`.
   - Key strictly on `Relation Name`. `Function Scan` node carries `Schema` and `Function Name` but no relation, so collecting `Schema` opportunistically fabricates pairs.
   - **`CREATE TABLE AS` and `SELECT … INTO` plan to bare `Result` node with no target relation; `REFRESH MATERIALIZED VIEW` answers literal string `"Utility Statement"` with no `Plan` key.** Relations-only check reads all three as "touches nothing". Hence: every top-level element must be object with `Plan`; write must have `ModifyTable` **root** with `Operation ∈ {Insert, Update, Delete, Merge}`.
   - **Partitioned table never surfaces parent** — `SELECT` on `public.t` plans as `Append` over `t_p1`, `t_p2`. Allowlist expanded *downward* through `pg_inherits`; expanding can't admit sibling, mapping plan upward could. Correctness bug that reads to user as security bug.
4. **Function gate.** `SELECT pg_read_file('/etc/passwd')` plans to `Result` node with **zero relations**, as does any call into plpgsql body — relations alone don't contain query. Function names collected from plan's expression strings (heuristic erring toward refusal; names resolving to nothing ignored), resolved against `pg_proc`; anything outside `pg_catalog`, anything `prosecdef`, and denylist of reaching builtins refused.

**One transaction, not two.** Plan check and execution share it, so EXPLAIN's `AccessShareLock` still held when statement runs — stops concurrent `CREATE OR REPLACE VIEW` repointing view between check and execution — and both under one `SET LOCAL`, so same text provably resolves to same objects. Reads use `sql.begin('read only', …)`; `CREATE TEMP TABLE` inside fails 25006, last line of defence beneath other three.

**`SET LOCAL` goes through `set_config(name, value, true)` as bind params.** `value` is plain `text` param, nothing interpolated. Literal `SET LOCAL search_path = …` = string-built DDL over user-chosen schema names.

**`search_path` pinned but not the control.** Plan reports every schema fully resolved regardless of path. Pinning buys: check and execution agree, and unqualified name lands inside allowlist rather than resolving elsewhere and being refused confusingly.

**Never `EXPLAIN ANALYZE`.** Executes everything, triggers included. Plain `EXPLAIN` doesn't — `EXPLAIN (FORMAT JSON) SELECT pg_sleep(3)` returns in 50 ms.

**Table names matched case-sensitively, both halves.** Postgres folds *unquoted* identifiers when parsing but stores what was created — Evolution's tables are `public.Message` and `public.Chat`. Folding refuses legitimately allowlisted table; loosening lets `public.orders` match different `public.Orders`.

**Scope = predicate in SQL, never post-filter** — `listPgTables` puts allowlist in `WHERE`, `describePgTable` in anchor CTE. Same rule as chat scope; why `hasMore` means "more tables you can see" not "more rows we hid".

**`describe-table` answers both FK directions, filtered differently on purpose.** `foreignKeys` (declared *on* table) lists every key incl. ones pointing outside allowlist, flagged `reachable: false` — referenced name already in `pg_get_constraintdef` text this tool always returned, so nothing new disclosed and model spared a refusing `describe-table`. `referencedBy` (declared on *other* tables, pointing here) lists only reachable, since out-of-scope row = table name token never granted, leaked by describing one it was; instead reports `referencedByOutOfScope`, a count. Counted not silent, same reason `protocolMessagesExcluded` exists: "nothing references this" ≠ "I may not tell you what does". `reachable` = allowlist predicate **and** `has_table_privilege`, since granted name role can't `SELECT` still not reachable — verified against least-privilege reader, deployment `docs/postgres.md`'s `GRANT` recipe produces.

Three more things `describe-table` reads that obvious query misses. **CHECK constraints = column's value domain** as much as enum — `CHECK (status IN ('open','closed','void'))` on `text` column — so `contype` collects `c` alongside `p` and `u`; filter on value outside returns no rows, reads as empty result not mistake. **Enum column's labels three hops from `atttypid`**: type itself, array's `typelem`, or domain's `typbasetype`, since `order_status[]` and domain over `order_status` as enumerated as bare column; reading only `atttypid` reports neither. **View's `pg_get_viewdef` = its relationship docs** — view has no PK, no FKs, (unmaterialized) no indexes, so without it view describes as bag of columns joined to nothing; clipped at `MAX_VIEW_DEFINITION` since view body = arbitrary user SQL, no natural bound, and tool called before most queries. All four queries still one `Promise.all` on `target.oid`, round-trip cost unchanged.

**Deliberate holes, documented not papered over.** Triggers invisible to `EXPLAIN` without `ANALYZE`, so write to allowed table can cascade anywhere. `postgres_fdw`/`dblink` name local foreign table, not remote object. `pg_catalog` and `information_schema` stay readable, so schema names leak regardless. Superuser DSN makes all of it best-effort — `probePgConnection` detects so UI can say so.

**Pool cache keyed on connection id, not DSN.** DSN-keyed Map holds every user's DB password as live string visible in heap snapshot; id finds pool, fingerprint notices rotation. Eviction on acquire, not timer — interval outlives nothing useful in worker platform stops/starts. `onnotice` silenced since `RAISE NOTICE` in trigger can carry row data into process log, the one place this must not leak.

Mechanics now in **`keyed-resource.ts`**, engine-independent: id keying, secret fingerprint, 60s re-approval TTL, background drain on rotation, LRU sweep are all about *when* handle lives, none about protocol. `pg-pool.ts` supplies Postgres half via `build` / `destroy` / `reguard`; `keyedPool()` keeps old signature so `evolution-db.ts` and `telegram-db.ts` unaffected. **`guard` asymmetry now = presence/absence of `reguard`**, not flag cache must understand. Consequence: `MAX_POOLS` = **process-wide** budget shared across engines, not per-driver ceiling.

**`db-rows.ts` holds cell serialisation**, shared for same reason `pg-catalog.ts` shares one query between scope picker and tool listing: two same-named tools must clip at same length and lose precision same places, else caller can't carry learning across responses. Only binary label (`bytea`, `blob`) per-engine. Clipping default; `fullValues` caller's switch off — both engines honour same. Can't fix: driver returning rounded `number` for 64-bit int column already lost precision before arrival — belongs in driver options.

**DSN change doesn't invalidate tokens, on purpose.** Tokens name *connection*, not credential. Forcing reissue on password rotation = reason not to rotate.

**One DB client; no user's credential ever reaches it.** `appDb()` is pool; nothing runs query as visitor. Authorization entirely `org.ts` / `mcp-auth.ts` — no row-level rules underneath, so route forgetting `requireReadableInstance()` is open. Table names in helpers = closed union; every value bind param.

**Never normalise JIDs locally.** Evolution's `createJid` has country-specific rules (Brazil ninth digit, Mexico/Argentina prefixes). JID stored by our rules, matched by theirs = token scope silently reaching wrong chat or refusing right one. `resolveNumberToJid` in `server/utils/mcp-scope.ts` asks Evolution; storing and checking scope both go through it.

**`enabled` guards can't see tool arguments.** Receive only event, so gate whole tool — incl. by kind — but not "this tool, this chat" or "this tool, this table". Argument-dependent logic belongs in handler: every chat check, whole Postgres plan walk. See table in `mcp-scope.ts`.

**Scope columns `NOT NULL` with defaults; `scopeFields()` in `tokens.ts` still writes all six** — `all_chats`/`chat_jids`, `all_tables`/`table_names`, `all_tools`/`tool_names` — so scope edit never leaves axis stale. List columns `jsonb`, passed as plain arrays: postgres.js serialises param by server-described type, so pre-stringified value stored as JSON *string*, which `scopeFromRecord()` reads as empty list.

## History arrives once, at pairing

WhatsApp pushes burst of past conversations while device linking, never again. **No endpoint fetches history after the fact** — not here, not Evolution, not Baileys in any form working for linked device. `/chat/findMessages` reads Evolution's Postgres, not WhatsApp. Don't look for date-range import; upstream request closed unimplemented, `fetchMessageHistory` appears in Evolution only behind debug easter-egg whose result `console.log`ed and discarded.

Three preconditions, two must hold **before** QR scanned:

- `DATABASE_SAVE_DATA_HISTORIC=true` on evolution service. Evolution checks once, inside `messaging-history.set` handler, drops whole payload if false. Not one of flags covering live traffic.
- `syncFullHistory: true` in `POST /instance/create` body (`provisionInstance` in `server/utils/instances.ts`). Reaches Baileys socket config, so effective only when socket constructed.
- Genuinely fresh device link. Reconnecting existing session sends nothing.

`enableFullHistorySync()` backfills account paired before this existed: writes setting, logs instance out so next connect = new device link. Exposed at `POST /api/instances/:id/resync` behind confirm dialog, since cost = QR scan on real phone — see pairing warning below. Re-import safe: Evolution skips messages whose `key.id` it holds, merges not duplicates.

**Settings change = read-modify-write, never partial.** Evolution's `setSettings` copies every request-body field onto live instance's in-memory settings, so omitted key becomes `undefined` on running socket. Schema marks all six booleans required, types `msgCall`/`wavoipToken` as `string`, so partial body — or one echoing `null` that `settings/find` returns for unset string — = 400. `settingsBody()` in `instances.ts` handles both; use it.

**`syncFullHistory: true` also disables Evolution's group filter.** Its `shouldIgnoreJid` stops excluding `@g.us` regardless of `groupsIgnore`, so group chats sync and show in `list-chats` and token scope picker. Per-token chat scoping contains it, but wider default surface.

**Bumping pinned Evolution tag = re-verify this** — in `docker-compose*.yml` *and* as `FROM` base of `docker/aio/Dockerfile`, which also relies on its `Docker/scripts/deploy_database.sh`, `dist/main` entry and cwd-relative `instances`/`store` dirs. Specifically: `messaging-history.set` still gates on `SAVE_DATA.HISTORIC`, settings schema still requires six booleans, `syncFullHistory` still reaches socket config, `Message` still has no unique constraint on message id (if one appears, duplicates stop, dedupe becomes belt-and-braces). Also `prepareMessage` still calls `getContentType` on **un-normalized** payload, so wrapper still types own row — bump onto Baileys whose `normalizeMessageContent` unwraps `associatedChildMessage` makes local unwrap no-op rather than breaking, but paragraph above would describe something no longer happening — and `ProtocolMessage.Type.MESSAGE_EDIT` still `14` and stored as integer. Message reads no longer depend on `fetchMessages`' envelope, ordering, skip/take — SQL now — but `Message` columns still Evolution's: `key` and `message` are `JsonB NOT NULL`, `messageTimestamp` is `Int` of unix **seconds**, `contextInfo` nullable, `@@index([instanceId])` only index.

Reading back: `listMessages()` in `chats.ts` takes `{ limit, page, since, until, includeReactions }`, delegates to `listMessagesPage()` in `evolution-db.ts`. Range bounds = ordinary SQL predicates, so one-sided range = one predicate — old widening (Evolution honoured `messageTimestamp` filter only with **both** bounds) gone with HTTP path. `chats.ts` keeps shaping: `previewOf()` for payload, one name directory for authors and @-mentions.


`listAccountMessages()` = same shaping over **every** chat — dashboard message table. Reaches it by leaving `jid` off `MessagePageOptions`, now optional, adds `terms` (matched against body expression `searchMessages` uses, extracted as `messageBodyJoin` so they can't drift) and `order`. **MCP can't reach that branch:** every tool goes through `listMessages()`, which takes `remoteJid` as required positional arg, and `instanceId` unconditional in SQL either way. `listTelegramMessagesPage()` has same optional `chatId` for same caller, same reason. Names on account-wide page come from contact and group caches only — no per-group participant pass, which hundred-row page spanning hundred groups would otherwise pay.
**Page must say it is a page.** `listMessages()` returns `MessagePage` — `{ messages, hasMore, total? }` — not bare array; `read-messages` surfaces `hasMore`, `nextPage`, `covered` and `note` in words. Reads newest-first, so truncating `since`-bounded window drops **old** end: exactly part caller naming date range asked for, keeping what they'd get without asking. Bare, reads as complete window; summary from it has hole — the bug this replaced.

Two rules hold it up. `hasMore` from fetching `limit + 1` rows, **never** derived from `total`, even now `total` exact: wrong count would drive caller into paging forever; full final page merely costs one extra empty call. `read-messages` still pins `until` itself once `since` given — not because bound ignored, but unpinned upper bound moves between calls, so page 2 from different range than page 1. Pinned window echoed as `window` for next page. No range added without `since`; `Message` indexed by `instanceId` only.

`total` = `COUNT(*) OVER ()` across **deduplicated** set, same scan as page, surfaced as `totalMatching` with `totalPages`. Counts distinct messages in requested range — not rows, not chat — so quotable as answer, unlike Evolution's own count which counted every copy. Rides on returned rows, so page past end carries no count rather than zero; "didn't measure" ≠ "none". Still read defensively (finite number or dropped).

Ordering ours now; both queries end `ORDER BY "messageTimestamp" DESC, key->>'id' DESC`. Tiebreaker not decoration: Evolution's `orderBy: { messageTimestamp: 'desc' }` has none, rows sharing timestamp can land on two pages or neither. Pages 1-based, newest-first (`OFFSET (page - 1) * limit`).

**`_count.Chat` and `findChats` count different tables.** Dashboard chat stat = `_count.Chat` — rows in Evolution's `Chat` table. `listChats()` reads `findChats`, raw query `DISTINCT ON (remoteJid)` over `"Message"`. `messaging-history.set` takes `chats` and `messages` as separate arrays, writes `Chat` row for every conversation phone lists while persisting only message slice WhatsApp delivered, so listing routinely, permanently shorter. Gap not page boundary, no offset closes it: "load more" driven off subtraction fetches nothing forever. `listChats()` therefore returns `ChatPage` — `{ chats, hasMore }` — `hasMore` = `rows.length >= take`, same "page came back full" rule as `MessagePage`. Nothing may treat counts as comparable.

Paging chats real though: 2.3.7 maps `take` → `LIMIT`, `skip` → `OFFSET`, and `contactValidateSchema` sets no `additionalProperties: false`, so both survive route validator — re-verify on tag bump. Two caller consequences. Order is `updatedAt DESC`, reshuffled by live traffic, so accumulating client dedupes by JID and pages from rows *received* not *kept*. Naming rows costs Evolution's whole contact table (endpoint filters to one JID, not set), so goes through `contactDirectory()` — `fetchContacts` behind 5-minute per-account cache — not re-read per page and per mention lookup. Only *successes* cached: unlike group/participant lookups this is plain DB read answering while account disconnected, so failure = real fault to retry, not offline state to back off from. `listChats` still swallows failed **first** page — empty list honest for fresh account, must not break scope picker — but rethrows on `skip > 0`, since swallowed later page reads as end of list.


**Chat listing now walked once into cache; every caller reads pages off that.** `findChats` takes no search term, no ordering, so table searching/sorting *whole* account can't push either to Evolution. `chatListing()` in `chats.ts` walks endpoint to end (2000/page, capped 10 000 rows), names rows once, memoises **60 seconds** — TTL + in-flight dedupe + successes-only, same shape as `contactDirectory()`. `listChatsPage()` filters, sorts, slices for dashboard table; `listChats({ take, skip })` keeps old signature and return shape for scope picker and `list-chats` tool, slice of same listing. Strictly cheaper than before: naming page cost Evolution's entire contact table, paid per page while walking `skip`.

Two flags from walk, must not merge. `truncated` = cap hit — account holds more than listing will. `incomplete` (`failed` inside module) = Evolution couldn't be asked for all. Neither is `hasMore`, only "another page of what I have"; offering next page for either fetches nothing. Old first-page-swallowed/later-page-rethrown rule survives in `listChats`, which still refuses `skip > 0` on incomplete listing rather than letting short one read as end.
## Connection state lives in two places, and only one is true

`fetchInstances` returns `connectionStatus` from Evolution's **DB** row. 2.3.7 writes that column when socket opens and when it closes for reason it won't retry (`loggedOut`, `forbidden`, 402, 406) — nowhere else. Every other close takes retry path in `connectionUpdate`, touching only in-memory `stateConnection`, so if retry never opens, column says `open` forever over dead socket. Not hypothetical: production showed "Connected" for a week while every `/group/participants` call answered `428 Connection Closed`. `getInstanceStatus()` therefore takes `state` from `GET /instance/connectionState` (in-memory), only profile and counts from row, reports `unknown` — never column — when live read fails.

`sessionLost` = disagreement: column `open`, live anything else. Separates dropped session from no session, since fresh instance and logout both leave column `close` and QR on screen leaves it `connecting`. Dashboard gives it own mode with **Reconnect** button (`POST /api/instances/:id/reconnect` → `reconnectInstance()`).

Three easy-to-get-wrong points about reconnecting:

- **Call depends on live state.** `connect` rebuilds socket only in `close`; in `connecting` returns cached QR object, does nothing, so socket hung while connecting needs `restart`. In `open` neither helps even if socket dead — Baileys' `end()` returns early on socket it already closed — also why no liveness probe: could detect state, nothing could act.
- **Both routes answer 200 with `{ error: true, message }` on failure.** Resolved request ≠ success.
- **QR poll must never run against lost session.** Calls `connect`, which in `close` builds new socket every tick; aimed at instance Evolution can't recover = WhatsApp login every two seconds. `applyMode` in `InstanceWhatsapp.vue` keeps poll to pairing mode.

Reconnect not landed within a minute = Evolution's own session for account stuck — likely its serial event queue (`eventProcessingQueue`), which no API call replaces. Restarting Evolution service recovers without scan, since `setInstance` auto-connects every row whose column is `open` or `connecting`, which dropped session's column still is. UI says so rather than leaving button to be pressed forever.

`CONNECTION_UPDATE` webhooks wouldn't catch this: retry path sends none, and webhook sent from inside same queue. Re-verify all above on tag bump — column writes in `connectionUpdate`, `codesToNotReconnect`, per-state branches of `connectToWhatsapp` and `restartInstance`, `setInstance`'s auto-connect condition.

## Mentions are resolved from `contextInfo`, never from the text

WhatsApp writes @-mention as bare local part of mentioned JID; in group that JID is **LID** (`@lid`) — per-user identity, not phone number, no country code readable. Raw, reads as opaque number; model summarising thread guesses who was addressed. That guess = whole bug: confident misattribution.

`server/utils/mentions.ts` rewrites inline (`@79972425314508` → `@Ju`) on both read paths. Three supports.

**Replacement driven off `contextInfo.mentionedJid`, never `@\d+` scan.** Only strings WhatsApp marked as mentions rewritten, so order id, price, typed phone number untouched. `applyMentions` does one pass over single alternation of every resolved local part, longest first with `(?!\d)` guard — without it short LID eats front of longer one; without single pass, substituted name rewritten again by next mention.

Column rule below holds for top-level content only: message nested inside `protocolMessage.editedMessage` or `associatedChildMessage.message` never went through that rewrite, keeps own `contextInfo`, so `listMessages` falls back to payload for exactly those rows — ones classifier just surfaced first time, where column under-delivers.

**Read from `contextInfo` column, not `message`.** 2.3.7's `prepareMessage` rewrites `extendedTextMessage` into `message.conversation` and `delete`s original, so mentioning text message stores *nothing* under `message->extendedTextMessage->contextInfo` — also why it arrives with `messageType: "conversation"`. Mentions survive in dedicated `Message.contextInfo` column, both queries in `evolution-db.ts` select as `contextInfo->'mentionedJid'` — still column of `"Message"`, so inside optional `wamcp_search` grant.

**Names from group participants first, contacts second.** Evolution's `Contact` rows keyed on `key.remoteJid`, which for group message = *group's* JID — good for 1:1, poor for group members. `GET /group/participants` = authority on group membership; participant indexed under every identity it carries (`id`, `lid`, `phoneNumber`, `jid`) since which form appears in `mentionedJid` is WhatsApp's choice. Directory keyed on **local part** so either form resolves; lookup display-only — no JID constructed, nothing addresses chat by one, so "never normalise JIDs locally" rule not in play.

**Same directory names sender.** `authorName()` resolves `key.participant` through it, falls back to `pushName` only on failure — never reverse, since `pushName` = whatever sending device put on wire, two copies routinely disagree. Number or JID value refused outright: id in `author` field reads as name, gets quoted as one. Message you sent has **no author** — `fromMe` says so in field that can't contradict itself; alternative = localised self-label next to account's real name on same message. That was reported bug.

Baileys stores `participant` for group message on live and history paths, `participantAlt` (sender's other addressing form) only on live, so nothing may require alternate. 1:1 chat: no participant, chat's own JID is sender.

All best-effort, degrades to raw id: participants need live socket, so disconnected account resolves nothing, must still return messages. `read-messages` = one chat, one lookup; `search-messages` spans many, resolves from contacts first, pays for group membership only where unresolved, capped busiest-group-first. Raw id honest; wrong name = failure module exists to prevent.

## Webhooks are registered per instance, and the global one is off

`registerConnectionWebhook()` in `instances.ts` does it, at provision and every sweep. `WEBHOOK_GLOBAL_ENABLED` is `false` in `docker-compose.dev.yml` and `docker-compose.yml` and `docs/deploy-railway.md`; turning back on delivers everything twice.

Two independent reasons per-instance route works:

- **Only per-instance webhook sends custom headers.** Global sends none, so `NUXT_WEBHOOK_SECRET` couldn't be satisfied — value there made every delivery 401, which Evolution treats as non-retryable, drops. Why secret was documented "leave empty" until now, why now should be **set**.
- **Bring-your-own Evolution server has no `WEBHOOK_GLOBAL_URL` pointing here**, no reason to. Global-only = those connections deliver nothing.

Global path had second gate worth remembering if re-enabled: `WEBHOOK_GLOBAL_ENABLED` + `WEBHOOK_GLOBAL_URL` deliver nothing alone, since Evolution also checks matching `WEBHOOK_EVENTS_<EVENT>` flag, all default false.

## Disconnect alerts

`server/utils/alerts.ts` decides; `server/utils/mailer.ts` delivers, over SMTP (`NUXT_SMTP_*`).

**Recipients not new policy.** `recipientsFor()` runs `authorizesInstance()` over `listOrgMembers()` — every admin of owning org plus members connection assigned to = set that can reach it, so set it breaking matters to. Second definition of "reaches this connection" is how two drift. One message each, never one to all: colleagues, not mailing list; `to` header would disclose roster. `alerted_at` written when mail reached **anyone**, so one bad address doesn't queue repeat to everyone each sweep. Outage mail role-aware — member has no Reconnect button, never enters pairing mode, so telling them to press one reproduces in inbox exactly failure `InstanceWhatsapp.vue` avoids. Two date fields on `instances` hold state — `down_since` (empty = healthy), `alerted_at` (set = current outage reported). Dates not status field, so "healthy" = both `NULL`.

**Webhook can't be whole mechanism; sweep not backstop.** In 2.3.7 close Evolution intends to retry emits *no* `connection.update` — `connectionUpdate` rebuilds socket, returns; only non-retried close (`loggedOut`, `forbidden`, 402, 406) sends anything. So failure this feature exists for — socket died, stayed dead, the one `sessionLost` built on — invisible to webhook by construction. Five-minute `alerts:sweep` task only thing seeing it, since it does live read. Webhook re-registration = separate hourly `alerts:register-webhooks` task, so sweep can run often.

**Payload = hint; live read = fact.** Neither path reads `state` off delivery. Evolution v2 doesn't sign webhooks; with no secret, route reachable by anyone, so trusting payload lets stranger mail user that account is down. Delivery resolves instance by name, rate-limited per connection (30s), then goes through `getInstanceStatus()` like sweep.

Three rules in `evaluateConnectionHealth` easy to undo:

- **`ownerJid` absent = never paired, skipped.** Fresh connection sits in `close` until QR scanned; nothing else distinguishes it from logout — both leave column `close`.
- **Every unhealthy state serves 10-minute grace, `close` included.** Intermittent drops reported as `close` self-recover; alerting at once meant outage mail then recovery mail seconds apart. Recovery inside window clears `down_since` with no mail (nobody told it broke). Sweep every five minutes, so real outage mailed 10–15 min in.
- **`alerted_at` written only after mail actually sent.** Broken SMTP delays alert instead of losing it. Same for recovery mail clearing fields.

**Telegram goes through same function.** `readConnectionHealth()` dispatches on kind, returns one shape, so grace period, `alerted_at` bookkeeping, recipients shared; only "paired" and mail wording differ. Telegram paired = bridge's stored identity (`me`), survives dropped connection and revocation, cleared only by logout — so unlink = `knownUnlinked`, closes open outage **without** mail, since "connected again" after later re-link would describe long-over outage. Bridge that can't be asked answers `unknown` with no identity, counted as paired: that's deployment's bridge going down, worth hearing, at cost of one true-but-unneeded mail for never-linked connection. WhatsApp keeps `ownerJid`, never sets `knownUnlinked`, since unreachable Evolution also loses `ownerJid` and clearing on it would re-alert when Evolution returns.

Telegram webhook (`api/webhook/telegram.post.ts`) resolves row by `instance_id` = bridge's `sessionId` **and** `kind = 'telegram'`, same secret, cooldown, live read as Evolution's. `registerTelegramWebhook()` (`telegram-instances.ts`) runs at provision and every hourly re-registration; URL = `NUXT_TELEGRAM_WEBHOOK_URL`, else `NUXT_PUBLIC_APP_URL` + `/api/webhook/telegram`. Bridge re-sends current state on `PUT /webhook` **only when URL changes** — re-sending on every hourly re-registration would start second evaluation beside sweep's. `evaluateConnectionHealth` also shares one in-flight evaluation per connection, since webhook and sweep both reading `alerted_at` empty would both mail.

Sweep in-process, so **multiple replicas mail multiple times**. `nitro.scheduledTasks` needs `nitro.experimental.tasks`; both in `nuxt.config.ts`.

`sendAppEmail()` never throws, answers whether mail went out; with `NUXT_SMTP_HOST` unset answers false, warns once. Callers decide what "not sent" means — alert stays queued, invitation link stays on screen.

## Organizations and roles

Connection belongs to **organization**, never person. Every signup silently creates one, makes user admin; joining another only by accepting invitation. User belongs to exactly **one** org — `UNIQUE(memberships.user_id)` is that rule, why accepting invitation = `UPDATE` of existing membership row, never delete-then-create: row = user's single slot; locking `FOR UPDATE` serialises two acceptances by same person.

Two roles. **Admin** manages org, invites, changes roles, creates connections, assigns them, mints tokens, edits token scope. **Member** uses assigned connections, sees only own tokens on them, may revoke or rotate token secret but never widen — rotating leaked credential must not queue behind someone else's approval.

**Role lives on `memberships`, not `users`,** since it's fact about user *in an org*; unique index on `memberships.user_id` makes "one org" constraint not convention. Signup writes account and org (or place in inviting one) in **one transaction**, making "every user has membership" invariant; deliberately **no** lazy self-heal — creating org for whoever turns up without one hands free one to anyone, silently resurrects user admin just removed.

**`instances.created_by` is `ON DELETE SET NULL`, `instances.org` is `ON DELETE RESTRICT` — both load-bearing.** Cascade on either deletes `instances` rows straight from DB — bypassing `deleteInstance()`: no `/instance/delete` on Evolution, no pool closed, live socket on real phone number left running with nothing recording it. So deleting org still owning connections fails loudly. `mcp_tokens.assigned_to` **does** cascade: deleted account's tokens must stop working.

**Authorization answers 404, then 403.** Old rule — ownership failures answer 404 so id can't be probed — holds, gains second half now connection can be visible to someone who may not act on it:

- **invisible → 404** — another org's connection, unassigned one for member, missing one. Indistinguishable, the point.
- **visible but forbidden → 403** — member pressing Delete on connection assigned to them. They see it; refusing by role confirms nothing new, far better error.

`requireReadableInstance` / `requireManagedInstance` / `requireManagedInstanceOfKind` in `server/utils/org.ts` only implementations. Order inside kind-gated one is **readable → role → kind**; role check must stay in front: kind-first lets member probing `/dsn` distinguish 404 (WhatsApp) from 403 (Postgres). Role-first answers 403 for member regardless of kind. For admin, wrong kind still 404.

`requireReadableInstanceOfKind` consults **no role**, so `chats/*` and `tables` answer 404 for wrong kind to everyone. Those are reads member entitled to — assigned connection's chats and tables already reachable via `list-chats` and `list-tables` over MCP; refusing in UI while serving on wire incoherent.

`resolveTokenForActor()` replaces old `findOwnedToken`, whose `user = me` predicate now wrong both ways: too narrow (admin must reach member's token), too wide (never looked at connection's org). Colleague's token on shared connection = **404**, not 403 — member can't see it exists.

**MCP surface answers same question separately, must keep doing so.** `resolveMcpAuth` loads holder's membership and assignment itself; `org.ts` for session surface. Shared: `authorizesInstance()` — *pure* predicate over loaded facts, no event, no DB — so rule lives once while each surface keeps own credential path and failure semantics. Single `getCurrentActor(event)` used by both would collapse auth split.

**On MCP side facts = one query.** `resolveMcpAuth` reads token joined (LEFT) to holder, membership, `EXISTS` on assignment, then instance by PK. LEFT joins so missing piece logged as that, not "no such token". Nuxt runs own migrations at boot, so old cross-deploy hazard — new build against schema not yet arrived, 401 to every valid token — gone; `appDb()` refuses pool until migrations landed, answers 503 until then.

**Four ordinary actions would otherwise leave tokens reading "Active" yet answering 401** — unassigning connection, demoting admin, removing member, minting for member with no assignment. Each falsifies MCP predicate without touching `mcp_tokens`, and `toPublicToken` computes status from row alone. `revokeTokensFor()` exists for first three; fourth refused at mint. Never add path changing membership or assignment without dealing with tokens it kills.

Every refusal inside `resolveMcpAuth` logs which half failed. Handled 401 invisible to Nitro; "my token stopped working" with empty logs = failure that rule prevents.

## Invitations and membership changes

Invitation code = **bearer credential for joining org**, handled like MCP token: `waorg_` + 32 random bytes, returned once, stored only as SHA-256 hash, compared constant-time. `server/utils/invites.ts` only file minting or resolving one.

**Code alone can't join you to anything.** Every invitation names email; acceptance requires accepting account's own email to match, so link forwarded into group chat not redeemable by first reader. Signing up *through* invitation checks address **before** account created — bad code must not burn email address, unrecoverable for holder — and creates **no** personal org, else every invited signup makes one and deletes it one request later.

**Accepting = `UPDATE` of membership row, one transaction with spending invitation.** `markInviteAccepted()` conditional on invitation still unused and unrevoked, so two acceptances racing on one code can't both succeed. Two refusals, both 409: current org still owns connections (org-owned, leaving strands them; migrating would move WhatsApp account and history across trust boundary on strength of a link), or they're only admin of org with other members. Emptied old org deleted in same transaction.

**Last admin guarded by row lock.** `changeMemberRole` and `removeMember` each open transaction, lock org's memberships `FOR UPDATE`, count admins, only then write — two admins demoting each other take turns, second refused, refusal rolls back everything before. (Replaced pre-check + post-write undo PocketBase needed for lack of transactions.) `assertAdminSurvivesChange()` remains as read-only pre-check for one reason: role-change route must give absolute last-admin refusal *before* asking whether to revoke tokens, so it never arrives dressed as confirmable one.

**`removeMember` is one transaction:** membership, member's tokens, assignments go together or not at all, so neither old failure — refusal after tokens already revoked, crash between delete and revoke — possible. `acceptInviteInto()` still revokes joiner's holdings as second line.

**Demotion that would kill tokens refused with 409 and count, not done quietly** — caller retries with `revokeTokens: true`, admin saying yes to that consequence. Last-admin check runs *before* token question, so absolute refusal never arrives as confirmable. Only tokens on connections demoted admin will no longer reach revoked; ones on connections assigned to them keep working.

Pending invitations admin-only on `/api/org`; member roster not, since "ask admin to assign you a connection" actionable only if you see who's admin. `/api/invites/:code` reachable signed out — holding code = authorization — exposes only org name, invited address, role. **Invitation link escapes every redirect in `auth.global.ts`**, incl. org-less one: someone just removed must still open and accept one.

**Invitation email = extra delivery, never only one.** Link still shown once at creation; `POST /api/org/invites/:id/email` mails it from that dialog, authorized by *presenting code* — server resolves to row, checks id and org, builds URL itself, mails only stored address, so nothing in request becomes mail content or recipient. Pending table can't re-send link (only hash exists), so `POST /api/org/invites/:id/resend` supersedes via `createInvite()` and mails new one — answers **200 with new link when mail fails**, since old link already dead and invitation nobody has link for is orphaned. Throttle check runs *before* re-mint same reason. `assertInviteMailAllowed()` = in-memory speed bump (per address per minute, per org per hour), not control: every signup is admin of some org, so without it form mails anyone from deployment's domain with user-chosen org name in subject.

## Assignment, token assignment, rotation

**Assigning connection grants use, never management.** Assigned member gets dashboard, may hold connector tokens on it; can't delete, reconnect, resync, re-pair, rotate credentials. Admins hold **no** assignment rows — reach every connection in org — so empty assignment list ≠ no access; `authorizesInstance()` consults role first.

**Minting for someone who can't reach connection refused (422); assignment not created as side effect.** Such token born dead: renders "Active", answers 401 every call, nothing in Nitro log. Auto-assigning would make "give them a token" mean "give them dashboard" — different decision, different button.

**Unassigning revokes that member's tokens on that connection, same handler.** Last of four token-killing operations — other three in membership section — each handles consequence where caused. Assignment listing carries live-token count per person so confirmation names cost rather than "are you sure".

**Rotation replaces secret, nothing else.** One write member may make to own token, since leak response must never queue behind someone's approval; safe to give *because* scope untouched — rotating changes what secret is, not what it reaches. `expires_at` and `last_used_at` untouched too, why revoked or expired token refused with 422 rather than rotated into already-dead secret. Plaintext returned here and nowhere else, as at creation.

**`canManage` computed server-side**, returned on `/api/instances` rows and `/api/instances/:id/summary`; UI never recomputes from session role. Same as `canReadMessages`: one rule, one place.

**Member never enters pairing mode in `InstanceWhatsapp.vue`.** Safety property, not tidiness. Pairing mode runs QR poll calling `/instance/connect` — 403 for them, failing request every two seconds forever; and pairing binds real phone number = management. They get `lost` wording without Reconnect button; every hint telling someone to act (`describeState`'s text, "re-import under Manage" footnote) replaced for them with what state *is* and who can fix it. UI instructing someone to press button they lack worse than silence.

## Telegram bridge

`apps/telegram-bridge` = Telegram's counterpart to Evolution: separate Node service, only thing in repo speaking MTProto. Personal accounts link by QR via `teleproto` (maintained GramJS fork, pinned); chats synced into `telegram` schema of DB Evolution uses; bridge also lists chats, resolves username or phone number, sends text. App creates and links Telegram connections, reads them, exposes over MCP, alerts on them (below, and "Disconnect alerts").

Node runs `src/*.ts` directly (type stripping, Node ≥ 22.18), no build step, `erasableSyntaxOnly` on: no enums, namespaces, parameter properties. `pnpm typecheck` doesn't cover it — use `pnpm bridge:typecheck`, or `cd apps/telegram-bridge && node_modules/.bin/tsc --noEmit`.

**One process per session, enforced.** Two connections on one auth key make Telegram answer `AUTH_KEY_DUPLICATED` and kill key = QR scan cost — rolling deploy overlapping old and new is exactly that. `locks.ts` takes Postgres advisory lock per session, all on **one dedicated connection**: session-level lock belongs to its backend, so replaced connection silently drops every lock. Backend pid re-checked every 5 s; changed pid *or failed check* stops every client holding one. Neither pool timeout may rotate that connection (`idle_timeout: 0`, `max_lifetime: null`). Lock key = 64 bits of sha256, not `hashtext`'s 32, so two sessions can't block each other.

**State is live, never a column** — WhatsApp lesson. `session_enc` says session exists, `revoked_at` that Telegram refused it; `open` requires connected client whose last probe (`updates.getState`, every 30 s) answered. Revocation recognised by RPC error **code** (`REVOKED` in `sessions.ts`), not teleproto's error classes, which bump can rename; on it sealed session cleared, only new pairing recovers.

**`GET /qr` never asks Telegram anything.** Only `POST /pair` starts flow, bounded five minutes, so polling client can't become stream of login attempts. Two-step verification password handed to teleproto's SRP check and dropped: never stored, never kept on flow; request bodies never logged — errors log route label, not URL.

**Shutdown disconnects, never logs out**, so redeploy unlinks nobody. Logout conversely forgets session even when Telegram-side logout fails; leftover = entry in account's Telegram → Devices, owner can terminate.

**Telegram API credentials optional, both or neither.** Railway template ships bridge to every deployment; WhatsApp-only one shouldn't need to register at my.telegram.org first. Without them `config.telegram` undefined, bridge still starts: routes marked `needsTelegram` in `http.ts` (create session, pair, password, reconnect, resolve, send) answer `telegramNotConfigured()` — 503 with `code: 'telegram_not_configured'`, checked *after* auth — while DB-only routes (state, qr, chats, logout, delete, webhook) keep working, so existing connection still readable and deletable. `/health` reports `telegram: 'configured' | 'unconfigured'`, stays 200 for platform health check. Linked session whose bridge lost them reports `close` with reason, never lost session Reconnect could fix. **`code` = contract with app**, not status: `isTelegramNotConfigured()` in `telegram.ts` keys on it, `relayBridgeError` and `provisionTelegramInstance` turn it into instructions, `deploymentBridgeReadiness()` reads `/health` for create page (`/api/telegram/readiness`, admin-only, our bridge only). One credential without other, or malformed, still refuses to start — typo must fail loudly, not pass for "Telegram off". `SessionManager.credentials()` only reader, so no path builds client without them.

**Keys.** Global `TELEGRAM_BRIDGE_ADMIN_KEY` creates and deletes sessions, opens nothing else; each session has own bearer key, stored only as SHA-256 hash, only credential for its other routes. Session strings and webhook headers sealed with AES-256-GCM under `TELEGRAM_SESSION_ENCRYPTION_KEY`, row id as additional data so sealed value moved to another row won't open. Losing that key unlinks every account.

**Bridge shares Evolution's DB and credential, keeps to own schema.** On Railway: one Postgres service, one DB and its superuser URL, for both. On boot bridge creates `telegram` schema (`ensureBridgeSchema`), sets `search_path` to `telegram, public` **on own connections** — never on role, since role is Evolution's too and role default would repoint Evolution's queries. Every bridge query unqualified, finds tables only via that setting, so boot refuses unless `current_schema()` is `telegram`: connection whose search path didn't take would create every table beside Evolution's. App doesn't rely on search path — `telegram-db.ts` names `telegram.<table>` explicitly — so `NUXT_TELEGRAM_DATABASE_URL` can be same URL. **Deliberate trade for simplicity:** credential reads every WhatsApp message in DB, so compromised bridge = compromised Evolution. Least-privilege reader for app still possible: set `TELEGRAM_READER_ROLE` to existing LOGIN role, bridge re-grants it every start from explicit column allowlist (`grantReader`) — never `sessions`, never `access_hash` or `phone`; new column hidden until added there.

**`chat_id` = Bot API marked id**, stored `bigint`: user positive, basic group `-id`, channel/supergroup `-(10^12 + id)`. Compute with `markedId` / `channelChatId` in `sync/convert.ts`, **never** teleproto's `utils.getPeerId`, which concatenates `"-100"` onto id, right only for ten-digit id — and rebuild teleproto's `_entities` map on update (keyed with `getPeerId`) with `entityMap` before lookup. `messages.in_channel` derived from it by CHECK; partial unique index on `(session_id, message_id) WHERE NOT in_channel` lets deletion arriving with ids and no chat resolve — private chats and basic groups share one message-id counter per account. If Telegram breaks that, inserts fail loudly rather than deletion hitting wrong chat.

### Sync (`src/sync/`)

`convert.ts` maps TL objects to rows, no I/O; `store.ts` = every write; `syncer.ts` decides when. **Four sources, none complete.** Live updates, applied through one queue in arrival order. Catch-up on connect: teleproto's common difference from persisted `sessions.update_*`, then **our own** `updates.getChannelDifference` per channel from `chats.channel_pts` — teleproto tracks only channels it saw update for in current process, so after restart would miss every channel's offline edits and deletions. Dialog pass on connect and every ten minutes, filling chat forward when top message newer than stored; covers channels Telegram stopped pushing to unpolled client. Backfill of older history. Update state must be seeded **before** `connect()` (teleproto fetches fresh one on connect only when none, and fresh one skips downtime), raw handler attached before `catchUp()`, else difference dispatched to nobody.

**Same message arrives from several sources, no guaranteed order**, so every write = idempotent upsert, **tombstone never resurrected**: deletion clears `text` and `entities`, sets `deleted_at` (CHECK enforces pair); every message upsert conditional on `deleted_at IS NULL`. Retaining text deleted for everyone and serving to model = what this prevents. Edits overwrite in place — no second row, unlike WhatsApp — reactions = aggregate on message (`[{emoji, count}]`), never own rows.

**Unrecoverable recorded, not hidden.** `chats.gap_since` set when forward fill runs past page cap or Telegram answers `ChannelDifferenceTooLong`; `backfill_stopped` says why history ends where it does; only `start` (with `backfill_complete`) means chat's first message reached — `days`, `count`, `skipped`, `inaccessible` all mean older history exists, not fetched. Read tool must surface both rather than present partial chat as whole.

**Backfill slow on purpose**: newest chat first, one page of 100 at a time spaced by `TELEGRAM_BACKFILL_PAGE_DELAY_MS`, capped per chat by count and age, broadcast channels skipped by default, flood wait pauses whole session's backfill. Unofficial-client accounts watched; history hammering gets account restricted. No takeout sessions: need phone confirmation, usually impose a day's delay.

**Chat row exists only for chat with messages.** Entity merely passing by — forward's origin, group member, resolved username — refreshes known chat or `users` row, never creates chat, else listing fills with channels someone once forwarded from.

**One session's data belongs to one Telegram account.** `sessions.data_user_id` records whose; pairing different account wipes it, logout wipes it, revocation keeps it, since likeliest next step = same person scanning again.

**Sending never parses formatting** (`parseMode: false`), so model-written text goes out verbatim, not reinterpreted as Markdown; group upgraded to supergroup answers 409 naming new id rather than sending into dead chat. `/qr` returns `tg://login` URL beside PNG; exactly as sensitive as image.

### In the app (`server/utils/telegram.ts`, `telegram-db.ts`, `server/mcp/tools/telegram/`)

Same split as WhatsApp — `telegram.ts` talks to bridge over HTTP, `telegram-db.ts` reads bridge's DB — same rules, restated only where different.

**Credentials.** `telegram` row reuses `base_url` (bridge), `api_key` (bridge's per-session key), `instance_id` (bridge session id), `admin_key` (bring-your-own bridge's global key). `telegramCredentialsForInstance()` picks first three only — `admin_key` not in its type, no fallback to `NUXT_TELEGRAM_ADMIN_KEY`. URL not `NUXT_TELEGRAM_URL` = user-supplied, host-guarded every request. `onDeploymentBridge()` = one test for "our bridge".

**Where chats read.** `telegramDbUrlFor()` = precedence rule, as `messageDbUrlFor()` for Evolution: row's hidden `telegram_db_url` (guarded), else `NUXT_TELEGRAM_DATABASE_URL` for connection on our bridge (unguarded — own infra), else 501. Every query carries `session_id = instance_id`. Chat scope = `chat_id = ANY(...)` in SQL for listing and searching, assertion before reading one chat.

**`chat_jids` holds Telegram marked ids on Telegram token.** Column name is WhatsApp's; token bound to one connection of one kind, so meaning per kind. `scopedTelegramChatIds()` refuses non-numeric entry with 409 rather than matching nothing. **`chatId` is string everywhere** — tool inputs, outputs, SQL binds — since JS number rounds 64-bit id into different chat.

**Tables schema-qualified, columns named.** Every query names `telegram.<table>` rather than depending on search path shared DB can't be trusted to provide, lists its columns: with restricted `TELEGRAM_READER_ROLE`, `chats` and `users` granted column by column, so `SELECT *` or `access_hash` fails with permission error.

**Reads report what sync couldn't see.** `read-telegram-messages` excludes deleted and service messages in SQL, so `hasMore` and `totalMatching` describe same set, reports `deletedExcluded` / `serviceMessagesExcluded` counted over whole window. Carries `history` from chat row, says in `note` when `hasMore: false` = oldest *synced* message, not chat start — Telegram form of "page must say it is a page", one paging can't fix. Migrated basic group stays readable, since old messages live there, names `migratedTo`; sending to it refused by bridge with new id.

**Sending resolves before checking scope, fails closed.** `username` goes through bridge's resolve first, so scoped token can't reach by name chat it couldn't reach by id; unreachable bridge refuses send rather than skipping check. Bridge's 4xx bodies written for callers, pass through `relayBridgeError()`; anything else logged, answered 503.

**Linking started, never polled into existence.** Telegram connection created unlinked. `POST /api/instances/:id/telegram/pair` starts QR flow on bridge; dashboard polls `GET …/telegram/qr` every two seconds — safe here, unlike WhatsApp's QR poll, since it only reads flow `pair` started, never asks Telegram for login token. Only managers pair or poll (`InstanceTelegram.vue`, same rule as WhatsApp). QR image reaches page, `tg://login` URL doesn't (`pairingView`). Two-step password goes input → `…/telegram/password` → bridge → Telegram SRP check, cleared from input as sent, stored and logged nowhere.

**Unlinking deletes synced chats.** `…/telegram/logout` signs out and wipes them; deleting connection deletes bridge session, which does both; unreachable bridge keeps row (`deleteTelegramSession`, same ordering `deleteInstance` insists on). Admin key used only there and at create (`telegram-instances.ts`); `telegramAdminCredentials` never pairs our key with user's bridge or theirs with ours.

**Chat list and chat lookup routes serve both messaging kinds** via `requireReadableInstanceOfKinds`. Telegram rows return in picker's existing shape with chat id in `jid`, so `TokenScopeFields` and `ChatsDialog` shared not copied; `ChatsDialog` takes kind to show @username instead of phone number.

**Tool names carry `telegram`** (`read-telegram-messages`, …) since tool basenames global across groups.

## IMAP connections

`imap-client.ts` = only file speaking IMAP (imapflow): connect, probe, live body / attachment / body-search. `imap-sync.ts` = header sync. `imap-db.ts` = SQL reads over `app.mail_*`. `mail-format.ts` = tool presentation + folder resolution. Tools in `server/mcp/tools/imap/`. `docs/imap.md` = operator side.

**Hybrid by decision: headers synced, bodies and attachments never stored.** Row ≈ 1 KB (envelope, flags, BODYSTRUCTURE part ids, attachment name/type/size). `read-email` downloads text part live, `get-email-attachment` streams one part into memory, `search-emails`' `text` = server's own `SEARCH BODY` (Gmail: `X-GM-RAW`), UIDs joined back onto synced rows. Never add body or attachment columns — storage was the stated constraint.

Rules easy to undo:

- **Every connect through `assertPublicTarget`, dials approved address**, hostname as `servername`, `rejectUnauthorized: true`. **No plaintext:** `starttls` sets `doSTARTTLS: true` — imapflow's default carries on in cleartext when STARTTLS absent from (strippable) capabilities.
- **Read-only everywhere:** every mailbox opened `readOnly` (EXAMINE), parts fetched with BODY.PEEK — reading must not mark mail read for owner. Connector can't send/move/flag; adding that = new write tools, new scope decision.
- **`error` listener on every ImapFlow** — unhandled `error` on dropped socket crashes process.
- **UIDVALIDITY checked before every folder (sync) and every live fetch.** Changed value = folder renumbered: sync deletes folder's rows and restarts; live fetch answers 410. `emailId` encodes folder + uidvalidity + uid for this reason.
- **Completeness decided by date, never UID position.** UIDs follow arrival, not sending; imported mail lands old messages at high UIDs. `finished()` = `SEARCH BEFORE cutoff` empty. Walking UIDs to 1 and calling it complete reported a year of skipped mail as "no older mail" — found in testing.
- **Lease by conditional UPDATE** (`lease_until < now()`), not advisory lock — no DB connection held across minutes of IMAP. Scheduled task safe on several replicas (unlike alert sweep). Crash mid-run holds lease ≤ 10 min.
- **`auth_failed` stops scheduled sync** until credentials change or Sync now — retrying refused password every 2 min gets accounts locked.
- **Identity (`lower(user@host)`) change wipes synced rows** (`resetIfIdentityChanged`), in credential update and before every run.
- **`part` checked against row's stored `attachments`** before any download — arbitrary part id = read body / nested messages through file route. Size refused from BODYSTRUCTURE before download, cap re-enforced on bytes.
- **Folder scope rides `chat_jids`** (paths), `connectionFamily('imap') = 'messaging'`. Predicate in SQL for listings; `assertFolderAllowed` before live fetch. Cross-folder listings collapse by `Message-ID` (`DISTINCT ON`) inside scope only — `folders` never names a folder token can't see.
- **Health = sync's last outcome, not live login** (`getImapHealth`) — dashboard polls, login per poll = rate-limit. Stale (>15 min) reads `unknown`, never `open`. Listings carry `staleSyncNote`.
- **All Mail / Junk / Trash / `\Noselect` listed, not synced** — All Mail duplicates everything.
- Live connection cached via `keyedResource('imap:<id>')` with build de-dupe; one retry on dropped connection (`isDropped`). Sync uses own short-lived connection so backfill never holds mailbox tool call waits on.
- Tool result with `content: [...]` passes through toolkit's `normalizeToolResult` untouched — how attachments return `image` / `resource` blocks. Never return plain object with array `content` key from other tools.

Not alertable yet (`alertableKind` → `undefined`); `auth_failed` is the signal that would drive it. OAuth (Gmail/Microsoft XOAUTH2) not supported.

## The app database

`server/utils/app-db.ts` owns pool; `server/db/migrations.ts` = schema.

- **`appDb()` only way in.** Memoises one pool; on first use per process creates `app` schema and applies pending migrations under advisory lock in one transaction. Failure remembered 10 s then retried, so still-starting DB recovers alone. `server/plugins/app-db.ts` starts it at boot so bad URL hits log immediately.
- **Every query names `app.<table>`.** DB shared with Evolution (`public`) and bridge (`telegram`); nothing may depend on search path.
- **Rows return `NULL` as `undefined`, timestamps as ISO strings** (`transform` on pool), so `App*` types say `?: string` and mean it. Writes take `undefined` as `NULL`. Empty string not valid `timestamptz` — clear date with `null`.
- **Migrations append-only.** Deployed migration recorded in `app.migrations`, never runs again, so editing one reaches fresh DBs, silently skips existing. Add new entry.
- **Functions that must stand or fall with caller's other writes take `Db`** (pool or transaction) — `revokeTokensFor`, `acceptInviteInto`, `markInviteAccepted`, `createUser`, `createOrganizationFor`. Pass transaction; never open second inside.
- **Passwords scrypt** (`account.ts`), params in stored string. Imported PocketBase rows carry bcrypt hashes; `checkPassword` verifies, rehashes on success, so path empties itself. Unknown email still costs one hash comparison, so login form doesn't leak which addresses exist.

**PocketBase gone; one trace remains on purpose.** Users imported (one-time import at commit `2e1872e`) keep bcrypt hash until next sign-in, so `verifyPassword` still accepts `$2a$`/`$2b$` hashes and rehashes. Remove that branch and `bcryptjs` dependency once `SELECT count(*) FROM app.users WHERE password_hash NOT LIKE 'scrypt$%'` is zero. Imported rows keep 15-char PocketBase ids; new rows get uuids; both just `text`.

## Frontend

**Tailwind v4** via Vite plugin (`@tailwindcss/vite`), not Nuxt Tailwind module. No `tailwind.config.js`, shouldn't be one — all theme config in `apps/web/app/assets/css/tailwind.css` as `@theme inline` plus `:root` / `.dark` custom properties (oklch). Add token: define CSS var under **both** `:root` and `.dark`, map inside `@theme inline` (`--color-foo: var(--foo)` yields `bg-foo`, `text-foo`). Dark mode = class variant (`@custom-variant dark (&:is(.dark *))`) — needs `.dark` class on ancestor; no media query wired.

**shadcn-vue** via `shadcn-nuxt` with `prefix: ''`, components auto-import under bare names (`<Button />`, not `<UiButton />`). Add with CLI, don't hand-write:

```bash
cd apps/web && pnpx shadcn-vue@latest add <component>
```

`components.json` pins contract (`new-york`, `neutral`, CSS variables, lucide icons, `cn` at `@/lib/utils` — don't move that file).

`app/plugins/ssr-width.ts` calls `provideSSRWidth(1024)` so VueUse viewport composables render deterministically server-side. Change number only to change app-wide SSR breakpoint assumption.

**Components must be explicitly closed** in Vue SFC templates — `<Input ... />`, not `<Input ...>`. Only HTML void elements may stay open; `nuxt typecheck` does **not** catch it; surfaces as 500 "Element is missing end tag" first render. Load page after editing template.

**Routing gate:** `middleware/auth.global.ts` handles authentication only. Deliberately doesn't check WhatsApp connection state — would put Evolution round-trip on every navigation. `/instances` redirects to `/instances/new` when user has none; `/instances/[id]` decides QR panel vs dashboard.

**Provisioning click-triggered, not on-mount.** Creating WhatsApp instance reserves live socket on Evolution, so page refresh must never create second account. DB connection proved by actually connecting, refresh shouldn't redo that either.

**Dashboard = two panels, not one with hidden fields.** `pages/instances/[id].vue` picks `InstanceWhatsapp.vue` or `InstancePostgres.vue` from `instance.kind`; database has no QR, profile, message count, and empty version of any suggests state it can be in. Page decides from `/api/instances/:id/summary` — app-DB read, no backend call — since chosen panel makes expensive call itself; deciding from full status fetch = two.

**Two messaging panels share markup.** `InstanceWhatsapp.vue` and `InstanceTelegram.vue` keep only genuine differences — pairing flow, mode logic, per-kind copy — render rest through `InstanceHeader` (all three panels), `MessagingOverview` (one-row Profile → Messages → Chats → Contacts strip and its dialogs; Contacts only when `stats.contacts` set, which Telegram never sets), `SessionLostNotice`, `DbUrlNotice`, `NoticeCard`, `ConfirmAction`, `QrFrame` and `useReconnect()` composable. Change layout there, not in panel, or they drift again.

**Scope picker fetches only axis kind has.** `TokenScopeFields.vue` sets `immediate` per kind: asking WhatsApp connection for tables answers 404, and console 404 on every dialog open reads as bug. New Postgres token starts read-only, read tools pre-checked from server's own catalogue.

**Dashboard's three tables search, sort, page on server.** Chats, Messages, Contacts each open dialog holding no pool: asks for one page of 100, renders it; `q`, `sort`, `dir`, `page` are request params. Browser-side would mean search answering about fetched rows, not account — what chats dialog used to do, over capped 2000. `useTablePage()` owns shared state (generation counter so superseded response can't land, page reset on every query change, `hasMore` untouched by failed page). Only thing server can't order = *name* on messages table: senders and chats named after query, so only Time sortable there; other columns carry no sort control rather than page-local one.

**Token list shown even while connection down** — else couldn't revoke token for offline account or unreachable DB, exactly when you'd want to.

**Restart dev server after adding shadcn components.** Component manifest built at startup; component added while running renders as literal unknown element (`<radiogroupitem>`), SSR still 200. Page loading ≠ proof it works.

## Things that cost real money or a phone number

- **`docker compose down -v` forces full WhatsApp QR re-scan.** `-v` deletes `evolution_instances` volume holding every paired session. Use `down` without `-v` for routine restarts.
- **WhatsApp stack behind compose profile.** `pnpm services:up` brings Postgres alone; `pnpm services:up:whatsapp` adds Redis and Evolution. `services:down`, `:logs`, `:ps` pass every profile unconditionally so still cover everything — profiled service you forgot flag for looks simply absent, profiles' one sharp edge.
- **Pairing burns real phone number.** Scanning QR binds real WhatsApp account; repeated pair/unpair or unsolicited sends get numbers banned. Use spare SIM.
- **`pnpm dev` runs `nuxt dev --host 0.0.0.0`**, must — bound to localhost, Nuxt unreachable from Evolution container. Means socket listens on LAN interface too.
- **Linux host with ufw: inbound webhook silently times out** until container→host traffic allowed. Compose subnet pinned to `172.31.250.0/24` so one rule covers it; rule and round-trip test in `docs/development.md` "Linux firewall". Reachable by ping but not TCP = signature.

Every image tag in `docker-compose.dev.yml`, `docker-compose.yml` and `docker/aio/Dockerfile` pinned. Never relax to `latest`.

**`DROP SCHEMA app` = local reset**, deletes every user, connection, token — next boot recreates schema empty. Never point at deployment's DB: Evolution sessions those connections name keep running with nothing recording them.

## Releases

Merging `main` into `prod` publishes `ghcr.io/ju-li/automata-mcp-web`, `ghcr.io/ju-li/automata-mcp-telegram-bridge` and `ghcr.io/ju-li/automata-mcp-aio`, tagged with version in **root `package.json`** — only place version lives; `apps/*/package.json` unversioned. `docs/releases.md` = operator's procedure.

- **`.github/scripts/release-version.sh`** = one version rule: three-part `X.Y.Z`, no existing `vX.Y.Z` tag, strictly above latest. Both workflows call it, so PR check and push guard can't drift.
- **`release-check.yml`** (PRs into `prod`) runs that, builds all three images without pushing — after merge, bad version or broken Dockerfile already on release branch.
- **`release.yml`** (push to `prod`) re-runs version guard, pushes all three images, then creates tag and GitHub Release **last**, so tag means images exist. All in one workflow since tag pushed with `GITHUB_TOKEN` doesn't trigger another.
- **`main → prod` = merge commit, never squash.** Squash leaves `prod` off `main`'s history; every later release PR re-shows old commits or conflicts.

Templates pin major tag, not `latest`: migrations run at boot, append-only, so image rollback after one isn't clean undo.

## Container ports

Neither image hardcodes port. `apps/web/Dockerfile` deliberately does **not** set `NITRO_PORT`, since Nitro resolves `NITRO_PORT || PORT` and pinning makes server ignore platform-assigned port; unset, defaults 3000.

Binds `::` not `0.0.0.0`, accepting IPv4 and IPv6. Legacy Railway environments route private network over IPv6 only.

**Following `$PORT` means listen port ≠ Dockerfile default.** Railway injects `PORT=8080` into every service, so anything following it listens there; anything pointing at Dockerfile default gets `ECONNREFUSED` from hostname resolving fine. Evolution unaffected — reads `SERVER_PORT`, which `docs/deploy-railway.md` pins — and Telegram bridge reads `TELEGRAM_BRIDGE_PORT` first.

**Don't add `VOLUME` instruction.** Railway fails build outright (`docker VOLUME at Line N is not supported, use Railway Volumes`). Persistence from compose bind mount locally, attached volume in service settings on Railway.

**Don't add BuildKit cache mount either.** Railway rejects any `--mount=type=cache` whose `id` isn't prefixed with service's own id (`id=s/<service-id>-<target>`), which would hardcode one Railway service into Dockerfile. `apps/web/Dockerfile` installs without one; install layer keyed on lockfile, so unchanged lockfile skips it anyway.

## All-in-one image

`docker/aio/Dockerfile` = Postgres + Redis + Evolution + web + bridge in one container, for `docker run`. `docs/self-hosting.md` "Single container" = operator's side. Build context repo root; root `.dockerignore` keeps local `node_modules`/`.nuxt`/`.output`/`.env` out (cline worktree symlinks break `COPY apps/web` otherwise).

- **Base = `evoapicloud/evolution-api:v2.3.7`**, so Evolution runs as shipped (Node 24, Prisma engines, boot script). Web + bridge run on **Node 22.23.2 copied to `/opt/node22`**, same as published images. Redis binaries copied from `redis:8.2.9-alpine`; Postgres = Alpine `postgresql16` + `-contrib` (bridge needs `pg_trgm`). Build ends with version asserts so a binary that can't run here fails build, not first boot.
- **Web and bridge stages duplicate `apps/web/Dockerfile` / `apps/telegram-bridge/Dockerfile`** — change one, change both.
- **s6-overlay v3 supervises** (`rootfs/etc/s6-overlay/s6-rc.d/`): `init-data` → `postgres` → `postgres-ready` → {`evolution-migrate` → `evolution`, `telegram-bridge`, `web`}; `redis` beside. Dependencies = start order and reverse shutdown order, so Postgres stops last. `postgres-ready` exists because longrun "up" means started, not accepting connections. `S6_BEHAVIOUR_IF_STAGE2_FAILS=2`: failed oneshot stops container (failed longrun would restart forever — why PORT check lives in `init-data`). `S6_CMD_WAIT_FOR_SERVICES_MAXTIME=0`: Evolution migrations outlast 5 s default.
- **`rootfs/usr/local/bin/automata-env` = only place derived vars written**, sourced by every script — container's `environment:` block. Empty var = unset, so `--env-file` with blank `.env.selfhost.example` lines works.
- **Secrets generated into `/data/secrets` on first boot**; env var of same name overrides, never written back. `postgres-ready` re-`ALTER ROLE`s password every boot, so override and its removal both converge. App role = DB owner, not superuser; superuser reachable only via socket + peer.
- **Internal ports 5432/6379 on loopback, Evolution 18080, bridge 18095** — off 8080/8095 because web follows `$PORT` and Railway injects 8080. `init-data` refuses `PORT` equal to any. URLs use literal `127.0.0.1`, never `localhost`, so net-guard's own-backend check resolves exactly; verified refusing `127.0.0.1:5432` with `NUXT_ALLOW_PRIVATE_TARGETS=true`. Redis not in own-backend list — docs say so.
- **Evolution migrations run as root** (`evolution-migrate`, upstream script as child — not `set -u` clean, so not sourced); everything else drops to `node` / `postgres` via `s6-setuidgid`. Evolution's cwd-relative `instances` and `store` symlinked into `/data/evolution`.
- **No `VOLUME`, no cache mount** (Railway rules above). Everything under `/data`; deleting that volume = `down -v`.

