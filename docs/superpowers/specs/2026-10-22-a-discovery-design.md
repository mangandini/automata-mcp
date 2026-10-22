# Lote A · Descubrimiento (M1 + N3 + N1) — diseño

Rama `feat/a-discovery`. Solo lectura. Ítems de `docs/mcp-roadmap.md`: M1 (`list-chats` con búsqueda/filtro/paginación), N3 (sin leer, como opción de M1), N1 (`list-contacts`).

## Intención (por qué)

El uso real que describió el usuario es casi siempre **"en el grupo X, sobre los últimos N días"**: resumir la semana, sacar to-dos (propios o de otra persona), lo relevante de los últimos días, reuniones para pasar a su calendario (eso último lo hace Claude con su propio conector de Google Calendar; fuera de alcance).

Leer un rango ya funciona (`read-messages` con `since`). El hueco es el paso previo: **encontrar el grupo X**. Hoy `list-chats` no toma argumentos y devuelve los 200 chats más activos; un grupo del colegio callado unos días queda fuera, y el modelo solo puede adivinar vía `search-messages`.

El usuario nombra los grupos **por un fragmento de su nombre real**, no por el hijo: "el grupo CHK" para `PREESCOLAR CHK 2025🏫⭐`. La correspondencia hijo → grupos la guardará él en las instrucciones/memoria de un Proyecto de Claude.ai (decisión del usuario: opción simple, nada en automata).

Contexto de uso: dos conexiones (GT ~69k mensajes, CL ~36k), un token y un conector por número, ambos tokens `all_chats`, uso personal.

## Objetivos

1. `list-chats` encuentra un chat por fragmento de nombre, número o jid, filtra por grupos/directos y por sin leer, y pagina sobre **toda** la lista (hasta el tope de `chatListing()`), no solo los 200 primeros.
2. `list-contacts` nuevo: agenda de la cuenta, con búsqueda y paginación, respetando el scope del token.
3. `WHATSAPP_INSTRUCTIONS` le dice al modelo el camino: "grupo X" → `list-chats { query, type: 'group' }` → si hay varias coincidencias, preguntar → `read-messages { jid, since }` paginando.

## No-objetivos

- Alias/etiquetas de chats en automata (el usuario eligió Claude.ai).
- Rendimiento del panel (Messages 9 s en frío): **lote F / P1**, aparte. Este lote no cambia `listMessagesPage` ni `accountNames`.
- Marcar como leído, escribir, enviar (lote D).
- Búsqueda difusa/tolerante a errores de tipeo.

## Anti-objetivos (fallaría aunque "funcione")

- Que un token limitado a ciertos chats aprenda, por `total`, `hasMore` o `list-contacts`, que existen chats o contactos fuera de su scope.
- Que una lista parcial (tope, Evolution caído, página intermedia) se lea como completa → el modelo concluye "ese grupo no existe".
- Que `list-chats` sin argumentos cambie de comportamiento para un cliente que ya lo usa.

## Restricciones (del repo)

- `defineKindTool`, kind `whatsapp`, `readOnlyHint: true`; basename único (`list-contacts.ts` no colisiona: Telegram usa `list-telegram-chats`).
- Sin argumento de conexión. Scope fail-closed. No normalizar JIDs (aquí no se construye ninguno; solo se compara texto para buscar).
- Sin framework de tests: `pnpm typecheck` + curl JSON-RPC.

## Diseño

### `list-chats` (archivo existente `server/mcp/tools/whatsapp/list-chats.ts`)

Entrada, todo opcional:

| Arg | Tipo | Defecto | Nota |
|---|---|---|---|
| `query` | string (1–100) | — | Subcadena en nombre, número o jid. Insensible a mayúsculas **y acentos** (NFD sin diacríticos); emojis no estorban porque es subcadena. |
| `type` | `'all' \| 'group' \| 'direct'` | `all` | Por `isGroup`. |
| `unreadOnly` | boolean | false | `unreadCount > 0`. |
| `sort` | `'last' \| 'name'` | `last` | `last` desc, `name` asc (comparadores existentes). |
| `page` | int ≥ 1 | 1 | |
| `limit` | int 1–200 | 200 | 200 = tamaño actual, para que la llamada sin argumentos devuelva lo mismo que hoy. |

**Scope antes de buscar y paginar.** Hoy el tool pide una página y luego filtra por scope, así que `hasMore` habla de la lista de debajo. Ahora el filtro de scope se aplica sobre el listado completo **antes** de `query`/`type`/`unreadOnly`/orden/corte, de modo que `total`, `hasMore` y `page` describen solo lo visible. Implementación: `listChatsPage()` gana un parámetro opcional de predicado (o `allowedJids?: Set<string>`) que el tool rellena desde `scope`; el dashboard no lo pasa y no cambia.

**Búsqueda sin acentos.** El normalizador (`lower + NFD + quitar \p{M}`) se aplica en `listChatsPage()` y `listContacts()`; el dashboard hereda la mejora (cambio de comportamiento menor y deseado — "jose" encuentra "José").

**Filtros nuevos en `listChatsPage()`**: `type` y `unreadOnly` como campos opcionales de `ChatTableQuery`. El dashboard no los usa.

Salida:

```
{ chats: ChatSummary[], count, page, total, hasMore, nextPage?, truncated?, incomplete?, note? }
```

- `total` = coincidencias visibles en toda la lista; `count` = filas en esta página.
- `nextPage` solo si `hasMore`.
- `truncated` (tope de 10 000 alcanzado) e `incomplete` (Evolution no respondió todo) solo cuando son true, **siempre** acompañados de `note` en palabras: "la lista puede no tener el chat; prueba search-messages".
- `note` también cuando `query` dio 0 resultados (sugerir fragmento más corto o `search-messages`). Qué hacer con varias coincidencias (preguntar al usuario) va en las instrucciones, no en la respuesta.
- `ChatSummary` sin cambios (incluye `unreadCount`, `lastMessageAt`, `lastMessagePreview`, `participantCount` cuando lo hay).

**Grupos sin nombre (hallazgo de la revisión, verificado en código).** En `buildChatListing()` un grupo cuya fila `Chat` no trae nombre se nombra con `fetchGroups()` (`/group/fetchAllGroups`, en vivo). Si esa llamada falla (`rate-overlimit`, 428, desconectado), `staleWhileFailing` devuelve el mapa viejo o vacío **sin avisar**, el grupo queda nombrado con su id numérico, `failed` no se marca y la lista se cachea 60 s. Resultado: `query:"chk"` → 0 coincidencias, leído como "no existe". Corrección:
- `ChatListing` gana `unnamedGroups: number` = grupos cuyo nombre cayó al id (`localPart`).
- `list-chats` lo expone cuando > 0 y, si además hay `query`, añade `note`: "N grupos no tienen nombre ahora mismo (WhatsApp no respondió); una búsqueda por nombre puede no encontrarlos — reintenta en un minuto o usa `search-messages`".
- No se cambia la política de caché (el dashboard seguiría pagando la llamada en vivo en cada carga); el aviso basta.

**Orden sin argumentos (mi decisión).** Hoy `listChats` corta `chatListing()` en el orden nativo de Evolution (`updatedAt DESC`, que mueven los acuses de lectura). Con este diseño el orden por defecto pasa a ser `sort:'last'` = `lastMessageAt ?? updatedAt` desc, que el propio tipo documenta como el campo correcto. Las 200 primeras pueden no ser exactamente las mismas que antes; la forma y el tamaño sí.

**Comentario de cabecera:** reescribir. El argumento actual "sin paginación porque nombrar filas cuesta la tabla de contactos por llamada" ya no aplica: `chatListing()` cachea la lista nombrada 60 s, paginar es cortar en memoria.

**Descripción del tool**: incluir cómo encontrar un grupo por fragmento y que `hasMore`/`truncated` significan que no está todo.

**`unreadCount`** viene del teléfono vía Evolution; la descripción dice "según el último estado que vio la conexión". Verificar en el criterio de aceptación si baja al leer en el teléfono; si no baja, documentarlo en la descripción en vez de prometerlo.

### `list-contacts` (nuevo `server/mcp/tools/whatsapp/list-contacts.ts`)

Entrada: `query?` (1–100), `page?` (≥1, def. 1), `limit?` (1–200, def. 100).

Salida: `{ contacts: [{ jid, name, number? }], count, page, total, hasMore, nextPage? }`.

- Reutiliza `listContacts()` (sobre `contactDirectory()`, caché 5 min); orden por nombre asc.
- **Sin grupos**: se excluyen las filas `@g.us` (los grupos se buscan con `list-chats`). Filtro antes de paginar.
- `number` solo para `@s.whatsapp.net`; `@lid` sin número, sin inventarlo (ya lo hace `listContacts`). No se devuelve `profilePicUrl`.
- **Scope (decisión del usuario: opción a).** `allChats` → toda la agenda. Si no → solo contactos cuyo `jid` está en `scope.chatJids`, aplicado **antes** de buscar y paginar. Consecuencia aceptada: un contacto cuyo chat permitido está guardado con otra forma de identidad (LID vs número) no aparece — falla cerrado.
- `listContacts()` gana el mismo parámetro opcional de filtro (o se filtra en el tool antes de paginar con una variante); el dashboard no cambia.

### `WHATSAPP_INSTRUCTIONS` (`server/utils/mcp-instructions.ts`)

Añadir un párrafo (sin tocar el resto):

> Para trabajar sobre una conversación por su nombre ("el grupo CHK"), búscala con `list-chats` pasando un fragmento del nombre como `query` (y `type: 'group'` para grupos); no recorras la lista entera. Si coincide más de una, pregunta al usuario cuál antes de leer. Si no coincide ninguna, prueba un fragmento más corto o `search-messages` por algo que se dijo ahí, y no concluyas que no existe mientras la respuesta traiga `truncated` o `incomplete`. Luego lee con `read-messages` usando `since`. `list-contacts` da nombre y número de personas de la agenda.

(Redacción final en inglés, como el resto.)

### Documentación

- `CLAUDE.md` › Status: 21 → 22 tools, añadir `list-contacts` a la lista `whatsapp`.
- `docs/mcp-roadmap.md`: M1, N3, N1 → ✅ con log; `CODEMAP.md` si menciona la lista de tools.
- `docs/using-automata.md` si enumera tools.

## Mis decisiones (para que el usuario las revise)

- `limit` por defecto 200 (no 100 como el roadmap) para que la llamada sin argumentos no cambie de tamaño.
- Búsqueda sin acentos también en el dashboard.
- `list-contacts` excluye grupos.
- Contacto con LID vs número distinto al del scope → no aparece (falla cerrado).
- Orden por defecto por última actividad real.
- Grupos sin nombre: aviso, no cambio de caché.

## Lo que queda al implementador

- Forma exacta del parámetro de scope en `listChatsPage`/`listContacts` (predicado vs set), siempre que se aplique antes de contar y cortar.
- Esquemas zod (el toolkit los usa); límites de longitud de `query`.
- Redacción en inglés de descripciones y notas.
- `query` con número formateado ("+56 9 3536…"): opcionalmente comparar también solo dígitos contra `number`.

## Verificación / criterios de aceptación

Local tiene la base y Evolution pero **ninguna cuenta vinculada** (ver OPS.md), así que los curl locales solo prueban la forma, el gating y los errores. La prueba con datos reales es en producción tras el deploy, con los tokens de `.env` (tools de solo lectura). — *pendiente de confirmar con el usuario, ver abajo.*

1. `pnpm typecheck` limpio.
2. `tools/list` muestra `list-contacts` en un token WhatsApp y no en uno Postgres.
3. Sin argumentos, `list-chats` devuelve ≤200 filas con la misma forma que antes, ordenadas por última actividad (baseline de `main` guardado antes del deploy para comparar).
4. CL (token `CH_TOKEN`): `list-chats {query:"chk", type:"group"}` → exactamente el grupo `PREESCOLAR CHK 2025🏫⭐`. `query:"preescolar"` igual con acentos/mayúsculas variados.
5. `page`/`nextPage` recorren hasta `hasMore:false`; la suma de `count` = `total`.
6. `unreadOnly:true` devuelve solo `unreadCount>0`; anotar si el conteo baja tras leer en el teléfono.
7. `list-contacts {query:"<nombre conocido>"}` → contacto con número; ninguna fila `@g.us`.
8. Token con scope de 1–2 chats (creado para la prueba y revocado después): `list-chats` y `list-contacts` devuelven solo esos; `total` no supera el scope.
9. Pedirle a Claude.ai "resume lo de esta semana en el grupo CHK": encuentra el grupo en una llamada a `list-chats` con `query`.

## Baseline (producción, `main` @ 9c107ea, 2026-10-22)

`list-chats` sin argumentos: GT 200 filas, `hasMore:true`, 34 grupos, 1,6 s; CL 200 filas, `hasMore:true`, 17 grupos, **8,1 s** (lista fría). `PREESCOLAR CHK 2025🏫⭐` está en CL. Ningún grupo nombrado por id en ese momento. Respuesta ~88 KB por llamada (incluye `profilePicUrl` largas). Guardado en el scratchpad de la sesión.
