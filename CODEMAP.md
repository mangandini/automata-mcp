# CODEMAP — mapa rápido del código de automata-mcp

> **Para qué sirve:** consultar esto ANTES de escanear el repo. Dice qué archivo hace qué y
> dónde tocar para cada tipo de cambio. El *porqué* de las decisiones (reglas de seguridad,
> trampas de Evolution/Baileys, invariantes) está en `CLAUDE.md` — aquí solo se referencia
> la sección. Generado 2026-10-22 sobre el commit clonado (~46k líneas).
> Si cambia la estructura, actualizar este archivo.

## 1. Qué es (30 segundos)

Un servidor **Nuxt 4 / Nitro** (`apps/web`) con dos superficies:

| Superficie | Ruta | Credencial | Resuelve |
|---|---|---|---|
| Web UI (dashboard) | `/`, `/api/*` | cookie `automata_session` | `server/middleware/session.ts` → `utils/session.ts` → `event.context.user` |
| Servidor MCP (para Claude) | `/mcp` o `/mcp/<token>` | Bearer `wamcp_…` | `server/mcp/index.ts` → `utils/mcp-auth.ts` → `event.context.mcpAuth` |

Las dos rutas de auth **nunca se mezclan** (CLAUDE.md › "The auth split").

Una *conexión* = fila en `app.instances` con `kind` ∈ `whatsapp | telegram | postgres | imap`.
Un token MCP está ligado a **una** conexión y a **un** miembro; los tools no reciben argumento de conexión.

Servicio aparte: `apps/telegram-bridge` (Node, MTProto con `teleproto`) — enlaza cuentas de Telegram y sincroniza a schema `telegram`.

Dependencias externas: Postgres (schemas `app`, `public`=Evolution, `telegram`), Evolution API + Redis (solo WhatsApp), SMTP opcional.

Versiones clave: nuxt ^4.5, vue 3.5, `@nuxtjs/mcp-toolkit` **0.19.0 fijo**, `postgres` (postgres.js) 3.4.9, `imapflow`, `teleproto` 1.229. pnpm 11.22. **Sin tests ni lint**: solo `pnpm typecheck` y `pnpm bridge:typecheck`.

## 2. Comandos

```bash
pnpm install; pnpm services:up[:whatsapp|:telegram]; pnpm dev   # :3000
pnpm bridge:dev        # bridge en :8095
pnpm typecheck; pnpm bridge:typecheck; pnpm build
```
Un único `.env` en la raíz (`.env.example` documenta todo). Variables Nuxt llevan prefijo `NUXT_`.
Alias: `~`/`@` → `apps/web/app/`, `~~` → `apps/web/`, `#shared` → `apps/web/shared/`.

## 3. Árbol con propósito

```
apps/web/
  nuxt.config.ts            módulos (shadcn-nuxt, mcp-toolkit), nitro asyncContext+tasks, scheduledTasks, runtimeConfig
  modules/mcp-token-route.ts registra /mcp/:token (frágil: depende de archivo interno del toolkit)
  shared/connection.ts      InstanceKind, ConnectionFamily, ConnectionState, assertNever  (#shared)
  app/                      FRONTEND (Vue, shadcn-vue en components/ui/)
  server/
    middleware/session.ts   resuelve cookie (sale temprano en /mcp*)
    mcp/index.ts            handler MCP por defecto (auth)
    mcp/tools/<grupo>/*.ts  1 archivo = 1 tool, auto-descubierto
    api/**                  rutas REST del dashboard (file-based: nombre.metodo.ts)
    db/migrations.ts        schema `app` — APPEND-ONLY, se aplica al arrancar
    plugins/                hooks de arranque/Nitro
    tasks/                  tareas programadas
    utils/                  toda la lógica (auto-importada en server/)
    types/                  d.ts para hooks del toolkit
apps/telegram-bridge/src/   servicio Telegram
docker/aio/                 imagen todo-en-uno (s6-overlay: postgres, redis, evolution, web, bridge)
docker-compose.dev.yml      solo servicios para dev (Nuxt corre en host)
docker-compose.yml          stack self-host completo
docs/                       manual de operador (self-hosting, whatsapp, telegram, postgres, imap, alerts, 2FA, railway, releases)
.github/workflows/          release.yml, release-check.yml
```

## 4. `server/utils/` — quién hace qué

Líneas aprox. entre paréntesis. Símbolos principales exportados.

### Base de datos de la app / infraestructura
| Archivo | Rol | Exports clave |
|---|---|---|
| `app-db.ts` (367) | pool de la app + tipos de filas | `appDb`, `appDbUnavailable` (503), `getRow/insertRow/updateRow`, tipos `AppUser`, `AppInstance`, `AppMcpToken`, `OrgRole`… |
| `errors.ts` | status HTTP de errores | `httpStatusOf` |
| `parse-body.ts` | validación de body (zod) | `parseBody` |
| `keyed-resource.ts` | caché genérica de handles por id (fingerprint, TTL 60s, LRU) | `keyedResource` |
| `lookup-cache.ts` | caché stale-while-failing | `staleWhileFailing` |
| `net-guard.ts` | bloquea hosts privados / backends propios (SSRF) | `assertPublicTarget`, `assertPublicUrl` |
| `redact.ts` | quita tokens de logs | `redactPath`, `redactHeaders`, `isMcpPath` |
| `mailer.ts` | SMTP | `sendAppEmail` |
| `sql-text.ts` | `escapeLike` |

### Auth web, cuentas, organización
| Archivo | Rol |
|---|---|
| `session.ts` | cookie de sesión: `startSession`, `getSessionUser`, `requireSessionUser`, `endOtherSessions` |
| `account.ts` | `hashPassword`, `checkPassword`, `createUser`, `requireCurrentPassword` |
| `signup-policy.ts` | quién puede registrarse (`NUXT_SIGNUP`), `claimFirstAccount` |
| `email-verification.ts` (619) | verificación de email por código/enlace (signup, invitación, cambio de email) |
| `login-throttle.ts` | límites por IP/dirección (login, código signup, código verify) |
| `mfa.ts` (363) | desafíos de login 2FA, recovery codes, `finishLoginChallenge` |
| `totp.ts` | TOTP RFC 6238 propio |
| `webauthn.ts` | passkeys (`@simplewebauthn/server`) |
| `org.ts` (655) | **autorización**: `loadActor`, `requireOrgAdmin`, `requireReadableInstance[OfKind(s)]`, `requireManagedInstance`, asignaciones, roles, miembros, `resolveTokenForActor` |
| `invites.ts` | invitaciones: crear, resolver, enviar mail, aceptar |

### MCP
| Archivo | Rol |
|---|---|
| `mcp-auth.ts` | `mintMcpToken`, `hashMcpToken`, `resolveMcpAuth` (token→instancia, union `McpAuth` por kind), `useMcpAuth` |
| `mcp-kind-tool.ts` | **`defineKindTool`** (usar siempre en vez de `defineMcpTool`), `TOOL_KINDS`, `kindsForTool`, `toolServesKind` |
| `mcp-scope.ts` | `instanceKind`, `McpScope`, `scopeFromRecord`, `isToolAllowed`, `assertChatAllowed`, `assertTableAllowed`, `resolveNumberToJid` |
| `mcp-instructions.ts` | texto de instrucciones por kind (`WHATSAPP_/POSTGRES_/TELEGRAM_/IMAP_INSTRUCTIONS`) |
| `scope-schema.ts` | zod del scope de token (`scopeFromInput/ToInput`) |
| `tokens.ts` | CRUD de tokens: `createToken`, `rotateToken`, `updateTokenScope`, `revokeToken`, `scopeFields` |

### Conexiones (ciclo de vida)
| Archivo | Rol |
|---|---|
| `instances.ts` (959) | **central**: `toPublicInstance` (única proyección a UI), `provision{Whatsapp,Postgres,Imap}Instance`, `getInstanceStatus`, `reconnectInstance`, `getInstanceQr`, `logoutInstance`, `enableFullHistorySync`, `deleteInstance`, `connectionState`, `settingsBody` |
| `alerts.ts` (492) | alertas de desconexión por email: `sweepConnectionAlerts`, `reregisterConnectionWebhooks` |

### WhatsApp (Evolution)
| Archivo | Rol |
|---|---|
| `evolution.ts` | cliente HTTP Evolution: `credentialsForInstance` (sin fallback global), `evolutionAdminCredentials`, `evolutionClientForInstance` (UI), `useEvolutionClient` (MCP) |
| `evolution-db.ts` (675) | **lectura SQL read-only** del Postgres de Evolution: `listMessagesPage`, `searchMessages`, `messageDbUrlFor`, `onDeploymentServer`, `resolveEvolutionInstanceId` |
| `chats.ts` (1254) | dar forma: `listChats`, `listChatsPage`, `chatListing` (caché 60s), `listMessages` (`MessagePage`), `listAccountMessages`, `contactDirectory`, `listContacts`, `classifyContent`, `previewOf` |
| `mentions.ts` | resolver @menciones desde `contextInfo`, nombres de autores |

### Postgres (conexión kind `postgres`)
| Archivo | Rol |
|---|---|
| `sql-engine.ts` | **seam** para todos los kinds SQL (`switch…assertNever`): `listSqlTables`, `describeSqlTable`, `runSqlRead`, `runSqlWrite`, `sqlKindOf` |
| `pg-pool.ts` | `pgFor(instance)`, `keyedPool`, `resolvePgTarget`, `probePgConnection` |
| `pg-guard.ts` (463) | análisis de plan EXPLAIN: `readPlan`, `assertNoWrites`, `assertIsModify`, `assertFunctionsSafe`, `assertRelationsInScope`, `unsafeSingle` |
| `pg-run.ts` | compone pool+guard en una transacción: `runReadQuery` (cursor), `runWriteStatement` |
| `pg-catalog.ts` | introspección: `listPgTables`, `describePgTable` |
| `db-rows.ts` | serialización/recorte de celdas (`serialiseRows`) |

### Telegram
| Archivo | Rol |
|---|---|
| `telegram.ts` | cliente HTTP del bridge: `telegramBridgeForInstance`, `useTelegramBridge` (MCP), `getTelegramStatus`, `pairingView`, `deploymentBridgeReadiness` |
| `telegram-instances.ts` | `provisionTelegramInstance`, `registerTelegramWebhook`, `deleteTelegramSession` |
| `telegram-db.ts` (604) | lectura read-only del schema `telegram`: `listTelegramChats`, `listTelegramMessagesPage`, `searchTelegramMessages` |

### IMAP
| Archivo | Rol |
|---|---|
| `imap-client.ts` (588) | imapflow: `imapFor`, `probeImapConnection`, `fetchMessageBody`, `downloadAttachment`, `searchMessageBodies` |
| `imap-sync.ts` | sincroniza cabeceras a `app.mail_*` (lease por buzón): `runImapSync`, `syncMailbox` |
| `imap-db.ts` | lecturas de `app.mail_*`: `listMailPage`, `getMailRow`, `listMailFolders`, `assertFolderAllowed`, `encode/decodeEmailId` |
| `mail-format.ts` | presentación de emails/notas para tools |

## 5. Tools MCP (`server/mcp/tools/`)

Nombre del tool = basename del archivo (único globalmente). Gate por kind + scope con `defineKindTool`.

| Grupo | Tools | kinds |
|---|---|---|
| `whatsapp/` | get-connection-status, list-chats, read-messages, search-messages, send-text-message (write) | whatsapp |
| `telegram/` | get-telegram-status, list-telegram-chats, read-telegram-messages, search-telegram-messages, send-telegram-message (write) | telegram |
| `sql/` | get-database-info, list-tables, describe-table, run-query, run-statement (write) | postgres (todos los SQL) |
| `imap/` | get-mailbox-status, list-mail-folders, list-emails, search-emails, read-email, get-email-attachment | imap |

Plantillas para copiar: `whatsapp/get-connection-status.ts` (lectura), `sql/run-statement.ts` (escritura).
Instrucciones por kind se inyectan en `server/plugins/mcp-instructions.ts` (hook `mcp:config:resolved`).

## 6. API REST (`server/api/`)

Convención Nitro: `ruta/[param]/nombre.<metodo>.ts`.

- `auth/` — login, logout, signup, signup-policy, password, profile, `verify/*` (código/enlace/resend/link-info), `mfa/*` (totp setup/confirm/delete, passkeys options/post/delete, recovery-codes), login con challenge.
- `org/` — get/patch org, `members/[id]` (patch rol, delete), `invites/` (crear, borrar, reenviar, email).
- `invites/[code]` — ver y `accept`.
- `instances/` — `index.get/post` (listar/crear), y por `[id]`: `index.get/delete`, `label.patch`, `summary.get`, `qr.get`, `reconnect.post`, `logout.post`, `resync.post`, `chats/` (+`resolve.post`), `contacts.get`, `messages.get`, `tables.get`, `dsn.patch`, `evolution-db.patch`, `telegram-db.patch`, `imap/` (get/patch/sync), `telegram/` (pair, qr, password, logout, reconnect), `assignments/`, `tokens.get/post`, `mcp-tools.get` (picker de scope; usa `kindsForTool`, no `group`).
- `tokens/[id]` — patch (scope), delete (revocar), `rotate.post`.
- `telegram/readiness.get` — estado del bridge del despliegue.
- `webhook/evolution.post`, `webhook/telegram.post` — eventos de conexión (alertas).

Toda ruta de instancia debe pasar por `requireReadableInstance*` o `requireManagedInstance*` (`org.ts`) — no hay RLS debajo.

## 7. Plugins y tareas

- `plugins/app-db.ts` — migra schema `app` al arrancar.
- `plugins/redact-mcp.ts` — limpia token de la URL en logs.
- `plugins/mcp-instructions.ts` — instrucciones MCP por kind.
- `plugins/{evolution,telegram}-db-check.ts`, `email-verification-check.ts` — avisos de config al arrancar.
- `tasks/alerts/sweep.ts` (*/5 min), `tasks/alerts/register-webhooks.ts` (cada hora), `tasks/imap/sync.ts` (*/2 min).

## 8. Base de datos

Schema `app` (`server/db/migrations.ts`, append-only — nunca editar migraciones existentes, añadir al final de `APP_MIGRATIONS`):
`users, sessions, organizations, memberships, instances, instance_assignments, invitations, mcp_tokens, totp_credentials, webauthn_credentials, recovery_codes, mfa_challenges, email_verifications, mail_sync_state, mail_folders, mail_messages`.

Schema `telegram` (bridge, `apps/telegram-bridge/src/migrations/*.sql`): `sessions, chats, users, messages`.
Schema `public`: tablas de Evolution (`Message`, `Chat`, `Contact`…) — solo lectura.

Secretos en `instances` (`api_key, admin_key, dsn, evolution_db_url, telegram_db_url, imap_password`) en texto plano; nunca salen salvo vía `toPublicInstance()`.

## 9. Frontend (`apps/web/app/`)

- **Páginas**: `index`, `login`, `signup`, `verify-email`, `no-organization`, `team` (miembros/invitaciones), `profile` (password, email, 2FA), `invite/[code]`, `instances/index` (lista), `instances/new` (crear conexión), `instances/[id]` (dashboard de conexión).
- **Middleware**: `middleware/auth.global.ts` — exige sesión + organización.
- **Layout**: `layouts/default.vue`.
- **Composables**: `useSession` (user+org+rol), `useOrg`, `useInstances`, `useConnectionState`, `useReconnect`, `useTablePage` (tablas paginadas), `useTokenScope`, `useApiAction` (wrapper de llamadas con toasts), `useConnectorUrl`.
- **Componentes por kind** (dashboard de `[id]`): `InstanceWhatsapp.vue` (QR, modos, poll), `InstanceTelegram.vue`, `InstancePostgres.vue`, `InstanceImap.vue`; comunes `InstanceHeader/Title/Card`, `MessagingOverview`, `StatCard`.
- **Tokens/scope**: `McpTokens.vue` (562, lista/crear/rotar), `TokenScopeFields.vue` (467, picker chats/tablas/tools/carpetas), `ScopeModeRadio`, `RevealTokenDialog`, `HowToConnectDialog`, `CopyableSnippet`.
- **Diálogos de datos**: `ChatsDialog`, `MessagesDialog`, `ContactsDialog`, `TablePagination`.
- **Org**: `InviteMemberDialog`, `InviteLinkDialog`, `AssignConnectionDialog`, `RoleBadge`, `DeleteConnectionDialog`.
- **Inputs**: `PostgresDsnInput`, `ImapCredentialsInput`, `DbUrlNotice`, `SessionLostNotice`, `NoticeCard`, `QrFrame`.
- **Seguridad**: `TwoFactorSettings.vue`.
- `components/ui/` = shadcn-vue generado (no tocar a mano salvo necesidad).

## 10. Telegram bridge (`apps/telegram-bridge/src/`)

| Archivo | Rol |
|---|---|
| `main.ts` | arranque |
| `config.ts` | `loadConfig` (env) |
| `http.ts` | servidor HTTP: `createBridgeServer` (rutas de pairing, estado, envío) |
| `sessions.ts` (927) | `SessionManager`: login por QR, 2FA password, estados de conexión |
| `sync/syncer.ts` | `SessionSync`: backfill + updates en vivo |
| `sync/store.ts` | `SyncStore`: escritura en schema `telegram` |
| `sync/convert.ts` | conversión de objetos MTProto a filas |
| `db.ts` | conexión, migraciones, `grantReader` |
| `crypto.ts` | sellado de sesiones (`seal/unseal`), claves |
| `locks.ts` | `SessionLocks` |
| `webhook.ts` | `deliverWebhook` a la web app |
| `http-error.ts` | errores HTTP |

## 11. Recetas: "¿dónde toco para…?"

| Quiero… | Archivos |
|---|---|
| **Añadir un tool MCP** | nuevo archivo en `server/mcp/tools/<grupo>/<nombre-unico>.ts` con `defineKindTool` (name, title, description, readOnlyHint/destructiveHint). Si va en scope picker, nada más: `mcp-tools.get.ts` lo lee de `TOOL_KINDS`. Ajustar texto en `mcp-instructions.ts` si el modelo debe saberlo. |
| **Añadir un kind de conexión nuevo** | `shared/connection.ts` (`InstanceKind`) → compilar: cada `switch…assertNever` que falle hay que decidirlo. Migración (CHECK de `kind`) en `migrations.ts`; `instanceKind()` en `mcp-scope.ts`; `McpAuth` en `mcp-auth.ts`; provision en `instances.ts`; `toPublicInstance`; `api/instances/index.post.ts`; página `instances/new.vue` + nuevo `Instance<Kind>.vue`; instrucciones; tools. |
| **Cambiar el schema de la app** | añadir migración al final de `APP_MIGRATIONS` (`server/db/migrations.ts`) + tipos en `app-db.ts`. |
| **Nueva ruta API** | `server/api/.../x.<get|post|patch|delete>.ts`; `requireSessionUser` + `requireReadableInstance*`/`requireManagedInstance*`/`requireOrgAdmin` de `org.ts`; body con `parseBody`. |
| **Cambiar lectura de mensajes WhatsApp** | SQL en `evolution-db.ts`; forma/preview en `chats.ts`; tool en `whatsapp/read-messages.ts` / `search-messages.ts`. Leer CLAUDE.md › "History arrives once" y reglas de dedupe/reacciones. |
| **Cambiar reglas del SQL de Postgres** | `pg-guard.ts` (qué se permite), `pg-run.ts` (ejecución), `pg-catalog.ts` (introspección). Leer CLAUDE.md › "Postgres connections". |
| **Cambiar scope de tokens** | `mcp-scope.ts` (enforcement), `scope-schema.ts` (input), `tokens.ts` (`scopeFields`), UI `TokenScopeFields.vue` + `useTokenScope`. |
| **Login / 2FA / signup / verificación** | `api/auth/*`, `session.ts`, `mfa.ts`, `totp.ts`, `webauthn.ts`, `signup-policy.ts`, `email-verification.ts`, `login-throttle.ts`; UI `login.vue`, `signup.vue`, `verify-email.vue`, `TwoFactorSettings.vue`. |
| **Roles / miembros / invitaciones** | `org.ts`, `invites.ts`, `api/org/*`, `api/invites/*`, `team.vue`. |
| **Alertas de desconexión** | `alerts.ts`, `tasks/alerts/*`, `api/webhook/*`, `instances.ts › registerConnectionWebhook`. |
| **IMAP** | `imap-client.ts`, `imap-sync.ts`, `imap-db.ts`, `mail-format.ts`, `tools/imap/*`, `InstanceImap.vue`. |
| **Telegram** | web: `telegram*.ts`, `tools/telegram/*`, `InstanceTelegram.vue`; bridge: `apps/telegram-bridge/src/*`. |
| **Estado/reconexión WhatsApp** | `instances.ts › getInstanceStatus/reconnectInstance`, `useConnectionState`, `useReconnect`, `InstanceWhatsapp.vue`, `SessionLostNotice.vue`. |
| **Docker / despliegue** | `docker-compose*.yml`, `apps/*/Dockerfile`, `docker/aio/`, `docs/self-hosting.md`, `docs/deploy-railway.md`. |
| **Variables de entorno** | `.env.example`, `.env.selfhost.example`, `runtimeConfig` en `nuxt.config.ts`, `apps/telegram-bridge/src/config.ts`. |

## 12. Reglas que NO se pueden romper (resumen; detalle en CLAUDE.md)

1. Auth web y MCP separadas; `session.ts` middleware ignora `/mcp*`.
2. Caída de BD → **503**, nunca 401 (`appDbUnavailable`).
3. Branches por kind con `switch` + `assertNever`, nunca `if/else`.
4. Tools siempre con `defineKindTool`; basenames únicos; sin argumento de conexión ni credenciales.
5. Sin fallback a clave global de Evolution en credenciales por instancia.
6. Hosts de usuario pasan por `net-guard.ts`.
7. Lectura de Evolution/Telegram DB: solo `SELECT` parametrizados, siempre con predicado de instancia, scope en el SQL.
8. Migraciones append-only. No editar `.nuxt/`.
9. No normalizar JIDs localmente (`resolveNumberToJid`).
10. Bump de `@nuxtjs/mcp-toolkit` o de Evolution → re-verificar lo indicado en CLAUDE.md.

## 13. Índice de secciones de CLAUDE.md (para leer solo lo necesario)

The auth split · Who may sign up · Email verification · Two-factor sign-in · MCP wiring ·
Credential rules · Postgres connections · History arrives once · Connection state ·
Mentions · Webhooks · Disconnect alerts · Organizations and roles · Invitations ·
Assignment/token rotation · Telegram bridge · IMAP connections · The app database ·
Frontend · Things that cost money · Releases · Container ports · All-in-one image.
Usar `grep -n '^## ' CLAUDE.md` y leer con offset.
