# MCP WhatsApp — evaluación y roadmap

> Evaluación de los tools MCP de WhatsApp (fork `mangandini/automata-mcp`) y tracking
> de mejoras. Actualizar el **estado** y el **log** de cada ítem al trabajarlo.
> Creado 2026-10-22. Contexto de código: `CODEMAP.md`; reglas de diseño: `CLAUDE.md`
> (sección "MCP wiring"); despliegue: `OPS.md`.

**Estados:** ⬜ pendiente · 🟦 en curso · 🟨 en local (sin deploy) · ✅ desplegado y verificado · ⛔ descartado

## Resumen

| ID | Ítem | Tipo | Prioridad | Estado |
|---|---|---|---|---|
| M1 | `list-chats`: búsqueda, filtro grupo/directo, paginación | Mejora | Alta | ⬜ |
| N1 | `list-contacts` | Nuevo | Alta | ⬜ |
| M2 | `search-messages`: paginación + filtro por autor | Mejora | Media | ⬜ |
| N2 | `get-group-info` (participantes, admins, descripción) | Nuevo | Media | ⬜ |
| N3 | `list-unread` (pendientes) | Nuevo | Media | ⬜ |
| M3 | `send-text-message`: enviar a grupos (`jid`) y citar | Mejora | Media | ⬜ |
| N4 | `get-message-media` (descargar adjuntos) | Nuevo | Baja | ⬜ |
| X1 | Conector único para varios números | — | — | ⛔ |

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
- Scope del token como **predicado / filtro antes de devolver** (`filterChatsToScope`, `assertChatAllowed`, `assertNumberAllowed`); fallar cerrado.
- Las páginas dicen que son páginas: `hasMore` (de `limit+1`, nunca de `total`), `note` en palabras cuando hay más.
- Nunca normalizar JIDs localmente (`resolveNumberToJid`).
- Lecturas de mensajes solo por SQL parametrizado con `"instanceId"` (`evolution-db.ts`).
- Texto para el modelo en `server/utils/mcp-instructions.ts › WHATSAPP_INSTRUCTIONS` si cambia cómo usar los tools.
- Verificación: `pnpm typecheck` (no hay tests). Probar en local y contra producción con `curl` JSON-RPC (ver "Cómo probar").
- Deploy = push a `main` → Coolify. Ver reglas en `OPS.md` (no durante importaciones; evitar rolling update).

---

## M1 · `list-chats`: búsqueda, filtro y paginación — Alta · ⬜

**Problema.** Sin parámetros; solo los 200 chats más recientes. Grupos/chats antiguos inalcanzables salvo por `search-messages`.

**Propuesta.** Parámetros opcionales (sin ellos, comportamiento compatible):
- `query?: string` — subcadena en nombre, número o jid.
- `type?: 'all' | 'group' | 'direct'` (def. `all`).
- `sort?: 'last' | 'name'`, `page?: number` (1-based), `limit?: number` (1–200, def. 100).
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

## N1 · `list-contacts` — Alta · ⬜

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

## M2 · `search-messages`: paginación y autor — Media · ⬜

**Problema.** Máximo 100 coincidencias sin forma de seguir; no se puede filtrar "lo que dijo X en el grupo Y".

**Propuesta.** `page?: number`; `sender?: string` (jid o número del autor, resuelto con Evolution, no normalizado localmente). Devolver `hasMore` (de `limit+1`) y `nextPage`.

**Base existente.** `searchMessages()` en `utils/evolution-db.ts` (SQL con `DISTINCT ON (key->>'id')`, `COALESCE` de rutas explícitas). El autor en grupos está en `key->>'participant'` (o variantes `@lid`); revisar `senderOf()`.

**Cuidados.** Mantener el dedupe dentro del CTE con `LIMIT/OFFSET` fuera; nada de `$.**` en jsonpath; orden estable `messageTimestamp DESC, key->>'id' DESC`.

**Criterios de aceptación.**
- [ ] Búsqueda con >100 resultados recorrible por páginas sin duplicados ni huecos.
- [ ] `sender` filtra correctamente en un grupo.
- [ ] `pnpm typecheck` OK.

**Log.**
- 2026-10-22 — evaluado.

## N2 · `get-group-info` — Media · ⬜

**Propuesta.** `get-group-info { jid }` → nombre, descripción, creador, creado, participantes (jid, nombre resuelto, admin), total.

**Base existente.** `mentions.ts › addGroupMembers` (ya consulta participantes); Evolution `GET /group/findGroupInfos/{instance}?groupJid=` y `/group/participants/{instance}`.

**Cuidados.** `assertChatAllowed` sobre el jid; Evolution puede responder `rate-overlimit`/428 → respuesta honesta (no lista vacía); usar caché (`lookup-cache.ts › staleWhileFailing`).

**Criterios de aceptación.**
- [ ] Devuelve participantes de un grupo de 46 personas (CL "4to Grado 2026").
- [ ] Error de Evolution se informa, no se devuelve vacío.

**Log.**
- 2026-10-22 — evaluado.

## N3 · `list-unread` — Media · ⬜

**Propuesta.** Chats con `unreadCount > 0`, ordenados por última actividad, con preview. Alternativa más barata: `list-chats {unreadOnly:true}` dentro de M1 (preferible: menos tools).

**Cuidados.** `unreadCount` viene de Evolution y en grupos grandes es alto (CL "4to Grado 2026": 2636); verificar que se actualiza al leer en el teléfono.

**Log.**
- 2026-10-22 — evaluado; probablemente se resuelve como opción de M1.

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

## N4 · `get-message-media` — Baja · ⬜

**Propuesta.** Descargar el adjunto de un mensaje (`[image]`, audio, documento) por id → base64 o resumen.

**Base existente.** Evolution `POST /chat/getBase64FromMediaMessage/{instance}`.

**Cuidados.** Tamaño de respuesta MCP; privacidad (datos sensibles); posible límite de tamaño configurable como en IMAP (`NUXT_IMAP_ATTACHMENT_MAX_BYTES`). Considerar hacerlo opt-in por scope de tools.

**Log.**
- 2026-10-22 — evaluado.

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
