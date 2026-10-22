# Lote B — Búsqueda completa en WhatsApp (diseño)

Rama `feat/b-search`. Ítem M2 de `docs/mcp-roadmap.md`. Nivel: Architectural. Solo lectura; sin migraciones.

## Intención

Hoy `search-messages` responde "no hay nada" con seguridad cuando sí hay, en tres casos silenciosos (acentos, número mal formado, argumentos ignorados), y no deja seguir más allá de 100 resultados ni preguntar por una persona dentro de un grupo. El lote B convierte "buscar en WhatsApp" en algo que se puede preguntar como se habla: "qué se dijo del fogón con +56…", "lo que dijo Juan en el grupo X esta semana", "todo lo de la mudanza", "¿cuánto costaba? (con lo que lo rodea)".

Caso real que lo destapó (2026-10-22, CL): "costo del fogón" en un chat 1:1 se encontró solo porque se pasaron ambas grafías y el `jid` completo.

## Línea base medida (producción, 2026-10-22; detalle en el roadmap, M2)

| Hoy | Evidencia |
|---|---|
| No pliega acentos | chat CL "fogón" 1 / "fogon" 0; cuenta "fogón" 7 / "fogon" 1 sin mensajes en común (`evolution-db.ts:314`, `ILIKE ALL`) |
| Todas las palabras (AND) | "fogón costo" 0 |
| `jid` por igualdad exacta | `…@s.whatsapp.net` 1; `+569…`, `569…`, `…@c.us` → 0 sin error |
| Tope 100, sin páginas | claves de respuesta: `query, matches, count, truncated, reactionsExcluded` |
| Argumentos desconocidos ignorados | `page:2`, `sender:"x"` → resultado normal |
| No busca en nombre de archivo | COALESCE de `messageBodyJoin` (`evolution-db.ts:520-558`) sin `fileName`/`title` |
| Sin filtro por autor ni contexto | `read-messages`: solo `since/until/page` |
| Chats 1:1 por tipo de id | en el baseline de `list-chats` (200 filas): GT 89 `@s.whatsapp.net` / 77 `@lid` / 34 grupos; CL 70 / 113 / 17. Un número se resuelve a `@s.whatsapp.net`; el chat con esa persona puede estar guardado como `@lid` |
| Autor en grupos | nombre presente en 94–100 % de los mensajes recibidos en 3 grupos CL; 71 % en 1 grupo GT (causa sin medir). Ningún autor sale como id. |

## Objetivos

1. **Acentos y mayúsculas** no cambian el resultado, en `search-messages` y en la búsqueda del panel (`terms` de `listMessagesPage`, que comparte la expresión).
2. **Palabras**: todas por defecto; opción "cualquiera".
3. **Chat por número** en cualquier forma, resuelto por Evolution.
4. **Paginación honesta** en `search-messages`: `page`, `hasMore`, `nextPage`, `totalMatching`.
5. **Argumentos desconocidos son un error**, no silencio.
6. **Búsqueda por nombre de archivo** de documentos.
7. **Autor por nombre** dentro de un chat de grupo, en `search-messages` y en `read-messages`.
8. **Contexto alrededor** de un mensaje en `read-messages`.
9. `WHATSAPP_INSTRUCTIONS`, descripciones de tools y docs actualizados.

## No objetivos

- Búsqueda difusa/typos/sinónimos/semántica; OCR o contenido de imágenes.
- Descargar adjuntos (lote E). Latencia en frío (lote F).
- Cambiar sincronización, dedupe de Evolution o el esquema de Evolution; nuevos índices en `public."Message"`; instalar extensiones en la BD de Evolution (la conexión es de solo lectura).
- Búsqueda de autor sobre toda la cuenta (sin chat).

## Anti-objetivos (fallo aunque "funcione")

- Devolver "0 resultados" cuando en realidad algo no se pudo resolver (número, grupo, participantes). Siempre se dice.
- Que `total`, `hasMore`, candidatos de autor o `note` revelen algo de chats fuera del scope del token.
- Mezclar a dos personas distintas bajo un mismo nombre sin avisar.

## Restricciones (del repo; no negociables)

- Scope = predicado en el SQL, aplicado **antes** de contar/paginar. Falla cerrado.
- Nunca normalizar JIDs localmente; el número se resuelve con `resolveNumberToJid` (`mcp-scope.ts`).
- Dedupe: `DISTINCT ON (m.key->>'id')` dentro del CTE; `LIMIT/OFFSET` fuera. Orden `messageTimestamp DESC, key->>'id' DESC`. `bestNamed()` determinista.
- Solo rutas jsonb explícitas (nada de `$.**`).
- Consultas parametrizadas; ni SQL armado con texto del llamador; sin escritura.
- "Page must say it is a page": `hasMore` de `limit+1`, nunca derivado de `total`.
- Los tools no aceptan argumento de conexión.
- Nombre del autor: nunca un id presentado como nombre (`meaningfulName`).
- `pnpm typecheck` + curl contra producción (sin framework de tests ni WhatsApp local).

## Decisiones

(U) = del usuario; (M) = mía, revisable.

### D1 · Acentos (M)
Plegar ambos lados: la aguja con `foldForSearch` (lote A, `search-text.ts`); el cuerpo en SQL con `translate(lower(body), <letras con acento en minúscula>, <sin acento>)` —no `unaccent`, que exige `CREATE EXTENSION`—. Debe aplicarse `lower()` **antes** de `translate` (si no, `FOGÓN` se queda con `Ó`, que no coincide con `o`), y los diacríticos combinantes U+0300–U+036F van en `FROM` sin carácter equivalente en `TO`, para que el texto descompuesto (NFD) se pliegue igual que `foldForSearch`. El conjunto de `translate` vive en **un** solo lugar junto a `messageBodyJoin` y debe mapear cada carácter igual que `foldForSearch` (ñ→n, ü→u, ç→c, etc.); se verifica con un script `node` que compara ambos para todo el conjunto, incluyendo entrada en mayúsculas y en NFD. Sigue siendo `ILIKE` (mayúsculas). Aplica a `searchMessages` y al `terms` de `listMessagesPage` (panel): el panel pasa a ser insensible a acentos, como en el lote A.

### D2 · Palabras (M)
`match: 'all' | 'any'`, por defecto `all` (comportamiento actual). `any` = `ILIKE ANY`. Se separa solo por espacios (sin frases entre comillas). Un término de menos de 2 caracteres es un error 400 que lo nombra, no se descarta en silencio.

### D3 · Chat por número (M)
`jid` acepta un jid (contiene `@`) tal cual —sin llamar a Evolution— o un número (dígitos con `+`, espacios o guiones) que se resuelve con `resolveNumberToJid`. Mismo helper en `read-messages`. Número sin cuenta de WhatsApp, o Evolution inaccesible → error explícito (fallo cerrado; nunca una lista vacía).

**Doble forma `@s.whatsapp.net` / `@lid`.** Casi la mitad de los chats 1:1 están guardados como `@lid`. Resolver un número no puede quedarse en la forma teléfono: la búsqueda debe cubrir **todas las formas de ese chat** que el sistema conozca (el jid resuelto y los `remoteJid` que el propio historial relaciona con él, p. ej. mensajes cuyo `key->>'remoteJidAlt'` es ese jid) y decir en la respuesta cuáles cubrió (`chatsSearched`). Si no se puede descartar que exista otra forma, la respuesta lo dice en `note`; jamás un cero mudo. Cada forma pasa por el scope por separado: las que el token no alcanza se omiten sin revelarlas.

**Uniformidad con scope.** Para un token con `chatJids`, "número sin WhatsApp" y "chat fuera de scope" dan el mismo error (sin confirmar existencia). Para token de todos los chats se distinguen.

### D4 · Paginación en búsqueda (M)
`page` ≥ 1 (def. 1), `limit` 1–100 (def. 20). `OFFSET` fuera del CTE. Respuesta: `page`, `hasMore` (de `limit+1`), `nextPage` solo si `hasMore`, `totalMatching` (`COUNT(*) OVER ()` sobre el conjunto deduplicado, igual que `listMessagesPage`; ausente en página fuera de rango = "no medido"), `truncated` se conserva igual a `hasMore` por compatibilidad (la respuesta sigue siendo superconjunto de la actual). **Ventana fija:** en la página 1 se fija `until` (ahora) y se devuelve como `window`; las páginas siguientes lo reciben de vuelta —como `read-messages`—, porque la búsqueda lee SQL en vivo y un mensaje nuevo desplazaría todos los `OFFSET`. `note` en palabras cuando `hasMore`, mismo estilo que `read-messages`.

### D5 · Argumentos desconocidos (M, alcance por confirmar con el usuario)
Rechazar con error 400 los argumentos no declarados **solo en los tools de WhatsApp de este lote** (`search-messages`, `read-messages`). Extenderlo a los 22 tools (Telegram, IMAP, `sql/`) sería un cambio global en `defineKindTool` que el usuario no ha pedido: queda como pregunta suya (abajo). El mecanismo depende del toolkit 0.19.0; el constructor lo verifica. Se prueba en producción con `tools/list` y una llamada con argumento extra.

### D6 · Nombre de archivo (M)
Segunda expresión lateral `filename` = `COALESCE(documentMessage.fileName, documentMessage.title, documentWithCaptionMessage.message.documentMessage.fileName/title)` más las variantes ya anidadas (`associatedChildMessage`, `editedMessage`). El texto buscable es `concat_ws(' ', body, filename)`; el `text` del hit es `body ?? filename`. No se mueve el nombre al `COALESCE` del body (un pie de foto taparía el nombre). Es una sola expresión compartida: la búsqueda del panel también encuentra por nombre de archivo.

### D7 · Autor (U + M)
**(U)** "Lo que dijo Juan en el grupo X" busca los mensajes de esa persona en ese grupo. Los miembros de un grupo normalmente **no son contactos** del usuario, así que la resolución **no depende de `contactDirectory()`**: sale de lo que el propio grupo muestra.

- Argumento `author` (string) en `search-messages` y en `read-messages`. **(M)** Requiere `jid` de un chat de grupo (`@g.us`); sin `jid` o en chat 1:1 → error que lo explica (en 1:1 existe `fromMe`). En `search-messages` el `query` pasa a ser opcional **solo** si hay `author`. En `read-messages`, `author` es **excluyente con `around`** (el contexto es la conversación, no solo una persona) y compatible con `page`, `since`, `until`.
- Resolución **(M)** (helper compartido, junto a `addGroupMembers` en `mentions.ts`), en este orden:
  1. **Participantes** del grupo (`/group/participants`, mismo caché/timeout de 8 s) cuyo nombre (plegado, subcadena) contiene el valor. Cada participante aporta **todas** sus identidades (`id`, `lid`, `phoneNumber`, `jid`). Si el valor parece número o jid, se aceptan esas formas más las identidades del participante que coincida. Predicado SQL: `key->>'participant'` o `key->>'participantAlt'` ∈ identidades, con `fromMe = false`.
  2. **`pushName`** (nombre que la persona publica) **solo como respaldo**: cuando la consulta de participantes falla o no da ninguna coincidencia (cubre además a quien ya salió del grupo). No se combina con (1) cuando (1) encontró a alguien, para no arrastrar a otra persona de nombre parecido.
- **Ambigüedad** **(M)**: si el valor coincide con más de una persona distinta —por participantes, o por identidades distintas (`key.participant`) entre los mensajes que coinciden por `pushName` en ese chat— no se busca: se responde con los candidatos (nombres tal como los muestra el grupo, solo de ese chat) y se pide afinar. "Rosa" vs "Rosario" es el caso esperado.
- **Fallo honesto** **(M)**: si no se pudo consultar participantes, la respuesta lo dice en `note`. Cero coincidencias por ambos caminos → "no encontré a ningún miembro de ese grupo que coincida", nunca lista vacía muda.
- Eco en la respuesta: `authorResolved: { names: [...], matchedBy: 'participants' | 'pushName' }`.

### D8 · Contexto alrededor (M)
`read-messages` nuevo `around` (id de mensaje del mismo `jid`), `before`/`after` (0–50, def. 10 cada uno). Excluyente con `page`, `since`, `until`. Respuesta en orden cronológico ascendente con el mensaje objetivo marcado (`target: true`); `hasMoreBefore`/`hasMoreAfter`. Id no encontrado en ese chat → error explícito. Misma deduplicación, reacciones excluidas por defecto, orden `(timestamp, id)`. Mismo scope.

### D9 · Instrucciones y docs (M)
Párrafo nuevo en `WHATSAPP_INSTRUCTIONS` (inglés): buscar con acentos indiferentes; usar `match: 'any'` para alternativas; el número sirve como `jid`; para "lo que dijo X en el grupo" usar `author` con el `jid` del grupo; para ver qué rodea un hit usar `read-messages` con `around`; si una respuesta trae `note`/`hasMore`, seguirla antes de concluir. Actualizar `CLAUDE.md` (sección de lecturas/paginación, solo lo que cambia), `CODEMAP.md`, `docs/using-automata.md`, roadmap.

## Preguntas abiertas (las cierra el constructor midiendo o la verificación en producción)

- Forma real de `key.participant`/`participantAlt` (LID vs número) en grupos. Medición pendiente (necesita BD). El predicado usa ambas y todas las identidades; la verificación en producción lo confirma.
- Por qué 29 % de mensajes en un grupo GT no trae autor (¿Business vs normal? ¿consulta de participantes?). El usuario lo evaluará con pruebas reales tras el despliegue (decisión del usuario, 2026-10-22); si falla, se replantea el enfoque.
- ¿`/group/participants` devuelve nombres para miembros que no son contactos, o los nombres que vemos salen casi todos de `pushName`? (el sondeo por MCP no lo distingue). Si es lo segundo, el respaldo (2) hace casi todo el trabajo y la detección de ambigüedad por `pushName` es la que importa.
- Cómo relacionar de forma fiable un chat `@lid` con su número (¿`remoteJidAlt` en todos los mensajes o solo en los vivos? ¿tabla `Contact`?). Define qué formas cubre D3.
- Si el toolkit admite rechazar argumentos extra sin tocar `defineKindTool` (D5).
- Tamaño del conjunto de `translate` (D1): mínimo latín-1 + latín extendido A.

## Verificación

Sin pruebas MCP locales (sin WhatsApp local). Local: `pnpm typecheck` y scripts `node` sobre módulos puros. Revisión de scope por un agente Sonnet (totales, candidatos de autor y notas no filtran fuera de scope; `author` con `chatJids` vacío). Tras merge a `main` (con OK explícito del usuario y sin importación activa), contra producción con `GT_TOKEN`/`CH_TOKEN`:

- CL chat del caso: "fogon" y "fogón" dan el mismo conjunto; `+56…`, `56…` y jid completo dan el mismo resultado; número inexistente → error explícito.
- `match:'any'` ⊇ `match:'all'` para las mismas palabras.
- Un término común (p. ej. "hola"): recorrer páginas hasta `hasMore:false` reenviando la `window` de la página 1; suma de `count` = `totalMatching`; sin ids repetidos. (Ventana fija: sin límite de tiempo entre páginas.)
- Un chat 1:1 de CL guardado como `@lid`: buscar por su número da los mismos mensajes que por su `jid` `@lid`, o la respuesta dice explícitamente que no pudo cubrirlo.
- Latencia en caliente de `search-messages` (con acentos plegados, total y nombre de archivo) no peor que ~2× la línea base (0,8–2 s); medida en producción. Nota: D1 también toca la búsqueda del panel, que el lote F ya señala como lenta.
- Token con scope: un número sin WhatsApp y un chat fuera de scope devuelven el mismo error.
- "xlsx"/"pdf" encuentran documentos por nombre; el hit trae `text` no vacío.
- `author` en un grupo CL con un miembro que no es contacto (el usuario aporta casos reales, p. ej. nombres compartidos); dos coincidencias → candidatos.
- `around` sobre un hit devuelve vecinos del mismo chat en orden, con el objetivo marcado; id inexistente → error.
- Argumento extra → error 400 en los tools cubiertos.
- Respuestas de siempre (sin argumentos nuevos) siguen siendo un superconjunto de las anteriores.
- Prueba end-to-end en Claude.ai a cargo del usuario.

## Decisiones del usuario

- Spec aprobada (2026-10-22).
- Rechazo de argumentos desconocidos (D5): **solo** `search-messages` y `read-messages` en este lote. La versión global (los 22 tools) queda documentada como ítem **M4** del roadmap, para hacerla después.
- Prueba real del autor en Guatemala (WhatsApp normal vs. Business en Chile): la hará el usuario tras el despliegue; si no funciona, se replantea.

## Qué se deja al constructor

Nombres internos de helpers y archivos nuevos; el conjunto exacto de `translate` (con su comprobación contra `foldForSearch`); si `author` y `around` comparten helper en `evolution-db.ts`/`mentions.ts` o van separados; el texto exacto de `note`/errores (en inglés, estilo de `list-chats`); orden de las tareas del plan (la paginación y los acentos comparten el SQL de `searchMessages`: secuenciales).
