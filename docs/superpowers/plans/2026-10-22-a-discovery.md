# Lote A · Descubrimiento — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `list-chats` con búsqueda/filtros/paginación sobre todo el listado (scope antes de contar), tool nuevo `list-contacts`, e instrucciones que enseñan "grupo X → list-chats query → read-messages since".

**Architecture:** Todo sobre la caché existente `chatListing()` / `contactDirectory()` en `apps/web/server/utils/chats.ts`; los helpers del dashboard (`listChatsPage`, `listContacts`) ganan opciones opcionales que el dashboard no pasa. Normalización de texto en un módulo puro nuevo, verificable con `node`.

**Tech Stack:** Nuxt 4 / Nitro, `@nuxtjs/mcp-toolkit` 0.19.0 (`defineKindTool`), zod, TypeScript.

**Spec:** `docs/superpowers/specs/2026-10-22-a-discovery-design.md`

## Global Constraints

- Rama `feat/a-discovery`. Nada de push hasta la Task 6 (merge a `main` = deploy, aprobado por el usuario; respetar `OPS.md`: sin importación de historial en curso).
- Tools con `defineKindTool`, `kind: 'whatsapp'`, `name`/`title`/`description` explícitos, `readOnlyHint: true`, `destructiveHint: false`. Sin argumento de conexión.
- Scope fail-closed y aplicado **antes** de filtrar, contar y cortar. Ningún conteo (`total`, `hasMore`, `unnamedGroups`) puede incluir chats/contactos fuera del scope.
- `list-chats` sin argumentos: `limit` 200, `sort:'last'` (desc), `page` 1. Límites: `limit` 1–200, `query` 1–100 caracteres, `page` ≥ 1.
- `list-contacts`: `limit` 1–200 def. 100, orden nombre asc, sin filas `@g.us`, sin `profilePicUrl`, `number` solo para `@s.whatsapp.net`.
- `ChatSummary` público sin cambios de forma.
- Descripciones, notas e instrucciones en inglés. Comentarios al estilo del archivo (explican el porqué).
- Commits con las líneas de atribución:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` / `Claude-Session: https://claude.ai/code/session_01Kjjdy1CDhDnPrZEXZKTHSZ`
- Cada implementador: antes de reportar, deja el trabajo commiteado y llama `advisor()`; aplica lo que corresponda y menciónalo en el reporte.
- Sin framework de tests: RED/GREEN = `pnpm typecheck` + scripts `node` sobre módulos puros + curl JSON-RPC a `/mcp` local. Local **no** tiene WhatsApp vinculado: las pruebas con datos son en producción (Task 6).

## Review Focus

1. Token con scope de pocos chats → `total`/`hasMore`/`unnamedGroups` cuentan solo esos (Task 2, 3, 4; revisión Sonnet Task 6).
2. `fetchGroups` falla → grupo nombrado por id → `query` no lo encuentra; debe salir `unnamedGroups` + `note` (Task 2, 3).
3. `query` con acentos/mayúsculas/emoji ("chk", "PREESCOLAR", "jose"→"José") (Task 1).
4. `page` más allá del final → `chats: []`, `hasMore:false`, sin error ni `nextPage` (Task 3).
5. Agenda vacía por fallo de Evolution leída como "no tienes contactos" → `note` (Task 4).

---

### Task 1: Normalizador de búsqueda

**Files:**
- Create: `apps/web/server/utils/search-text.ts`
- Modify: `apps/web/server/utils/chats.ts` (`listChatsPage` ~l.366, `listContacts` ~l.848: reemplazar `toLowerCase().includes`)
- Test: `/tmp`-free: script en el scratchpad o `node -e`, no se commitea.

**Interfaces:**
- Produces: `export function foldForSearch(text: string): string` (minúsculas + NFD + quitar `\p{M}`); `export function matchesSearch(needle: string | undefined, ...fields: (string | undefined)[]): boolean` (needle vacío/espacios → true; compara `foldForSearch(needle.trim())` como subcadena de cada campo plegado).

- [ ] **Step 1: Prueba que falla** — script `node` que importa `apps/web/server/utils/search-text.ts` y asserta:
  `matchesSearch('chk', 'PREESCOLAR CHK 2025🏫⭐') === true`, `matchesSearch('jose', 'José Pérez') === true`, `matchesSearch('PÉREZ', 'jose perez') === true`, `matchesSearch('xyz', 'abc', undefined) === false`, `matchesSearch('  ', 'abc') === true`, `matchesSearch(undefined, 'abc') === true`.
- [ ] **Step 2:** `node <script>` → falla (módulo no existe).
- [ ] **Step 3:** Implementar `search-text.ts` (sin imports de Nitro, para que `node` lo cargue). Usar `matchesSearch` en `listChatsPage` (campos `name`, `jid`, `number`) y `listContacts` (mismos).
- [ ] **Step 4:** `node <script>` → todo pasa; `pnpm typecheck` limpio.
- [ ] **Step 5:** Commit `feat(chats): búsqueda insensible a acentos`.

### Task 2: `listChatsPage` con scope, tipo, sin leer y grupos sin nombre

**Files:**
- Modify: `apps/web/server/utils/chats.ts` (`ChatListing` l.136, `buildChatListing` l.193–300, `listChats` l.308, `ChatTableQuery`/`ChatTablePage` l.332–360, `listChatsPage` l.366)

**Interfaces:**
- Consumes: `matchesSearch` (Task 1).
- Produces:
  - `ChatTableQuery` gana `type?: 'all' | 'group' | 'direct'`, `unreadOnly?: boolean`, `allowedJids?: ReadonlySet<string>` (ausente = sin restricción).
  - `ChatTablePage` gana `unnamedGroups: number`.
  - Interno: filas de `ChatListing.chats` llevan `nameFromId: boolean` (true cuando un grupo cayó a `draft.localPart`); `listChats` y `listChatsPage` devuelven `ChatSummary` **sin** ese campo.

- [ ] **Step 1: RED** — en un archivo temporal no commiteado, llamar `listChatsPage(x, { type: 'group', unreadOnly: true, allowedJids: new Set() })` y leer `.unnamedGroups`; `pnpm typecheck` → error de tipos.
- [ ] **Step 2: Implementar.** Orden obligatorio en `listChatsPage`: (1) `allowedJids` → (2) `type` → (3) `unreadOnly` (`unreadCount > 0`) → contar `unnamedGroups` sobre este conjunto (antes de `q`, porque es lo que una búsqueda por nombre podría perder) → (4) `q` → orden → `total`, `hasMore`, corte. Quitar `nameFromId` al devolver. `listChats` también lo quita. Comentario: por qué scope va primero (un conteo previo filtra existencia).
- [ ] **Step 3: GREEN** — borrar el archivo temporal; `pnpm typecheck` limpio. Abrir el dashboard local `/instances` (sin cuentas: debe cargar sin 500).
- [ ] **Step 4:** Commit `feat(chats): filtros type/unreadOnly/scope y unnamedGroups en listChatsPage`.

### Task 3: Tool `list-chats`

**Files:**
- Modify: `apps/web/server/mcp/tools/whatsapp/list-chats.ts` (reescritura)
- Reference: `apps/web/server/utils/mcp-scope.ts:221` (`McpScope`: `allChats`, `chatJids`); otro tool con `inputSchema` zod como modelo (p. ej. `whatsapp/read-messages.ts`).

**Interfaces:**
- Consumes: `listChatsPage(instance, { q, type, unreadOnly, sort, dir, limit, page, allowedJids })` (Task 2); `useMcpAuth()` → `{ instance, scope }`.
- Produces (respuesta): `{ count, page, total, hasMore, nextPage?, truncated?, incomplete?, unnamedGroups?, note?, chats }`.

- [ ] **Step 1: RED** — `curl` local `tools/list` con un token WhatsApp local (crear conexión WhatsApp sin vincular + token en `http://localhost:3000`; si el create exige Evolution, levantar `pnpm services:up:whatsapp`): `list-chats` muestra `inputSchema` vacío.
- [ ] **Step 2: Implementar.**
  - `inputSchema`: `query` (string 1–100), `type` (enum, def. `all`), `unreadOnly` (bool), `sort` (`last`|`name`), `page` (int ≥1), `limit` (int 1–200, def. 200). `dir` = `desc` si `last`, `asc` si `name`.
  - `allowedJids`: `scope.allChats ? undefined : new Set(scope.chatJids)`.
  - `nextPage = page + 1` solo si `hasMore`. `truncated`/`incomplete`/`unnamedGroups` solo cuando true / > 0.
  - `note` (una cadena, frases concatenadas según aplique): hay más páginas; listado truncado o incompleto ("it may not contain the chat you want; try search-messages"); `unnamedGroups` > 0 con `query` ("N groups have no name right now because WhatsApp did not answer; a name search can miss them — retry in a minute or use search-messages"); `total === 0` con `query` ("try a shorter fragment or search-messages; do not conclude the chat does not exist").
  - Reescribir comentario de cabecera (el argumento "sin paginación" ya no vale: `chatListing()` cachea 60 s y paginar es cortar en memoria) y `description` (cómo encontrar un grupo por fragmento, qué significan `hasMore`/`truncated`, que `unreadCount` es el último estado que vio la conexión).
- [ ] **Step 3: GREEN** — `pnpm typecheck`; `tools/list` muestra los 6 argumentos; `tools/call list-chats {}` y `{query:"x", page: 999}` sobre la conexión sin vincular → respuesta con forma válida (`chats: []`, `hasMore:false`, sin `nextPage`), sin 500. `{limit: 500}` → error de validación.
- [ ] **Step 4:** Commit `feat(mcp): list-chats con búsqueda, filtros y paginación`.

### Task 4: `listContacts` con scope y tool `list-contacts`

**Files:**
- Modify: `apps/web/server/utils/chats.ts` (`ContactTableQuery` ~l.820, `listContacts` ~l.848)
- Create: `apps/web/server/mcp/tools/whatsapp/list-contacts.ts`

**Interfaces:**
- Consumes: `matchesSearch` (Task 1).
- Produces: `ContactTableQuery` gana `excludeGroups?: boolean`, `allowedJids?: ReadonlySet<string>`, aplicados antes de `q`/orden/corte. Tool responde `{ count, page, total, hasMore, nextPage?, note?, contacts: [{ jid, name, number? }] }`.

- [ ] **Step 1: RED** — `tools/list` local no muestra `list-contacts`.
- [ ] **Step 2: Implementar** opciones en `listContacts` (dashboard no las pasa) y el tool: `query` 1–100, `page` ≥1, `limit` 1–200 def. 100; `excludeGroups: true`; `allowedJids` como en Task 3; proyectar a `{ jid, name, number }`. `note` cuando `total === 0` y no hay `query`: "the contact list came back empty; Evolution may not have answered — this does not mean the account has no contacts". `note` de paginación como en Task 3. Comentario de cabecera: scope opción (a) del usuario, LID vs número falla cerrado, por qué no se toca `contactDirectory`.
- [ ] **Step 3: GREEN** — `pnpm typecheck`; `tools/list` muestra `list-contacts` en token WhatsApp y **no** en un token Postgres local (crear conexión Postgres al DSN local de `.env` si no existe); `tools/call list-contacts {}` → forma válida con `note` de agenda vacía.
- [ ] **Step 4:** Commit `feat(mcp): list-contacts`.

### Task 5: Instrucciones y documentación

**Files:**
- Modify: `apps/web/server/utils/mcp-instructions.ts` (`WHATSAPP_INSTRUCTIONS`, añadir al final)
- Modify: `CLAUDE.md` (Status: "Twenty-one" → "Twenty-two", añadir `list-contacts` a `whatsapp`), `CODEMAP.md:151`, `docs/using-automata.md:67` (fila `list-chats` nueva + fila `list-contacts`), `docs/mcp-roadmap.md` (M1, N3, N1 → 🟡 implementado, con log; ✅ tras Task 6)

- [ ] **Step 1:** Añadir a `WHATSAPP_INSTRUCTIONS` (inglés) el párrafo de la spec: buscar por fragmento con `list-chats` `query` (+ `type:'group'`), no recorrer la lista; varias coincidencias → preguntar al usuario; ninguna → fragmento más corto o `search-messages`, sin concluir inexistencia con `truncated`/`incomplete`/`unnamedGroups`; luego `read-messages` con `since`; `list-contacts` para nombre/número de personas.
- [ ] **Step 2:** `pnpm typecheck`; `curl` `initialize` local con token WhatsApp → `instructions` contiene `list-contacts`.
- [ ] **Step 3:** Actualizar los docs listados. Commit `docs: lote A (instrucciones, status, roadmap)`.

### Task 6: Revisión, merge y verificación en producción

- [ ] **Step 1: Revisión de scope (Sonnet).** Lanzar un agente `general-purpose` con `model: sonnet` sobre `git diff main...feat/a-discovery`: buscar cualquier camino por el que `total`, `hasMore`, `count`, `unnamedGroups`, `note` o `chats`/`contacts` revelen algo fuera de `scope.chatJids`; y que `nameFromId` no salga en ninguna respuesta (MCP ni API del dashboard). Aplicar hallazgos válidos (`superpowers:receiving-code-review`).
- [ ] **Step 2: Revisión general** con `superpowers:requesting-code-review` sobre el diff de la rama.
- [ ] **Step 3: Baseline.** Confirmar que existen `baseline-list-chats-{GT,CH}.txt` en el scratchpad (capturados 2026-10-22 en `main`).
- [ ] **Step 4: Merge + push a `main`** (`superpowers:finishing-a-development-branch`). Antes, confirmar con el usuario que no hay importación en curso. Seguir el deploy en Coolify (stop-then-start).
- [ ] **Step 5: Criterios en producción** con `GT_TOKEN` / `CH_TOKEN` de `.env` (sin imprimirlos):
  - `list-chats {}` (ambos): ≤200 filas, misma forma que el baseline, orden por última actividad.
  - CL: `{query:"chk", type:"group"}` → exactamente `PREESCOLAR CHK 2025🏫⭐`; `{query:"preescolar"}` y `{query:"PREÉSCOLAR"}` también lo encuentran.
  - Paginar con `limit: 100` hasta `hasMore:false`: suma de `count` = `total`.
  - `{unreadOnly:true}` → solo `unreadCount > 0`.
  - `list-contacts {query:"<un nombre del baseline>"}` → contacto con `number`; ninguna fila `@g.us`.
- [ ] **Step 6:** Pedir al usuario la prueba en Claude.ai ("resume lo de esta semana en el grupo CHK") y anotar si `unreadCount` baja tras leer en el teléfono.
- [ ] **Step 7:** Roadmap M1/N3/N1 → ✅ con log; commit y push (doc-only, avisar que dispara deploy) o dejar para el siguiente lote.
