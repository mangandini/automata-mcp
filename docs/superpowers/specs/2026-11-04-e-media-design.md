# Lote E — Adjuntos de WhatsApp por MCP (diseño)

Rama `feat/e-media`. Ítem N4 (`get-message-media`) de `docs/mcp-roadmap.md`. Nivel: Architectural. Añade una migración (tabla de enlaces) y una ruta pública.

## Intención

Buscar "nómina" encuentra el mensaje, pero el dato está **dentro** del adjunto (un PDF, una captura de una transferencia). Hoy el modelo solo ve `[document] nomina-octubre.pdf` y un id: no hay forma de saber qué dice ni de quedarse con el archivo. El lote E cierra eso de dos maneras a la vez, por decisión del usuario:

1. **Claude lee el contenido** y responde a partir de él (ve la imagen, lee el PDF).
2. **El usuario recibe el archivo** como un enlace temporal de descarga a nuestra app, que funciona en el computador y en el teléfono.

Casos reales: CL 2026-10-22 (monto en un `.xlsx` adjunto y en capturas `[image]` de transferencias, ver N4 del roadmap); 2026-11-04, búsqueda de "nómina" cuyo resultado es un PDF o una imagen.

## Decisiones del usuario (2026-11-04)

| Tema | Decisión |
|---|---|
| Qué hace | Ambas cosas: Claude lee el contenido **y** entrega el archivo. |
| Cómo llega el archivo | **Enlace temporal** a nuestra app con el nombre original. No basta con adjuntarlo en el chat (en Claude.ai normalmente no se puede descargar desde ahí). |
| Quién abre el enlace | **Cualquiera que lo tenga**, sin iniciar sesión. La protección es la vida corta del enlace. |
| Cuántas veces | **Varias veces dentro de 1 hora**, no un solo uso (las vistas previas de enlaces en teléfonos y apps lo consumirían). |
| Dónde vive el archivo | **En ningún sitio nuestro.** Al abrir el enlace se vuelve a descargar de WhatsApp vía Evolution. El enlace puede fallar si WhatsApp ya borró el archivo o la conexión cayó; debe decirlo. |
| Tipos | **PDFs/documentos e imágenes.** Fuera: notas de voz, audio, video, stickers. |
| Activación | **Opt-in por token.** Un token con "todas las herramientas" **no** recibe este tool automáticamente; hay que marcarlo. |

## Objetivos

1. Tool MCP de lectura `get-message-media { messageId }` para conexiones `whatsapp`.
2. Imagen → **reducida y comprimida en el servidor** hasta caber en el presupuesto de respuesta, y enviada como bloque `image`. PDF → **texto extraído en el servidor** y enviado como bloque de texto (recortado al presupuesto, diciendo si se recortó); un PDF escaneado sin texto → solo enlace, y `note` lo dice. Otros documentos (xlsx, docx, …) → solo metadatos y enlace. (Decisiones del usuario 2026-11-04, tras la investigación de abajo.)
3. En todos los casos soportados, un **enlace de descarga** de 1 hora, reutilizable, con el nombre de archivo original.
4. Errores honestos y distinguibles: no existe/fuera de scope (uno solo), tipo no soportado, demasiado grande, medio expirado en WhatsApp, cuenta desconectada.
5. Scope del token comprobado sobre el chat **del propio mensaje**, nunca sobre un argumento.
6. Opt-in en el selector de herramientas del token y en el modelo de scope.
7. `WHATSAPP_INSTRUCTIONS`, descripción del tool, `CLAUDE.md`, `CODEMAP.md`, `docs/whatsapp.md`, `docs/searching-whatsapp.md` (o guía equivalente) actualizados.

## No objetivos

- Audio, notas de voz (transcripción), video, stickers, view-once (ver "Cuidados").
- Guardar bytes en nuestra base de datos o en almacenamiento de objetos (decisión del usuario; además `CLAUDE.md` › IMAP mantiene la misma regla para correo).
- OCR (PDF escaneado, texto dentro de imágenes lo lee Claude si ve la imagen) y conversión de otros formatos (xlsx/docx → texto).
- Telegram e IMAP (IMAP ya tiene `get-email-attachment`; su enlace de descarga, si se quiere, es otro ítem).
- Descargas por lote ("todos los adjuntos del chat").

## Comportamiento

### Tool `get-message-media`

- Entrada estricta (`strictInput`): `messageId` (el `id` que devuelven `search-messages` / `read-messages`). Sin `jid`: el chat sale de la fila.
- Pasos, en este orden:
  1. Buscar la fila por `instanceId` + `key->>'id'`, deduplicada como el resto de lecturas (`DISTINCT ON`), con el **predicado de scope en SQL** cuando el token no tiene `allChats`: `remoteJid = ANY(chats permitidos)`, **solo `remoteJid`**, el mismo predicado que `search-messages`. Así es descargable exactamente lo que el token puede leer o buscar; nunca vía `remoteJidAlt` (eso abriría el chat `@lid` de un token con scope en la forma teléfono, que no puede leerlo). Ninguna fila → 404 con **un solo mensaje** para "no existe" y "no está en tu scope" (no se pueden sondear ids).
  2. Desenvolver el contenido como `classifyContent` (`associatedChildMessage`, `editedMessage`, `documentWithCaptionMessage`) y decidir el tipo por **payload**, no por `messageType`. `imageMessage` o `documentMessage` → continúa; cualquier otro (audio, video, sticker, view-once, ephemeral sin desenvolver, texto) → error "tipo no soportado" que nombra el tipo.
  3. Rechazar por tamaño declarado (`fileLength`) antes de descargar si supera el **tope de enlace**.
  4. Descargar vía Evolution (`POST /chat/getBase64FromMediaMessage/{instance}`, cliente por instancia de `useEvolutionClient()`, sin clave global). Si el DTO acepta el mensaje completo, enviar **la fila ya comprobada** (lo descargado = lo comprobado). Re-verificar el tope sobre los bytes reales.
  5. Crear el enlace (ver abajo) y devolver `content: [...]`: primero un bloque de texto JSON con metadatos (`messageId`, `jid`, `type`, `fileName`, `mimeType`, `size`, `download: { url, expiresAt }`, `note`), luego el bloque `image` (reducida) o el texto del PDF, **dentro del presupuesto de respuesta**; si no se puede (imagen que no baja lo suficiente, PDF sin texto, archivo sobre el tope de lectura), solo metadatos + enlace y `note` lo dice (el usuario igual recibe el archivo). No se usa bloque `resource` con blob: en Claude.ai no se lee de forma fiable (ver investigación).
- Errores de Evolution: medio expirado / no recuperable → error explícito que lo dice ("WhatsApp ya no tiene este archivo; pide que lo reenvíen"); cuenta no conectada → 503 que lo dice. Nunca un resultado vacío. (Los códigos exactos de Evolution 2.3.7 para "expirado" **están por verificar**; ver "Lo que queda al constructor".)
- `readOnlyHint: true`, `openWorldHint: true` (habla con WhatsApp).
- Sin `NUXT_PUBLIC_APP_URL` → el tool devuelve el contenido sin enlace y lo dice en `note`. Nunca se construye el enlace con el `Host` de la petición.

### Enlace de descarga

- Forma: `{NUXT_PUBLIC_APP_URL}/api/media/<token>` (o prefijo equivalente fuera de `/mcp`). El token va en el **path**, nunca en query string. Mismo patrón que invitaciones y verificación: prefijo + 32 bytes aleatorios, se guarda **solo el SHA-256**, comparación por hash.
- Tabla nueva en el esquema `app` (migración nueva, append-only): hash, conexión, token MCP que lo creó, `messageId`, chat, nombre de archivo, mime, `expires_at` (creación + 1 h), creado, contador de descargas. **Sin bytes.** Claves foráneas a `instances` y `mcp_tokens` con `ON DELETE CASCADE`: con `RESTRICT` o por defecto, `deleteInstance()` y el borrado de tokens fallarían en cuanto exista un enlace.
- `GET` del enlace:
  1. Hash → fila; inexistente o vencida → 404 (página/JSON simple que dice "enlace vencido o inválido", sin distinguir).
  2. Re-comprobar que el **token MCP que lo creó** sigue activo, sigue alcanzando la conexión, sigue teniendo el tool habilitado y el chat sigue en su scope. **Esta ruta es un tercer camino de credenciales** y debe respetar la separación de `CLAUDE.md` › "The auth split": carga el token por id desde la fila del enlace y aplica `authorizesInstance()`, el gate de tool y el chequeo de scope como **predicados puros** sobre hechos cargados; las credenciales de Evolution salen de la fila de la conexión por el camino por instancia (`credentialsForInstance`), no de la petición. **Nunca** se pone ni se simula `event.context.mcpAuth` (para reutilizar `useEvolutionClient()`), y nunca se usa la sesión del navegador. Si algo falla → 404 igual. Revocar el token mata sus enlaces; **rotar su secreto no** (la rotación cambia el secreto, no lo que alcanza: un enlace filtrado sigue valiendo hasta vencer, máximo 1 h).
  3. Volver a descargar vía Evolution, con el mismo tope; fallo de WhatsApp/Evolution → página/JSON que lo explica (expirado / desconectado), nunca un archivo vacío.
  4. Responder el archivo con `Content-Disposition: attachment; filename*=…` (nombre original, saneado), `Content-Type` del mime, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.
- Reutilizable dentro de la hora. **Mi decisión:** tope de 20 descargas por enlace (contador por escritura condicional), para que un enlace filtrado no sirva de proxy ilimitado.
- **Mis decisiones:** cada llamada al tool crea un enlace nuevo (no se reutiliza el de una llamada anterior); una descarga fallida (WhatsApp/Evolution) no cuenta para el tope de 20.
- Throttle en memoria por IP en la ruta (velocidad, no control; igual que `login-throttle.ts`).
- Filas vencidas se borran (al crear enlaces nuevos o en una tarea programada; a elección del constructor). Funciona con varias réplicas porque todo el estado está en la BD.
- El token del enlace **no aparece en logs**: extender `redact.ts` / `plugins/redact-mcp.ts` al nuevo prefijo (hoy solo cubren `/mcp`).

### Opt-in

- Un token con "todas las herramientas" **no** puede llamar `get-message-media`; solo un token que lo tenga marcado explícitamente.
- El selector de scope (`TokenScopeFields.vue`) lo muestra como casilla aparte, desmarcada por defecto, también cuando "todas las herramientas" está marcado, con una línea que diga qué expone ("descarga adjuntos y crea enlaces de descarga de 1 hora").
- Cómo se guarda (p. ej. permitir `tool_names` con extras opt-in cuando `all_tools` es verdadero, o una marca en la definición del tool que `isToolAllowed` respete) queda al constructor, con tres condiciones: tokens existentes no lo ganan sin edición; el gate sigue siendo síncrono (`enabled` se evalúa dos veces por petición); `scopeFields()` sigue escribiendo todos los ejes.

## Investigación (2026-11-04)

**Evolution 2.3.7** (fuente, tag `2.3.7`, commit cd800f2, Baileys 7.0.0-rc.9):
- `POST /chat/getBase64FromMediaMessage/:instance`, cuerpo `{ message: { key: { id } } }` (o el `WebMessageInfo` completo con `message`; entonces no consulta su BD). Éxito **201**: `{ mediaType, fileName, caption, size: { fileLength, … }, mimetype, base64 }`. Con solo `key.id` busca `SELECT * … WHERE instanceId AND key->>'id'` sin orden (copias idénticas: inocuo).
- Desenvuelve `ephemeralMessage`, `documentWithCaptionMessage`, `viewOnce*`; **no** `associatedChildMessage`: hay que desenvolverlo nosotros y mandar el mensaje interior (`message.message`), lo que además hace que lo descargado sea la fila ya comprobada.
- **Todo error es 400** con texto en `response.message[0]`: `Message not found`, `The message is not of the media type`, o el error de descarga (medio expirado: CDN 404/410 dentro del texto, tras pedir re-subida al teléfono y un reintento de 5 s). Hay que clasificar por texto, con un mensaje genérico honesto si no se reconoce.
- La re-subida al teléfono **no tiene timeout** en Baileys: llamada con **timeout propio** (mi decisión: 30 s, dentro de los 240 s de Claude.ai) que se informa como "WhatsApp no respondió; puede que el archivo ya no esté".
- Con el socket cerrado puede funcionar igual si el CDN aún tiene el archivo.

**Claude.ai** (docs de conectores + issues abiertos de `anthropics/claude-ai-mcp`): resultado de tool máx. ~150 000 caracteres y 240 s; bloques `image` soportados pero con reportes de que en web no llegan al modelo (#238); `resource` con blob reportado como fallido en web (#536) → no se usa para PDF. A probar en vivo: imagen pequeña y reducida, texto de PDF.

## Restricciones (de `CLAUDE.md`)

- Evolution DB: solo `SELECT` parametrizados, `instanceId` siempre, scope como predicado SQL, dedupe `DISTINCT ON`, rutas jsonb explícitas.
- Credenciales por instancia; nunca clave global ni descarga fuera del MCP con la API key de la instancia.
- `defineKindTool`, nombre de archivo único entre grupos, `title`, descripción escrita para el modelo.
- Resultado con `content: [...]` pasa intacto por `normalizeToolResult` (patrón de `get-email-attachment`).
- **Dependencias nuevas** (decisión del usuario): una librería de extracción de texto de PDF en JavaScript puro y una de procesamiento de imágenes. El constructor elige cuáles y verifica que funcionan en las tres imágenes (`apps/web/Dockerfile`, `docker/aio/Dockerfile` Alpine/musl, Railway) y en Node 22.
- **Presupuesto de respuesta**: todo el resultado del tool (JSON + imagen en base64 o texto del PDF) cabe con margen en ~150 000 caracteres (mi decisión: objetivo ≤ 120 000).
- **Dos topes, mi decisión** (leer y recibir son cosas distintas): tope de **lectura** (tamaño máximo del original que se intenta reducir o extraer; mi decisión 25 MB, igual al de enlace, salvo que la memoria lo desaconseje) y tope de **enlace** `NUXT_WHATSAPP_MEDIA_MAX_BYTES`, por defecto 25 MB, que también aplica la ruta. Ambos en `.env.example`.
- Sin framework de tests: `pnpm typecheck` + llamadas JSON-RPC reales (local y producción).

## Criterios de aceptación (producción, GT/CL)

1. Una búsqueda de "nómina" (o similar) con un PDF → `get-message-media` devuelve el PDF a Claude y un enlace; el enlace descarga el archivo idéntico (tamaño/hash) con su nombre, desde otro navegador sin sesión.
2. Una imagen → bloque `image` + enlace que funciona.
3. El `.xlsx` del caso CL 2026-05-14 → metadatos + enlace que lo descarga.
4. Enlace abierto dos veces dentro de la hora → funciona; después de 1 h → "vencido".
5. Revocar el token → sus enlaces dejan de funcionar.
6. Mensaje de un chat fuera del scope → mismo error que un id inexistente.
7. Token con "todas las herramientas" sin la casilla → el tool no aparece en `tools/list`.
8. Audio/video → "tipo no soportado"; sobre el tope de enlace → rechazado antes de descargar; entre tope de lectura y tope de enlace → sin bloque, con enlace que funciona.
9. Medio antiguo que WhatsApp ya no tiene → error explícito (registrar la antigüedad observada).
10. El token del enlace no aparece en los logs del servidor.

## Lo que queda al constructor

- Texto exacto del error de medio expirado (verificar en vivo con un mensaje antiguo).
- Elección de librerías y parámetros de reducción (dimensión, calidad) que dejen legible una captura o un comprobante.
- Nombre exacto del prefijo de la ruta, de la tabla y del mecanismo de opt-in, dentro de las condiciones de arriba.
- Cómo se ve el 404/error del enlace (JSON o página mínima).
