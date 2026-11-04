# MCP WhatsApp — evaluación y roadmap

> Evaluación de los tools MCP de WhatsApp (fork `mangandini/automata-mcp`) y tracking
> de mejoras. Actualizar el **estado** y el **log** de cada ítem al trabajarlo.
> Creado 2026-10-22. Contexto de código: `CODEMAP.md`; reglas de diseño: `CLAUDE.md`
> (sección "MCP wiring"); despliegue: `OPS.md`.

**Estados:** ⬜ pendiente · 🟦 en curso · 🟨 en local (sin deploy) · ✅ desplegado y verificado · ⛔ descartado

## Resumen

| ID | Ítem | Tipo | Prioridad | Estado |
|---|---|---|---|---|
| M1 | `list-chats`: búsqueda, filtro grupo/directo, paginación | Mejora | Alta | ✅ |
| N1 | `list-contacts` | Nuevo | Alta | ✅ |
| M2 | `search-messages`: búsqueda completa (acentos, OR, número, páginas, autor, archivos, contexto) | Mejora | Alta | ✅ |
| N2 | `get-group-info` (participantes, admins, descripción) | Nuevo | Media | ⬜ |
| N3 | `list-unread` (pendientes) | Nuevo | Media | ✅ |
| M3 | `send-text-message`: enviar a grupos (`jid`) y citar | Mejora | Media | ⬜ |
| N4 | `get-message-media` (descargar adjuntos) | Nuevo | Baja | 🔧 en rama `feat/e-media` (falta verificar en producción) |
| M4 | Rechazar argumentos desconocidos en **todos** los tools (global) | Mejora | Baja | ⬜ |
| X1 | Conector único para varios números | — | — | ⛔ |

## Lotes de trabajo

Cada lote = **un** ciclo Superpowers (brainstorming → … → cierre, ver `CLAUDE.md`) y una rama `feat/<lote>-<slug>`. Agrupados por archivos tocados y riesgo, no por prioridad.

| Lote | Ítems | Rama | Nivel | Motivo |
|---|---|---|---|---|
| **A · Descubrimiento** | M1 + N3 + N1 | `feat/a-discovery` | Architectural (spec + plan cortos) | Mismo código (`utils/chats.ts`, `contactDirectory()`), misma decisión de scope, un solo rediseño de `WHATSAPP_INSTRUCTIONS`. N3 se resuelve como `unreadOnly` de M1. Solo lectura. |
| **B · Búsqueda** | M2 | `feat/b-search` | Architectural (spec + plan) | Búsqueda completa: acentos, OR, número, paginación, autor por nombre, archivos, contexto. SQL delicado en `evolution-db.ts` (dedupe `DISTINCT ON` + `LIMIT/OFFSET`). |
| **C · Grupos** | N2 | `feat/c-group-info` | Bounded | Evolution en vivo (socket, `rate-overlimit`/428); riesgo distinto, no comparte archivos. |
| **D · Envío** | M3 | `feat/d-send-groups` | Bounded + revisión estricta | Única escritura (envía a terceros); prueba real en grupo propio. |
| **E · Adjuntos** | N4 | `feat/e-media` | Architectural | Requiere decidir opt-in por scope, tope de tamaño y privacidad. |
| **F · Rendimiento del panel** | P1 | `feat/f-dashboard-perf` | Bounded (medir primero) | No es MCP: tablas del dashboard. Separado de A para no mezclar riesgos. |

**Orden:** A → B → C → D → E; F cuando se decida (independiente).

**Ejecución:**
- Dentro de A, tareas **secuenciales** (comparten `chats.ts` y `mcp-instructions.ts`; subagentes en paralelo chocarían).
- B y C son independientes, pero se hacen uno a uno.
- Se pueden **agrupar deploys**: mergear varios lotes en local y hacer un solo push a `main` (cada push = deploy en Coolify; minimizar mientras no esté activo el nombre de contenedor consistente, ver `OPS.md`).

## Estado actual de los tools (2026-10-22)

Archivos en `apps/web/server/mcp/tools/whatsapp/`. Todos se definen con `defineKindTool` (kind `whatsapp`), van filtrados por el scope del token y no reciben argumento de conexión.

| Tool | Parámetros | Lee de | Observaciones |
|---|---|---|---|
| `get-connection-status` | — | Evolution HTTP | OK |
| `list-chats` | **ninguno** | `listChats(instance)` → `chatListing()` (caché 60 s) | Devuelve siempre los 200 más recientes (`count: 200, hasMore: true`). Sin búsqueda, filtro ni página. El comentario del handler ya anticipa el problema ("raise the page size here if that becomes real"). |
| `read-messages` | `jid`, `limit` (1–200, def. 50), `page`, `since`, `until`, `includeReactions` | `listMessages()` → `listMessagesPage()` (SQL Evolution) | Completo. Pagina, fija `until` para rangos, informa `hasMore`, `totalMatching`, `protocolMessagesExcluded`. |
| `search-messages` | `query` (≥2, AND de palabras), `jid?`, `since?`, `until?`, `fromMe?`, `limit` (1–100, def. 20), `includeReactions` | `searchMessages()` (SQL Evolution) | Sin `page`: tope de 100 coincidencias. Sin filtro por autor en grupos. |
| `send-text-message` | `number`, `text` | Evolution `POST /message/sendText` | Solo números (no grupos). Sin cita/respuesta. Scope verificado con `assertNumberAllowed`. |

Hallazgos de la prueba real (2026-10-22, ambos tokens contra producción):
- `list-chats` devolvió 200 chats por número; GT 34 grupos visibles, CL 17. Los grupos sin actividad reciente quedan fuera → no se puede responder "¿en qué grupos estoy?" de forma completa.
- Pasar `{"limit":3}` a `list-chats` se ignora (no tiene schema).
- En GT los grupos no traen `participantCount` (caché de metadatos de grupo incompleta por `rate-overlimit` durante la importación).

## Reglas a respetar en cualquier cambio

(resumen; detalle en `CLAUDE.md` › "MCP wiring" y "Credential rules")

- Definir con `defineKindTool`, nunca `defineMcpTool`; `name`, `title`, `description` pensada para el modelo, `readOnlyHint`/`destructiveHint` correctos.
- Basename del archivo único en todo `tools/` (el nombre del tool sale de ahí).
- Sin argumento de conexión ni credenciales como parámetro.
- Scope del token como **predicado / filtro antes de devolver** (predicado en SQL vía `allowedJids`, `assertChatAllowed`, `assertNumberAllowed`); fallar cerrado.
- Las páginas dicen que son páginas: `hasMore` (de `limit+1`, nunca de `total`), `note` en palabras cuando hay más.
- Nunca normalizar JIDs localmente (`resolveNumberToJid`).
- Lecturas de mensajes solo por SQL parametrizado con `"instanceId"` (`evolution-db.ts`).
- Texto para el modelo en `server/utils/mcp-instructions.ts › WHATSAPP_INSTRUCTIONS` si cambia cómo usar los tools.
- Verificación: `pnpm typecheck` (no hay tests). Probar en local y contra producción con `curl` JSON-RPC (ver "Cómo probar").
- Deploy = push a `main` → Coolify. Ver reglas en `OPS.md` (no durante importaciones; evitar rolling update).

---

## M1 · `list-chats`: búsqueda, filtro y paginación — Alta · ✅

**Problema.** Sin parámetros; solo los 200 chats más recientes. Grupos/chats antiguos inalcanzables salvo por `search-messages`.

**Propuesta.** Parámetros opcionales (sin ellos, comportamiento compatible):
- `query?: string` — subcadena en nombre, número o jid.
- `type?: 'all' | 'group' | 'direct'` (def. `all`).
- `sort?: 'last' | 'name'`, `page?: number` (1-based), `limit?: number` (1–200, def. 200).
- Respuesta: `chats`, `count`, `page`, `hasMore`, `total` (si se conoce), `truncated`/`incomplete` traducidos a `note`.

**Base existente.** `listChatsPage(instance, { q, sort, dir, limit, page })` en `utils/chats.ts` (la usa el dashboard `api/instances/[id]/chats/index.get.ts`); trabaja sobre `chatListing()` (recorre hasta 10 000 chats, caché 60 s). Falta el filtro `type` (por `isGroup`).

**Cuidados.**
- El scope debe aplicarse **antes** de paginar (si se filtra después, las páginas salen cortas o vacías). Revisar si `listChatsPage` acepta el filtro o si hay que filtrar `chats` por scope primero.
- Mantener las dos banderas distintas: `truncated` (más de 10 000) ≠ `incomplete` (Evolution falló) ≠ `hasMore`.
- Actualizar `WHATSAPP_INSTRUCTIONS` para que el modelo sepa buscar por nombre.

**Criterios de aceptación.**
- [ ] `list-chats {type:"group"}` pagina hasta listar todos los grupos de GT/CL.
- [ ] `list-chats {query:"familia"}` encuentra chats fuera de los 200 más recientes.
- [ ] Sin argumentos devuelve lo mismo que hoy (compatibilidad).
- [ ] Token con scope de chats solo ve sus chats y `hasMore` coherente.
- [ ] `pnpm typecheck` OK.

**Log.**
- 2026-10-22 — evaluado.
- 2026-10-22 — implementado en `feat/a-discovery` (🟨 hasta verificar en producción). Defaults decididos: `limit` 200, `sort` `last`. Añade `unreadOnly` (resuelve N3) y `WHATSAPP_INSTRUCTIONS` enseña a buscar por nombre.

## N1 · `list-contacts` — Alta · ✅

**Problema.** Para escribir o leer a alguien, el modelo necesita su `jid`/número; hoy solo puede deducirlo de `list-chats` (top 200) o buscando mensajes.

**Propuesta.** Tool de lectura `list-contacts { query?, page?, limit? }` → `{ contacts: [{ jid, number, name }], hasMore, total }`.

**Base existente.** `listContacts()` y `contactDirectory()` (caché 5 min) en `utils/chats.ts`; endpoint del dashboard `api/instances/[id]/contacts.get.ts`.

**Cuidados.**
- Scope: con token limitado a chats, ¿se muestran contactos fuera del scope? Propuesta: filtrar al scope (fallar cerrado) — decidir.
- Contactos `@lid` sin número: devolver lo que haya, sin inventar número.

**Criterios de aceptación.**
- [ ] Buscar un contacto por nombre devuelve su jid/número.
- [ ] Paginación con `hasMore`.
- [ ] Respeta scope.
- [ ] `pnpm typecheck` OK.

**Log.**
- 2026-10-22 — evaluado.
- 2026-10-22 — implementado en `feat/a-discovery` (🟨 hasta verificar en producción): `list-contacts { query, page, limit }`.

## M2 · `search-messages`: búsqueda completa (lote B) — Alta · ✅

**Medido en producción (2026-10-22, búsquedas reales de solo lectura en GT/CL + código).**

| Comportamiento hoy | Evidencia |
|---|---|
| No pliega acentos (sí mayúsculas) | Chat CL: "fogón" 1, "fogon" 0. Cuenta CL: "fogón" 7 / "fogon" 1, 0 en común; "mañana" ≥100 / "manana" 27, 1 en común. `evolution-db.ts:314` (`ILIKE ALL`, sin unaccent) |
| Exige todas las palabras (AND) | "fogón costo" 0, "fogón" 1, "costo" 2 |
| `jid` = igualdad exacta de cadena | `…@s.whatsapp.net` 1; `+569…`, `569…`, `…@c.us` → **0 sin error** |
| Tope 100, sin paginación | "hola" → 100 + `truncated:true`; claves: query, matches, count, truncated, reactionsExcluded (sin hasMore/total/nextPage) |
| Argumentos desconocidos ignorados en silencio | `page:2`, `sender:"x"` → resultado normal |
| No busca en nombre de archivo | COALESCE `evolution-db.ts:520-558`: texto y captions; sin `documentMessage.fileName`/`title`. "xlsx" 0 |
| Sin filtro por autor | Solo `fromMe`; cada resultado sí trae `author` |
| Sin contexto alrededor de un resultado | `read-messages`: solo `since/until/page`, nada "alrededor del mensaje X" |
| Latencia en frío 7,7 s (CL) / 11,9 s (GT); caliente 0,8–2 s | llamadas (frío → lote F) |

Los tres fallos silenciosos (acentos, número mal formado, argumentos ignorados) hacen que Claude responda "no hay nada" con seguridad cuando sí lo hay. Caso real que lo destapó: "costo del fogón" en un chat 1:1 de CL (encontrado solo porque se pasaron ambas grafías y el jid completo).

**Alcance acordado (corregir todas las filas).**
- `search-messages`:
  - Insensible a acentos y mayúsculas (mismo criterio que `list-chats`), resuelto en el SQL de solo lectura; nada se instala en la BD de Evolution.
  - AND por defecto + opción "cualquiera de estas palabras".
  - Chat por número en cualquier forma, resuelto con Evolution (`resolveNumberToJid`, nunca normalizar local); chat no encontrado → se dice, no "0 resultados".
  - Paginación: `page`, `hasMore` (de `limit+1`), `nextPage`, total; dedupe `DISTINCT ON` dentro del CTE con `LIMIT/OFFSET` fuera; orden `messageTimestamp DESC, key->>'id' DESC`.
  - Argumentos desconocidos → error, no silencio.
  - Buscar también en nombre/título de documento (rutas explícitas, nada de `$.**`).
  - Filtro por autor (ver decisión abajo).
- `read-messages`: contexto alrededor de un mensaje (N antes y después de un id).
- Fuera: lentitud en frío (lote F), descargar el archivo (lote E).

**Decisión del usuario — autor por nombre, no por agenda.** "Lo que dijo Juan en el grupo X" debe buscar los mensajes de esa persona en ese grupo. Un usuario real **no guarda como contacto** a los miembros de un grupo (lo agregan a grupos de ~100 personas y no chatea con ellos), así que el filtro **no puede depender de `contactDirectory()`**. El nombre debe salir de lo que el propio grupo muestra: el nombre que cada miembro publica en sus mensajes (`pushName`) y los participantes del grupo; el número/jid/LID del autor también debe aceptarse. Varias personas que coinciden (dos "Juan") → devolver los candidatos y que el modelo pregunte, no mezclar.

**Pendiente de diseño (spec).** Cómo emparejar nombre ↔ autor cuando el autor viene como LID; qué hacer si `pushName` varía entre copias del mismo mensaje (ver dedupe/`bestNamed()`); N por defecto del contexto (propuesta ~10 a cada lado).

**Criterios de aceptación.**
- [ ] CL chat del caso: "fogon" encuentra el mensaje de "fogón".
- [ ] `jid`/número `+56…`, `56…` y jid completo dan el mismo resultado; número inexistente → mensaje explícito.
- [ ] Búsqueda con >100 resultados recorrible por páginas sin duplicados ni huecos (suma = total).
- [ ] Autor por nombre en un grupo, con un miembro que no está en contactos.
- [ ] "xlsx" encuentra el documento del caso N4 por su nombre.
- [ ] Contexto alrededor de un resultado devuelve los mensajes previos/siguientes del mismo chat.
- [ ] Argumento desconocido → error.
- [ ] `pnpm typecheck` OK.

**Log.**
- 2026-10-22 — evaluado.
- 2026-10-22 — medido en producción (tabla arriba); alcance ampliado de "paginación y autor" a búsqueda completa; nivel Bounded → Architectural; decisión de autor por nombre sin depender de contactos.
- 2026-11-04 — ✅ desplegado (lote B). Los seguimientos de rendimiento `fc24e9a` (plegado de acentos por etapas, texto evaluado una vez por mensaje) y `dda55f2` (el payload de cada mensaje se lee una vez, no una por consulta jsonb) devolvieron la búsqueda de toda la cuenta a un tiempo cercano al previo al lote B. Guía de uso y salvedades: `docs/searching-whatsapp.md`.
- **Seguimiento (lote F / P1): nombrar remitentes en una búsqueda.** Con muchos resultados la búsqueda es lenta por *nombrar* a los remitentes, no por el SQL: cuesta el directorio de contactos más hasta 8 consultas en vivo de participantes de grupo (`MENTION_GROUP_LOOKUPS` en `search-messages.ts`). Una búsqueda de 134 resultados tardó ~12,5 s en una cuenta. Candidatos: caché corta de participantes por grupo y lanzar las consultas en paralelo.

## N2 · `get-group-info` — Media · ⬜

**Propuesta.** `get-group-info { jid }` → nombre, descripción, creador, creado, participantes (jid, nombre resuelto, admin), total.

**Base existente.** `mentions.ts › addGroupMembers` (ya consulta participantes); Evolution `GET /group/findGroupInfos/{instance}?groupJid=` y `/group/participants/{instance}`.

**Cuidados.** `assertChatAllowed` sobre el jid; Evolution puede responder `rate-overlimit`/428 → respuesta honesta (no lista vacía); usar caché (`lookup-cache.ts › staleWhileFailing`).

**Criterios de aceptación.**
- [ ] Devuelve participantes de un grupo de 46 personas (CL "4to Grado 2026").
- [ ] Error de Evolution se informa, no se devuelve vacío.

**Log.**
- 2026-10-22 — evaluado.

## N3 · `list-unread` — Media · ✅

**Propuesta.** Chats con `unreadCount > 0`, ordenados por última actividad, con preview. Alternativa más barata: `list-chats {unreadOnly:true}` dentro de M1 (preferible: menos tools).

**Cuidados.** `unreadCount` viene de Evolution y en grupos grandes es alto (CL "4to Grado 2026": 2636); verificar que se actualiza al leer en el teléfono.

**Log.**
- 2026-10-22 — evaluado; probablemente se resuelve como opción de M1.
- 2026-10-22 — resuelto como `unreadOnly` de `list-chats` (M1), sin tool nueva; 🟨 hasta verificar en producción.
- 2026-10-22 — ✅ en producción (deploy 2180468): CL `query:"chk", type:"group"` → `PREESCOLAR CHK 2025🏫⭐`; paginación por nombre GT 551/551, CL 566/566 sin duplicados; `unreadOnly` GT 11, CL 4; `list-contacts` GT 2722, CL 2192 sin grupos ni ids como nombre. Justo tras el deploy (Evolution aún arrancando) `list-chats` respondió 0 filas con `incomplete` + nota — comportamiento honesto esperado.

## M3 · `send-text-message`: grupos y cita — Media · ⬜

**Problema.** Solo `number`; no envía a grupos ni responde citando.

**Propuesta.** Aceptar `jid?` (incl. `@g.us`) como alternativa a `number`; `quotedMessageId?` para responder.

**Cuidados (escritura → más riesgo).**
- Scope: `assertChatAllowed` para jid de grupo; mantener `assertNumberAllowed` para números. Fallar cerrado.
- Confirmar formato de Evolution 2.3.7 para `quoted` en `sendText`.
- Mantener `destructiveHint: false`, `idempotentHint: false`; la descripción debe dejar claro que envía a terceros.

**Criterios de aceptación.**
- [ ] Envío a un grupo de prueba propio.
- [ ] Respuesta citando un mensaje.
- [ ] Token con scope sin ese grupo → rechazo.

**Log.**
- 2026-10-22 — evaluado.
- 2026-11-04 — nota del lote B: `resolveChatTarget` (usado por `read-messages`/`search-messages` con un número como `jid`) paga una consulta a `relatedChatJids` por llamada, que recorre las filas de la cuenta (único índice: `instanceId`). Ese coste por página/por llamada pasa al lote F, no al M3.
- 2026-11-04 — lote D, hallazgo F5 (a resolver en D, no en B): en el camino de envío `assertNumberAllowed` (`mcp-scope.ts`) deja pasar tal cual el 422 de `resolveNumberToJid` cuando Evolution no resuelve el número, pero responde 403 (`assertChatAllowed`) cuando lo resuelve y está fuera del scope. Un token con scope de chats puede así distinguir "número que no resuelve" de "número que existe pero fuera de mi scope" = oráculo para sondear números. Las lecturas ya lo evitan (`resolveChatTarget` responde un único `NOT_ACCESSIBLE` a token acotado). Al tocar el envío en D, unificar el error para tokens acotados.

## N4 · `get-message-media` — Media · 🔧

**Problema (caso real, 2026-10-22, conexión CL).** Un monto que el usuario necesitaba no estaba escrito en ningún mensaje: estaba en un documento adjunto (`[document] ….xlsx`, mensaje de 2026-05-14) y en capturas `[image]` de transferencias (2026-05-19) de un chat 1:1. Con los tools actuales solo se ve el nombre del archivo y el id; no hay forma de bajarlo por MCP. Los adjuntos son a menudo donde está el dato (cotizaciones, comprobantes, circulares del colegio).

**Propuesta (según la spec del lote E).** Tool de lectura **opt-in** `get-message-media { messageId }`: imagen → bloque `image` reducido; PDF → texto extraído; cualquier otro documento (xlsx, docx, …) → **solo metadatos + enlace de descarga**, sin bloques `resource` (Claude.ai no los lee de forma fiable). Cada llamada crea un enlace público temporal (1 h, 20 descargas) que el modelo entrega al usuario.

**Base existente.** Evolution `POST /chat/getBase64FromMediaMessage/{instance}` con el `key.id`; `get-email-attachment` (bloques de contenido, tope de tamaño).

**Cuidados.**
- Scope como predicado en SQL sobre el `remoteJid` de la fila (sin argumento de chat), antes de descargar o leer la caché.
- Tope configurable tipo `NUXT_IMAP_ATTACHMENT_MAX_BYTES`; rechazar por tamaño declarado antes de descargar y re-verificar en bytes.
- Opt-in por scope de tools (privacidad).
- Medios antiguos pueden haber **expirado** en los servidores de WhatsApp: error explícito y honesto, nunca respuesta vacía.
- No hacer descargas puntuales fuera del MCP con la API key de la instancia (alternativa evaluada y descartada).

**Criterios de aceptación.**
- CL: el `.xlsx` del mensaje de 2026-05-14 del caso anterior → metadatos + enlace de descarga (no se lee dentro); una captura `[image]` de transferencia → el modelo la ve y lee el monto.
- Medio expirado → error explícito que lo dice.
- Mensaje de un chat fuera del scope del token → el mismo 404 único que un id inexistente (no el 403 de `read-messages`: aquí el id no debe poder sondearse).
- Medio sobre el tope de enlace (25 MB) → rechazado antes de descargar; sobre el de lectura (10 MB) → solo enlace.

**Log.**
- 2026-10-22 — evaluado.
- 2026-10-22 — caso real en CL (adjunto .xlsx + capturas con el monto buscado); prioridad Baja → Media. Orden de lotes sin cambio (E sigue después de D); reconsiderar adelantarlo si aparecen más casos.
- 2026-11-04 — lote E: implementado en `feat/e-media` (tool `get-message-media`, opt-in, `media-read.ts`, ruta pública `/api/media/<token>`); pendiente la verificación en producción con un adjunto real (criterios con CL).

## M4 · Rechazar argumentos desconocidos en todos los tools — Baja · ⬜

**Problema.** Un argumento que el tool no declara se ignora en silencio y la llamada devuelve un resultado normal, como si el filtro hubiera funcionado (medido en `search-messages`: `page:2` y `sender:"x"` → resultado normal, 2026-10-22). Claude puede creer que filtró por algo que no se aplicó.

**Alcance decidido.** El lote B (M2, decisión D5) lo hace **solo** en `search-messages` y `read-messages`. Este ítem es la extensión a los 22 tools (Telegram, IMAP, `sql/`, el resto de WhatsApp). Se separó a propósito: tocar `defineKindTool` cambia el comportamiento de tools que el lote B no prueba.

**Propuesta.** Reutilizar el mecanismo que el lote B deje funcionando (probablemente en `defineKindTool`, `server/utils/mcp-kind-tool.ts`), con un error 400 que nombre el argumento y liste los válidos.

**Cuidados.** Verificar contra el toolkit 0.19.0 (`@nuxtjs/mcp-toolkit`, pinned); re-verificar en cada bump. Probar `tools/list` y una llamada con argumento extra en cada kind. Clientes que envíen campos extra de forma rutinaria dejarían de funcionar: revisar antes con una muestra de llamadas reales.

**Criterios de aceptación.**
- [ ] Argumento desconocido → error 400 en cada tool de los cuatro kinds.
- [ ] Llamadas válidas sin cambios (los 22 tools).
- [ ] `pnpm typecheck` OK.

**Log.**
- 2026-10-22 — decidido dejarlo fuera del lote B; documentado para no perderlo.

## X1 · Conector único para varios números — ⛔

Contradice la regla "un token = una conexión, sin argumento de conexión" (`CLAUDE.md`). Con dos conectores en Claude ("WhatsApp GT", "WhatsApp CL") funciona. No se hará.

---

## Cómo probar

Local: `pnpm services:up:whatsapp` + `pnpm dev` (puertos en `OPS.md`). Producción: tokens en `.env` (`GT_TOKEN`, `CH_TOKEN`, gitignored).

```bash
T=$(grep '^GT_TOKEN=' .env | cut -d= -f2)
curl -s https://wa.royale.ventures/mcp \
  -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list-chats","arguments":{}}}'
# listar tools disponibles: "method":"tools/list"
```

## Log general

- 2026-10-22 — Evaluación inicial; documento creado.
- 2026-10-22 — Ítems agrupados en lotes A–E (ver "Lotes de trabajo").

## P1 · Dashboard: Messages/Chats lentos — Media · ⬜

**Medido (2026-10-22, navegador, conexión GT ~69k mensajes).** `GET /api/instances/:id/messages?page=1&limit=100`: **9,4 s** en frío (TTFB), **1,1–1,3 s** en caliente (base `GET /api/instances/:id` ≈ 330 ms). `limit=10` cuesta lo mismo que 100; `page=300` 1,5 s; `q=hola` 2,3 s. Render del frontend 14 ms → no es el cliente.

**Hipótesis (sin verificar en servidor).**
- Frío: `accountNames()` → `contactDirectory()` (tabla de contactos completa, caché 5 min) + `fetchGroups()` en vivo contra WhatsApp (muchos grupos, `rate-overlimit`).
- Caliente: `listMessagesPage()` sin `jid` = `DISTINCT ON` + `COUNT(*) OVER ()` sobre todo el `Message` de la cuenta; único índice `@@index([instanceId])`.
- Menor: al cerrar el modal se vuelve a pedir `GET /api/instances/:id`; además el panel hace poll cada 15 s.

**Siguiente paso.** `Server-Timing` por paso (auth, SQL, nombres) + `EXPLAIN (ANALYZE, BUFFERS)`; luego decidir (caché de grupos, `total` solo en página 1, índice propio en `public."Message"` — ojo: es tabla de Evolution, re-verificar en bump de tag).

**Log.**
- 2026-10-22 — medido Messages.
- 2026-10-22 — medido Chats (`/chats?limit=100&sort=last`). GT: frío **9,3 s**, caliente 272 ms, búsqueda ~270–300 ms (no es lenta). CL: frío 974 ms, caliente ~275 ms. El frío de GT ≈ el de Messages → paso compartido por instancia, no la consulta: candidatos `contactDirectory()` (tabla de contactos completa, 5 min) y `fetchGroups()` (en vivo, 5 min). El poll de 15 s a `/api/instances/:id` no lo mantiene caliente. MCP `list-chats` (baseline del lote A) mostró lo mismo: CL 8,1 s en frío, GT 1,6 s (ya caliente). El diálogo **New token** pide `/chats` sin parámetros (63 KB, todos) y también paga los 9 s.
- Card vs lista (GT 697 vs 551, CL 668 vs 566): **esperado, no es bug** — la card cuenta filas de `Chat` (`_count.Chat`) y la lista sale de `Message` (`findChats`); `messaging-history.set` escribe un `Chat` por cada conversación del teléfono aunque no traiga mensajes (ver CLAUDE.md › "`_count.Chat` and `findChats` count different tables"). Opcional en P1: rotular la card ("chats en el teléfono") para que no parezca un error.
- 2026-11-04 — pendientes que aterrizan aquí desde el lote B: (a) nombrar remitentes en `search-messages` (~12,5 s en una búsqueda de 134 resultados; ver log de M2) y (b) la consulta `relatedChatJids` que se repite en cada llamada/página al usar un número como `jid` (ver log de M3).
