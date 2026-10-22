# OPS — despliegue, entorno local e incidentes

> Bitácora operativa propia (fork `mangandini/automata-mcp`). Leer antes de tocar
> Coolify, el entorno local o la base de datos de producción. Complementa
> `CODEMAP.md` (código) y `CLAUDE.md` (por qué del diseño).

## Uso previsto

- Dos números de WhatsApp en un solo teléfono, ambos como conexiones separadas:
  - **Chile** `+56 9 3536 7655` — app WhatsApp **Business** (no es negocio; se usa para tener 2 números). 36.363 mensajes (2023-01-06 → hoy).
  - **Guatemala** — app WhatsApp normal. Conectada 2026-10-22: 69.561 mensajes importados (2023-09-04 → hoy) de ~180k estimados; WhatsApp limita el historial que entrega al vincular.
- Un token MCP por conexión → un *custom connector* en Claude.ai por número.
- El código ya soporta N conexiones WhatsApp por organización; no hubo que desarrollar nada.

## Git

- `origin` = `https://github.com/mangandini/automata-mcp` (fork, rama `main`).
- `upstream` = `https://github.com/ju-li/automata-mcp`. Actualizar: `git fetch upstream && git merge upstream/main`.
- Clon superficial (`--depth 1`) en origen; si hace falta historia: `git fetch --unshallow upstream`.
- `docker-compose.dev.yml` tiene puertos locales cambiados y está marcado `git update-index --skip-worktree` — **no se sube**. Para ver/deshacer: `git update-index --no-skip-worktree docker-compose.dev.yml`.
- ⚠️ **Todo push a `main` dispara deploy automático en Coolify** (GitHub App). No hacer push durante una importación de historial (ver incidente 3).

## Producción (Coolify)

- URL: **https://wa.royale.ventures** · servidor `saasv2`.
- Origen: *Git Repository (with GitHub App)* → `mangandini/automata-mcp`, `main`, auto deploy.
- Build pack **Dockerfile**, base dir `/`, Dockerfile `/docker/aio/Dockerfile` (imagen todo-en-uno: web + Postgres 16 + Redis + Evolution v2.3.7 + telegram bridge, supervisados por s6).
- Puerto expuesto `3000`. Volumen persistente montado en **`/data`** (postgres, redis, evolution/instances, secrets).
- Variables: `NUXT_PUBLIC_APP_URL=https://wa.royale.ventures`, `SIGNUP=invite-only`, `SIGNUP_CODE=<secreto>`. Sin SMTP (verificación de email off).
- Contenedor: nombre fijo `lu4fo3urqukvul49q6qxnmzs` (Consistent Container Name activo → deploy = stop-then-start, ~10 s de caída).
- Usuario admin: `oscar@royalestudios.com`.

### Reglas de operación

1. **Nunca dos contenedores a la vez sobre `/data`.** Coolify hace *rolling update* en Restart/Redeploy (arranca el nuevo antes de parar el viejo) → dos Postgres sobre la misma carpeta → corrupción. Para reiniciar: **Stop → esperar → Start**. *Consistent Container Name* activado (2026-10-22; según docs de Coolify fuerza stop-then-start). Verificar en el próximo deploy con `docker ps | grep lu4fo3` que nunca hay dos.
2. No Restart / Redeploy / push mientras se importa historial (esperar `progress: 100%` en el último lote `type: 2` de los logs `recv … msgs`).
3. Escanear cada QR **una sola vez**; WhatsApp limita intentos de vinculación (esperar 15–30 min si falla varias veces).

### Comandos útiles (terminal del contenedor)

La terminal de Coolify abre `sh`; los scripts necesitan bash. No hay `curl`. s6 está en `/command/`.

```sh
# Entrar desde SSH del host
docker exec -it $(docker ps --format '{{.Names}}' | grep lu4fo3 | head -1) bash

# Consultas a la BD (app + Evolution)
bash -c '. /usr/local/bin/automata-env; psql "$AUTOMATA_DATABASE_URL" -c "select email from app.users" -c "select name,label from app.instances" -c "select id,name,\"connectionStatus\",\"ownerJid\" from public.\"Instance\"" -c "select count(*) from public.\"Message\""'

# Parar / arrancar un servicio interno (postgres, evolution, web, redis, telegram-bridge)
/command/s6-svc -d /run/service/postgres     # down
/command/s6-svc -u /run/service/postgres     # up

# Sesiones de WhatsApp en disco (una carpeta por id de public."Instance")
ls -la /data/evolution/instances/
```

Puertos internos del contenedor: web 3000, Postgres 127.0.0.1:5432, Redis 6379, Evolution 18080, bridge 18095.

## Entorno local (Mac)

- Repo en `~/Developer/automata`. `.env` generado con secretos aleatorios (gitignored).
- Puertos host cambiados por conflictos con otros proyectos: **Postgres 5440** (5432 lo usa `predika-db` y un Postgres local), **Evolution 8088** (8080 lo usa zigbee2mqtt).
- Arranque: `pnpm services:up:whatsapp` y `pnpm dev` (http://localhost:3000). Parar: `pnpm services:down`.
- La conexión local de prueba (Chile) se eliminó; el entorno local ya no tiene WhatsApp vinculado. No vincular el mismo número en local y en producción a la vez.

## Cambios propios al código (commit `581f99c`)

1. `apps/web/app/components/InstanceWhatsapp.vue` — tras escanear el QR el panel se quedaba en "not connected": `polledState` (estado del poll de QR) nunca se limpiaba al llegar `open` y tapaba `data.state`. Ahora se pone a `null` después del `refresh()`.
2. `apps/web/server/utils/instances.ts › deleteInstance` — Evolution 2.3.7 responde **400** al borrar una instancia con sesión viva (hace logout pero rechaza el delete en la misma llamada); la app lanzaba error y la fila quedaba. Ahora ante 400: `logout` + reintento del delete.
3. `CODEMAP.md` + puntero en `CLAUDE.md`.

## Incidentes (2026-10-22)

### 1. Cuenta "desaparecida" / QR que no enlaza
- Síntoma: primer registro en producción OK, QR escaneado pero nunca enlazó; logs de Evolution con `PrismaClientKnownRequestError P2025 … No record was found for an update` en `connectionUpdate`. Luego "credenciales inválidas" al entrar.
- Hallazgo: `app.users`, `app.instances` y `public."Instance"` vacías aunque `/data` sí era volumen.
- Causa probable: dos contenedores (deploy/rolling update) con bases distintas o la BD reinicializada; el socket del QR quedó apuntando a una instancia inexistente.
- Resolución: prueba de persistencia (registrarse → reiniciar → volver a entrar) y re-vincular.

### 2. `P2025` persistente tras vincular bien
- Causa: carpeta de sesión huérfana `/data/evolution/instances/12f3e406-…` del intento fallido; Evolution la cargaba sin fila en `public."Instance"`.
- Resolución: borrar esa carpeta (comparar carpetas con `public."Instance".id`; la buena era `448e6d36-…`) y reiniciar. El error no lleva el prefijo `[i-<nombre>]` de la instancia real — pista para distinguirlo.

### 3. Postgres corrupto → dashboard 500
- Síntoma: 500 en el dashboard; logs `PANIC: could not locate a valid checkpoint record`, `record with incorrect prev-link`, `ECONNREFUSED 127.0.0.1:5432`, Postgres en bucle de reinicio. Ocurrió tras un **Restart** en Coolify (16:23).
- Causa: rolling update → dos Postgres sobre `/data/postgres` a la vez → WAL inconsistente (pese a "shut down" limpio).
- Recuperación (funcionó, sin pérdida apreciable: 36.362 mensajes):
  ```sh
  /command/s6-svc -d /run/service/postgres
  cp -a /data/postgres /data/postgres.bak-$(date +%H%M)     # copia: /data/postgres.bak-1629 (borrar cuando esté estable)
  su postgres -s /bin/sh -c "/usr/bin/pg_resetwal -f /data/postgres"
  /command/s6-svc -u /run/service/postgres
  # verificar
  bash -c '. /usr/local/bin/automata-env; psql "$AUTOMATA_DATABASE_URL" -c "REINDEX DATABASE $POSTGRES_DB" && pg_dump "$AUTOMATA_DATABASE_URL" > /data/check.sql && echo DUMP_OK && rm /data/check.sql'
  ```

## Errores de logs que son normales

- `stream errored out` con código **515** justo tras escanear: WhatsApp pide reiniciar el socket; Baileys reconecta solo.
- `Original message not found for update. Skipping.`: updates de mensajes aún no importados.
- `Error: rate-overlimit` (`data: 429`) en `groupMetadata` / `updateGroupMetadataCache` durante la importación: WhatsApp frena peticiones; el `statusCode: 500` es el envoltorio genérico de Baileys, no un 500 HTTP.
- `is latest: false` en las líneas `recv …`: no indica fin; el fin es `progress: 100%` del último lote `type: 2` y que dejen de llegar lotes.
- Mensajes recibidos mientras Evolution está caído/reiniciando no se pierden: WhatsApp los encola para el dispositivo vinculado (~14 días).

## Pendientes

- [x] Activar nombre de contenedor consistente en Coolify (2026-10-22). Verificado en el deploy de `9c107ea`: log "rolling update is not supported", stop+rm del viejo y luego start del nuevo (nombre fijo `lu4fo3urqukvul49q6qxnmzs`).
- [x] Conectar Guatemala (69.561 mensajes).
- [ ] Crear token por conexión y añadir 2 custom connectors en Claude.ai.
- [ ] Borrar `/data/postgres.bak-1629` cuando esté estable.
- [ ] Opcional: SMTP para alertas de desconexión; backups periódicos de `/data` (p. ej. `pg_dump` programado).
