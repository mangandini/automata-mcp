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
| Dónde vive el archivo | **Nunca en disco ni en base de datos.** Se permite una **copia temporal en memoria** si mejora la experiencia (aclaración del usuario, 2026-11-04; ver "Copia temporal en memoria"). Sin copia, al abrir el enlace se vuelve a descargar de WhatsApp vía Evolution. El enlace puede fallar si WhatsApp ya borró el archivo o la conexión cayó; debe decirlo (a Claude, con la causa; en la página pública, sin revelar el estado de la cuenta: "WhatsApp no entregó el archivo ahora; puede haber expirado o la cuenta estar desconectada; pide que te lo reenvíen"). |
| Tipos | **PDFs/documentos e imágenes.** Fuera: notas de voz, audio, video, stickers. |
| Activación | **Opt-in por token.** Un token con "todas las herramientas" **no** recibe este tool automáticamente; hay que marcarlo. |

## Objetivos

1. Tool MCP de lectura `get-message-media { messageId }` para conexiones `whatsapp`.
2. Imagen → **reducida y comprimida en el servidor** hasta caber en el presupuesto de respuesta, y enviada como bloque `image`. PDF → **texto extraído en el servidor** y enviado como bloque de texto (recortado al presupuesto, diciendo si se recortó); un PDF escaneado sin texto → solo enlace, y `note` lo dice. Otros documentos (xlsx, docx, …) → solo metadatos y enlace. (Decisiones del usuario 2026-11-04, tras la investigación de abajo.)
3. En todos los casos soportados, y si `NUXT_PUBLIC_APP_URL` está configurada, un **enlace de descarga** de 1 hora, reutilizable, con el nombre de archivo original.
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

- Entrada estricta (`strictInput`): `messageId` (el `id` que devuelven `search-messages` / `read-messages`), validado como id de WhatsApp (alfanumérico, longitud acotada) antes de cualquier consulta. Sin `jid`: el chat sale de la fila.
- Anotaciones: `readOnlyHint: true`, `openWorldHint: true` (habla con WhatsApp), `idempotentHint: false` (cada llamada crea un enlace).
- Pasos, en este orden:
  1. **Fila.** Buscar por `instanceId` + `key->>'id'`, deduplicada como el resto de lecturas (`DISTINCT ON`, elección determinista de la copia), con el **predicado de scope en SQL** cuando el token no tiene `allChats`: `remoteJid = ANY(chats permitidos)`, **solo `remoteJid`**, el mismo predicado que `search-messages`. Así es descargable exactamente lo que el token puede leer o buscar; nunca vía `remoteJidAlt` (abriría el chat `@lid` de un token con scope en la forma teléfono). Ninguna fila → 404 con **un solo mensaje** para "no existe" y "no está en tu scope".
  2. **Tipo, por payload** (no por `messageType`). Desenvolver como `classifyContent` (`associatedChildMessage`, `protocolMessage.editedMessage`, `documentWithCaptionMessage`) **más `ephemeralMessage`** (mi decisión: en chats con mensajes temporales todo adjunto llega dentro de ese envoltorio, y Evolution también lo desenvuelve; view-once sigue fuera) ( exportar o compartir esa lógica, hoy no exportada). `imageMessage` → imagen. `documentMessage` con mime `image/*` (capturas enviadas "como documento") **y bytes mágicos de imagen** → camino de imagen. `documentMessage` PDF → camino PDF. Otro `documentMessage` → solo enlace. Cualquier otra cosa (audio, video, sticker, view-once, texto) → "tipo no soportado" nombrando el tipo. `fileLength` llega como texto (uint64) y puede faltar: tratar ausencia como "desconocido", no como 0.
  3. **Tamaño declarado** (`fileLength`) sobre el **tope de enlace** → rechazado antes de descargar. Sobre el **tope de lectura** → no se descarga para Claude; se crea el enlace igual y `note` lo dice.
  4. **Descarga** (función compartida con la ruta del enlace, ver "Descarga desde Evolution").
  5. **Contenido para Claude**, dentro del **presupuesto de respuesta**:
     - Imagen: escalera de reducción (abajo). Si ni el último paso cabe → solo enlace, con `note`.
     - PDF: texto extraído con topes (abajo); `note` dice si se recortó y hasta qué página. Sin texto (escaneado) → solo enlace, con `note`.
     - No se usa bloque `resource` con blob (en Claude.ai no se lee de forma fiable).
  6. **Enlace** (ver abajo) y respuesta `content: [...]`: primero JSON con metadatos (`messageId`, `jid`, `type`, `fileName`, `mimeType`, `size`, `download: { url, expiresAt }`, `note`), luego el bloque `image` o el texto. Sin `NUXT_PUBLIC_APP_URL` → sin enlace, y `note` lo dice; nunca con el `Host` de la petición.

### Descarga desde Evolution (una sola función, tool y enlace)

- `POST /chat/getBase64FromMediaMessage/{instance}` con el **mensaje completo ya comprobado y desenvuelto** (`{ message: { key, message: <interior> } }`), nunca solo `key.id`: con solo el id Evolution busca la fila sin predicado de chat ni orden y no desenvuelve `associatedChildMessage` (fotos de álbum). Así lo descargado es exactamente lo comprobado.
- Cliente por instancia con `createEvolutionClient(credentialsForInstance(fila de la conexión))`, que conserva el host-guard; nunca clave global.
- `fetch` con lectura del cuerpo y **contador de bytes**: se aborta si supera `ceil(tope × 4/3) + 8 KiB` (sobre JSON + nombre/caption, también acotados). Así el base64→Buffer nunca corre sobre un cuerpo excesivo. **Límite honesto:** esto protege solo nuestro proceso; Evolution no tiene tope y `fileLength` lo escribe quien envía, así que un tamaño falso hace que Evolution cargue el archivo real (hueco que ya existe para cualquiera con la clave de instancia; documentarlo).
- **Timeout propio 30 s** (mi decisión). Al vencer, el pedido de re-subida al teléfono sigue pendiente dentro de Evolution: **enfriamiento por mensaje** (mi decisión: 2 min) antes de volver a intentar el mismo id.
- **Semáforo de proceso** para descargas y procesamiento (mi decisión: 2 a la vez; quien no lo obtiene en 20 s recibe 503 "ocupado, reintenta") y **deduplicación en vuelo** con clave `instanceId` + `remoteJid` + `key.id` (nunca el id solo): dos peticiones simultáneas del mismo archivo comparten una descarga, sin retener nada después de responder.
- Verificar `fileSha256` del mensaje contra los bytes cuando el mensaje lo trae (Baileys no lo verifica). Distinto → error, nunca se sirve.
- Respuesta 201 con cuerpo `null` (mensaje solo con `messageContextInfo`) o sin `base64` → error explícito, nunca archivo vacío.
- **Clasificación de errores** (todo llega como 400 con texto en `response.message[0]`): `Message not found` y `not of the media type` son inalcanzables al mandar el mensaje completo (no hay búsqueda y el tipo ya se comprobó): si aparecen, log como bug y respuesta genérica; texto con código 404/410 del CDN → "WhatsApp ya no tiene este archivo; pide que lo reenvíen"; timeout propio → "WhatsApp no respondió; puede que el archivo ya no esté"; cualquier otro → mensaje genérico honesto, y el texto completo al log del servidor. Ante un fallo se consulta el **estado en vivo** (`getInstanceStatus`): si no está `open`, el mensaje lo dice ("la cuenta está desconectada"). Solo al modelo/usuario autenticado; la página pública no revela el estado de la cuenta.

### Procesamiento con topes (memoria y CPU)

- **Tope de lectura** 10 MB (mi decisión) y **tope de enlace** 25 MB (`NUXT_WHATSAPP_MEDIA_MAX_BYTES`), ambos en `.env.example`.
- **Imagen**: leer dimensiones de la cabecera **antes** de decodificar; tope de píxeles (mi decisión: 40 Mpx) → por encima, solo enlace. Quitar EXIF (también GPS). Escalera (JPEG mozjpeg): (0) original ≤ 1568 px de lado mayor y dentro del presupuesto → tal cual; (1) 1568 px, calidad 80→65→50; (2) 1024 px, 75→60→50; (3) 768 px, 70→55; si no cabe → solo enlace (bajo 768 px una captura de 1080 de ancho queda con dígitos ilegibles).
- **PDF**: extracción incremental con topes de páginas (mi decisión: 50), caracteres (hasta llenar el presupuesto) y tiempo (mi decisión: 10 s); se para al llegar a cualquiera, no extrae todo para luego recortar. PDF cifrado o corrupto → solo enlace, con `note`.
- El trabajo pesado no puede bloquear el servidor para el resto del tráfico MCP y el panel: el constructor mide y, si bloquea, lo saca del hilo principal (worker).
- **Presupuesto de respuesta**: una sola constante; mi decisión inicial ≤ 120 000 caracteres en total, imagen en base64 incluida (≈ 85 KB de JPEG). Primera prueba en vivo: si el base64 de la imagen **no** cuenta contra el límite de Claude.ai, subir el tope de imagen (≤ 1 MB, por debajo de los 5 MB/8000 px de la API).

### Enlace de descarga

- Forma: `{NUXT_PUBLIC_APP_URL}/api/media/<token>` (prefijo exacto al constructor, fuera de `/mcp`). Token en el **path**, nunca en query. Prefijo + 32 bytes aleatorios; se guarda **solo el SHA-256** (índice único), comparación por hash.
- **Abrir el enlace no descarga.** `GET` (y `HEAD`) sirve una **página mínima autocontenida** (sin JS, sin recursos externos), con el nombre del archivo escapado y un botón **Descargar** que es un `<form method="post">` a la misma URL. Solo el `POST` descarga de WhatsApp. Las vistas previas de enlaces y los escáneres abren `GET` pero no envían formularios — misma regla que la verificación de correo ("mail scanners open links"). Para el usuario es un toque más en el teléfono. `GET`/`HEAD` no llaman a Evolution ni cuentan descargas. Mi decisión: la página no muestra nada más que el nombre, la expiración y el botón. **Todas** las respuestas de la ruta (página, "vencido", errores, archivo) llevan `Content-Security-Policy: default-src 'none'; form-action 'self'` (el archivo, `sandbox`), `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`.
- Tabla nueva en `app` (migración nueva, append-only): hash, conexión, token MCP que lo creó, `messageId`, chat (`remoteJid`), nombre de archivo, mime, `expires_at` (creación + 1 h, indexado), creado, contador de descargas. **Sin bytes.** Claves foráneas a `instances` y `mcp_tokens` con `ON DELETE CASCADE` (deleteInstance no debe fallar por un enlace; los tokens se revocan, no se borran, así que la cascada en tokens es por coherencia).
- `POST` del enlace, en orden:
  1. Hash → fila; inexistente o vencida → misma página "enlace vencido o inválido", sin distinguir.
  2. **Hechos del token compartidos con MCP:** extraer de `resolveMcpAuth` solo la consulta (`SELECT … LEFT JOIN users/memberships … EXISTS assignment`) a `selectTokenFacts(sql, { hash } | { id })` y un predicado `isTokenLive(facts)` (revocado, vencido), que `resolveMcpAuth` pasa a usar sin cambiar su orden, su log por mitad ni su 503. La deriva vive en los joins (`assigned` sobre `t.instance`, `member_org` contra la org de la instancia **del token**), por eso el texto SQL se comparte, no se copia. La ruta carga el token **por id** desde la fila del enlace y exige: `isTokenLive`, `authorizesInstance()` (miembro, org, asignación), `link.instance = token.instance`, `instanceKind(instancia) === 'whatsapp'`, el tool opt-in marcado, y el chat del enlace en el scope del token. Cualquier fallo → la misma página "vencido o inválido"; fallo de BD → 503 con log. **Nunca** se pone ni se simula `event.context.mcpAuth`, nunca se usa la sesión del navegador. Revocar el token, quitar la asignación, degradar o eliminar al miembro, borrar la conexión, desmarcar el tool o sacar el chat del scope matan sus enlaces; **rotar el secreto no** (un enlace filtrado vale hasta vencer, máx. 1 h).
  3. **Reclamar** una descarga por escritura condicional (`UPDATE … SET downloads = downloads + 1 WHERE downloads < 20 AND expires_at > now() RETURNING`) **antes** de descargar; si la descarga falla por WhatsApp/Evolution, **devolver** el cupo. Sin reclamo posible → "límite alcanzado".
  4. Re-leer la fila del mensaje de la BD de Evolution (`instanceId` + id + `remoteJid` guardado), re-desenvolver y descargar con la función compartida, mismos topes y `fileSha256`.
  5. Responder con `Content-Disposition: attachment; filename*=UTF-8''…` (RFC 5987; quitar CR/LF, controles y U+202E/bidi; nombre vacío → `archivo.<ext>`; descartar el nombre de respaldo de Evolution tipo `ID.false`), `Content-Type` de una **lista permitida** (pdf, imágenes raster, ofimática); cualquier otro → `application/octet-stream`; **nunca** `text/html`, `image/svg+xml`, `application/xhtml+xml`. Además `Content-Security-Policy: sandbox`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `Accept-Ranges: none`.
- Ruta excluida de `server/middleware/session.ts` (como `/mcp` y `/api/webhook/`), redactada en `redact.ts` / `plugins/redact-mcp.ts` (hoy solo `/mcp`), y throttle en memoria por IP (velocidad, no control; `clientIp` toma el último salto de `X-Forwarded-For`: confirmar que en Coolify hay un solo proxy).
- **Logs fuera del proceso**: el proxy de Coolify (Traefik) o Railway registran el path con el token en sus propios logs de acceso; el criterio "no aparece en logs" cubre solo los de la app. Decirlo en `OPS.md` y en la descripción.
- Cada llamada al tool crea un enlace nuevo. Filas vencidas se borran (tarea programada o al crear; mi decisión: al crear, `DELETE … WHERE expires_at < now() - 1 day`). Todo el estado en BD: vale con varias réplicas.
- **Copia temporal en memoria** (permitida por el usuario si mejora la experiencia; parámetros, mi decisión):
  - Al descargar (en el tool o en un `POST`), los bytes verificados (`fileSha256`) quedan en una caché **solo en memoria del proceso**, clave `instanceId` + `remoteJid` + `key.id`, **10 min** desde la última descarga y nunca más allá del `expires_at` del enlace.
  - Así, abrir el enlace poco después de que Claude lo leyó no vuelve a pedir el archivo a WhatsApp (más rápido, y sigue funcionando si el teléfono deja de responder o el archivo expira en esos minutos); un doble toque o una segunda descarga tampoco.
  - **Las comprobaciones del `POST` (paso 2, token vivo, scope, opt-in; paso 3, cupo) corren siempre antes de servir desde la caché**: la caché ahorra la descarga, nunca la autorización.
  - Tope total (mi decisión: 100 MB, LRU) y ningún archivo por encima del tope de enlace; al vencer o expulsarse, se suelta la referencia. No se escribe a disco ni a BD; con varias réplicas cada una tiene la suya (una réplica sin la copia simplemente descarga).
  - Se vacía la entrada si la descarga verificada no coincide o si el enlace se revoca en el `POST`.

### Opt-in

- Marca `optIn: true` en la definición del tool, registrada junto a `TOOL_KINDS` en `mcp-kind-tool.ts` y expuesta por `api/instances/[id]/mcp-tools.get.ts`.
- `isToolAllowed`: `allTools` concede todo **excepto** los tools opt-in, que exigen su nombre en `toolNames`. Sigue síncrono.
- `scopeFields()` (`tokens.ts`) y `scopeFromInput()` (`scope-schema.ts`) hoy **vacían** `tool_names` cuando `all_tools` es verdadero: pasan a conservar en ese caso los nombres opt-in (y solo esos). Tokens existentes tienen `tool_names = []` → no lo ganan.
- `TokenScopeFields.vue`: los opt-in como casillas aparte, desmarcadas, visibles también con "todas las herramientas", con la línea "descarga adjuntos y crea enlaces de descarga de 1 hora". `useTokenScope.ts`: `readOnlyScope()` **no** pre-marca opt-in aunque sean `readOnlyHint`; "Full access" se mantiene para `all_tools` y se añade "+ adjuntos" cuando el opt-in está marcado. La lista de acciones seleccionables (de `mcp-tools.get`) excluye los opt-in, para que la casilla no salga dos veces.

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
- **Dependencias nuevas** (decisión del usuario): extracción de texto de PDF en JavaScript puro (no `pdf-parse` v1, que lee un fichero de prueba al cargarse sin `module.parent` y rompe con el empaquetado de Nitro; candidatos `unpdf`/`pdfjs-dist`) y procesamiento de imágenes (`sharp` tiene binario musl para Alpine). Ambos Dockerfiles copian solo `.output` (`apps/web/Dockerfile`, `docker/aio/Dockerfile`): verificar que el binario nativo queda trazado ahí y añadir una comprobación en build (`require` + versión) como las que ya tiene la imagen aio. Probar el tool **desde la imagen Docker construida**, no solo en `pnpm dev`.
- Sin framework de tests: `pnpm typecheck` + llamadas JSON-RPC reales (local y producción).

## Criterios de aceptación (producción, GT/CL, salvo donde se diga local)

1. Búsqueda de "nómina" (o similar) con un PDF → Claude recibe su texto y un enlace; desde otro navegador sin sesión el enlace muestra la página, el botón descarga el archivo idéntico (tamaño y SHA-256) con su nombre, en **iOS Safari y Chrome Android**.
2. Una imagen (y una captura enviada "como documento") → bloque `image` legible (registrar paso de la escalera y tamaño) + enlace.
3. El `.xlsx` del caso CL 2026-05-14 → metadatos + enlace que lo descarga.
4. Enlace: `GET`/`HEAD` no descargan ni cuentan; dos `POST` simultáneos → una sola llamada a Evolution; dos descargas dentro de la hora funcionan; la 21.ª → "límite"; tras 1 h → "vencido".
5. El enlace muere al: revocar el token, vencer el token MCP (`expires_at`), quitar la asignación, degradar/eliminar al miembro, desmarcar el tool, sacar el chat del scope, borrar la conexión. Rotar el secreto no lo mata (documentado).
6. Mensaje de un chat fuera del scope → mismo error que un id inexistente.
7. Token con "todas las herramientas" sin la casilla → el tool no aparece en `tools/list`; tokens existentes no lo ganan; el selector y `readOnlyScope` no lo pre-marcan.
8. Audio/video → "tipo no soportado"; sobre el tope de enlace → rechazado antes de descargar; entre tope de lectura y de enlace → sin contenido, con enlace que funciona.
9. Medio antiguo que WhatsApp ya no tiene → error explícito (registrar antigüedad y texto observado); cuenta desconectada → lo dice al modelo.
10. Foto de álbum (`associatedChildMessage`) → se descarga la foto correcta, en el tool y en el enlace.
11. Local, con archivos fabricados: PNG bomba de píxeles, PDF de 500 páginas, PDF cifrado, documento `text/html` y SVG (servidos como `octet-stream`), nombre con CR/LF y U+202E, `fileSha256` distinto → cada uno rechazado o neutralizado sin caer el proceso; RSS medido durante una descarga de 25 MB.
12. Sin `NUXT_PUBLIC_APP_URL` → contenido sin enlace y `note` lo dice; aviso único al arrancar (plugin como `evolution-db-check.ts`).
13. El token del enlace no aparece en los logs de la app, tampoco en una ruta de error.
14. La imagen Docker construida ejecuta el tool (PDF e imagen).

## Lo que queda al constructor

- Librerías concretas, siempre que cumplan lo de arriba en las tres imágenes.
- Si el trabajo pesado necesita worker (medirlo).
- Nombre exacto del prefijo de la ruta y de la tabla; aspecto de la página intermedia (mínima, sin JS).
- Texto exacto de los errores de Evolution para medio expirado (verificar en vivo).

## Documentación a actualizar

`WHATSAPP_INSTRUCTIONS`, descripción del tool, `CLAUDE.md` (nueva ruta pública, tercer camino de credenciales, opt-in), `CODEMAP.md`, `OPS.md` (logs del proxy, NUXT_PUBLIC_APP_URL necesaria), `.env.example` (dos topes), `docs/whatsapp.md`, `docs/searching-whatsapp.md`, y `docs/mcp-roadmap.md` N4 (hoy dice xlsx → `resource` y "igual que read-messages": corregir a solo enlace y 404 uniforme).
