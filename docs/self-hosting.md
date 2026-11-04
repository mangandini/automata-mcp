# Self-hosting

Two ways to run the whole app from published images:

- **[Single container](#single-container)** — one `docker run`. Postgres,
  Redis, Evolution API, the web app and the Telegram bridge share one image and
  one volume; every secret is generated on first boot.
- **[Docker Compose](#docker-compose)** — `docker-compose.yml` at the repository
  root, one container per service, WhatsApp and Telegram behind profiles.

Neither is the development setup; for that, see [Development](development.md).

## Single container

```bash
docker run -d --name automata --restart unless-stopped --stop-timeout 30 \
  -p 3000:3000 -v automata_data:/data \
  -e NUXT_PUBLIC_APP_URL=https://automata.example.com \
  ghcr.io/ju-li/automata-mcp-aio:1
```

Open the app on port 3000 and sign up. The first account creates an
organization and is its admin. First boot creates the database and runs
Evolution's and the app's migrations; `docker logs -f automata` shows each
service starting.

`NUXT_PUBLIC_APP_URL` is the address people will open — every connector URL is
built from it. Left out, it defaults to `http://localhost:3000`, which is fine
for trying it and wrong for anything Claude has to reach.

`--stop-timeout 30` gives the services time to stop in order — the web app,
Evolution and the bridge first, Postgres last. Docker's default 10 seconds can
cut that short.

### What is inside

| Process | Version | Listens on (inside the container) |
|---|---|---|
| Web app | this release | `3000`, or `$PORT` — the only port to publish |
| Postgres | 16 (Alpine's `postgresql16`) | `127.0.0.1:5432` |
| Redis | 8.2.9 | `127.0.0.1:6379` |
| Evolution API | v2.3.7 | `18080` |
| Telegram bridge | this release | `18095` |

The image is built on Evolution's own image, so Evolution runs exactly as it
ships; [s6-overlay](https://github.com/just-containers/s6-overlay) starts the
rest in order, restarts what crashes and stops the container if a start-up step
fails. The image is large (about 2 GB), most of it Evolution's.

`PORT` may not be one of the internal ports above; the container refuses to
start and says so.

### Memory and architecture

Give the container **at least 2 GiB** (`docker run --memory=2g`). Five processes
share it: Postgres, Redis, Evolution, the web app and the bridge use about
350 MiB idle, and the web app's attachment reading comes on top (see
[Memory for attachments](whatsapp.md#memory-for-attachments)). The 2 GiB figure
is a recommendation, **not measured under full load**: the web part alone was
measured, in its own container.

The image is **`linux/amd64` only**: it downloads the amd64 build of s6-overlay,
pinned by checksum, so it cannot be built for arm64. On an arm64 host run it
under emulation, or use [Compose](#docker-compose) with a web image you build
on that host. `docker-compose.yml` pulls the published image, so point its `web`
service at yours:

```bash
docker build -f apps/web/Dockerfile -t automata-web:local .   # from the repo root
# in docker-compose.yml, under services.web:
#   image: automata-web:local        (instead of ghcr.io/ju-li/automata-mcp-web:1)
```

(Build the web image on that host: the `sharp` binary is picked at install time.)

### Everything lives in `/data`

| Path | Holds |
|---|---|
| `/data/postgres` | the database: every user, connection, stored credential and synced message |
| `/data/redis` | Evolution's cache |
| `/data/evolution` | Evolution's session files |
| `/data/secrets` | the generated secrets, one file each |

**Back up the whole volume.** On first boot the container generates
`POSTGRES_PASSWORD`, `WEBHOOK_SECRET`, `EVOLUTION_API_KEY`,
`TELEGRAM_BRIDGE_ADMIN_KEY` and `TELEGRAM_SESSION_ENCRYPTION_KEY` into
`/data/secrets`. Losing `TELEGRAM_SESSION_ENCRYPTION_KEY` unlinks every Telegram
account; losing the volume loses everything, and every WhatsApp number needs its
QR scanned again.

An environment variable with one of those names overrides the stored file
(which is left as it was). Set them only if you manage secrets elsewhere, keep
them URL-safe (`openssl rand -hex 32`), and never change
`TELEGRAM_SESSION_ENCRYPTION_KEY` after the first boot.

`docker rm` and `docker run` again with the same volume is safe — that is also
how to update. **`docker volume rm automata_data` is the single-container
`docker compose down -v`**: see the warnings below.

### Options

Everything is optional. The names are the ones `.env.selfhost.example` uses, so
a filled-in copy works as `docker run --env-file .env …`; blank values are
ignored.

| Variable | For |
|---|---|
| `NUXT_PUBLIC_APP_URL` | the public address (above) |
| `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` | Telegram — from <https://my.telegram.org>, both or neither. Without them the app tells an admin what to set. See [Telegram connections](telegram.md). |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_TLS`, `MAIL_FROM`, `MAIL_FROM_NAME` | [connection alerts](alerts.md) and invitation emails |
| `NUXT_ALLOW_PRIVATE_TARGETS` | `true` lets connections reach private and loopback addresses — see below |
| `SIGNUP`, `SIGNUP_CODE` | who can create an account — see [Who can sign up](#who-can-sign-up) |
| `PORT` | the web app's port inside the container (default 3000) |

`NUXT_ALLOW_PRIVATE_TARGETS=true` means more here than with Compose: every
backend is on the container's loopback. The app still refuses its own Postgres,
Evolution and bridge by address and port, but not Redis on `127.0.0.1:6379`, so
turn it on only where everyone with an account is trusted.

### Updating

```bash
docker pull ghcr.io/ju-li/automata-mcp-aio:1
docker rm -f automata
docker run -d --name automata …   # the same command as before
```

Migrations run at boot and only go forward, so moving to a new major is a
deliberate edit of the tag. See [Releases](releases.md).

### When to use Compose instead

Choose Compose when you want to restart, upgrade or back up one service without
the others, put Postgres on its own disk, or leave out WhatsApp or Telegram
entirely. The single container always runs all of them.

## Docker Compose

### Start it

```bash
git clone https://github.com/ju-li/automata-mcp.git && cd automata-mcp
cp .env.selfhost.example .env
for k in POSTGRES_PASSWORD WEBHOOK_SECRET EVOLUTION_API_KEY TELEGRAM_BRIDGE_ADMIN_KEY TELEGRAM_SESSION_ENCRYPTION_KEY; do
  echo "$k=$(openssl rand -hex 32)"; done >> .env
```

Set `NUXT_PUBLIC_APP_URL` in `.env` to the address people will open — it is
what every connector URL is built from. Then pick what to run:

```bash
docker compose up -d                                         # database connections only
docker compose --profile whatsapp up -d                      # + WhatsApp (Evolution API, Redis)
docker compose --profile whatsapp --profile telegram up -d   # + Telegram bridge
```

Open the app on port 3000 (`WEB_PORT`) and sign up. The first account creates
an organization and is its admin. The app creates its database schema on first
boot — look for `[app-db] applied migrations` in `docker compose logs web`.

Telegram also needs your own `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` from
<https://my.telegram.org>; without them the bridge runs and the app tells an
admin what to set. See [Telegram connections](telegram.md).

Mail is optional: with `SMTP_HOST` empty, [connection alerts](alerts.md) and
invitation emails are not delivered; an invitation link is still shown on
screen when it is created.

### What it runs

| Service | Image | Profile | Published |
|---|---|---|---|
| `web` | `ghcr.io/ju-li/automata-mcp-web:1` | — | `WEB_PORT` → 3000 |
| `postgres` | `postgres:16.15-alpine` | — | no |
| `redis` | `redis:8.2.9-alpine` | `whatsapp` | no |
| `evolution` | `evoapicloud/evolution-api:v2.3.7` | `whatsapp` | no |
| `telegram-bridge` | `ghcr.io/ju-li/automata-mcp-telegram-bridge:1` | `telegram` | no |

Give the `web` service **at least 1 GiB** of memory (`mem_limit: 1g`, or your
platform's limit): reading attachments is the one thing that makes its memory
depend on what a chat contains (two hostile PDFs, an ordinary one and a 25 MB
link download at once peaked at 528-585 MiB in a 1 GiB container). The figures
behind that are in
[Memory for attachments](whatsapp.md#memory-for-attachments). The web image is
published for `linux/amd64` and also builds and runs on arm64 when built on an
arm64 host.

Only the web app is published. Everything else, including the webhooks
Evolution and the bridge send back to the app, travels over the compose
network. The web service's `NUXT_*` variables are set in `docker-compose.yml`
from the handful in `.env`, so one Postgres, one password and one webhook
secret serve all of it.

Put the web app behind a TLS-terminating reverse proxy before anyone else uses
it, and set `NUXT_PUBLIC_APP_URL` to the `https://` address. Claude connects to
the connector URL from its own servers, so it must be reachable from the
internet.

The images are pinned to the major tag `:1`. To update within it:

```bash
docker compose pull && docker compose up -d   # add the same --profile flags
```

Migrations run at boot and only go forward, so moving to a new major is a
deliberate edit of the tag, not something `pull` does for you. See
[Releases](releases.md).

## Who can sign up

Each self-signup creates a new organization, and its admin can start
connections on your Evolution server and Telegram bridge. So by default nobody
can sign up without an invitation:

| `SIGNUP` (`NUXT_SIGNUP`) | `SIGNUP_CODE` (`NUXT_SIGNUP_CODE`) | Without an invitation |
|---|---|---|
| unset or `invite-only` | unset | only the first account on an empty database — that person becomes admin |
| unset or `invite-only` | set | anyone who enters the code, the first account included |
| `open` | ignored | anyone who finds the URL |

Invitation links work in every mode. Neither variable is required: a new
install with both unset lets you sign up first, and you invite everyone else
from the Team page.

Until that first signup, a fresh install on a public address belongs to
whoever opens it first. If that window matters, set `SIGNUP_CODE` before you
start the stack (`openssl rand -base64 24`) and hand the code only to people
who should get their own organization.

**`NUXT_ALLOW_PRIVATE_TARGETS=true` with `SIGNUP=open` is the risky
combination.** Any stranger who signs up can then paste a database or Evolution
address such as `postgres://…@192.168.1.20:5432/…` and the server connects to
it for them. The app still refuses its own Postgres, Evolution and bridge, but
not anything else on your network. Keep private targets for deployments where
everyone with an account is trusted, and keep sign-up closed there.

### Email verification

Without it, anyone can register `someone@yourcompany.com` before its owner
does, and the owner can then neither sign up nor accept an invitation sent to
that address. With it, signing up (with or without an invitation) and changing
an account's address both mail a six-digit code and a link, and nothing is
created or changed until one comes back. A signup that is never confirmed holds
no claim on the address and expires after 30 minutes.

| `EMAIL_VERIFICATION` (`NUXT_EMAIL_VERIFICATION`) | Behaviour |
|---|---|
| unset or `auto` | on when `SMTP_HOST` is set, off otherwise |
| `required` | always on; with no SMTP, signups and address changes are refused |
| `off` | never; the password alone proves an address change, as before |

Anything else is read as `required`. The link is built from
`NUXT_PUBLIC_APP_URL` only, never from the request, so a forged `Host` header
cannot redirect it; without that URL the mail carries the code alone. Existing
accounts are not asked to verify.

## ⚠️ WhatsApp pairing burns a real phone number

Scanning the QR binds a real WhatsApp account to an instance. WhatsApp rate-limits
and can ban numbers that pair and unpair repeatedly, or that send unsolicited
messages from a freshly-paired session. **Use a spare SIM, not your primary
number**, and keep test traffic to conversations you control.

## ⚠️ `docker compose down -v` forces a QR re-scan

`-v` deletes the `evolution_instances` volume, which holds every paired session.
Every instance has to be re-paired by scanning a new QR code — see the warning
above about what that costs. For routine restarts use `down` without `-v`:

```bash
docker compose --profile whatsapp --profile telegram down
```

Back up the `postgres_data` volume: it holds every user, connection, stored
credential and synced message.

The single container's equivalent is `docker volume rm` on the volume mounted at
`/data` — it holds the sessions and the database alike. `docker rm` alone is
safe.

## The app database

Everything the app itself keeps is in the `app` schema of `NUXT_DATABASE_URL` —
the same Postgres Evolution writes into (under `public`) and the Telegram bridge
uses (under `telegram`). The schema is `apps/web/server/db/migrations.ts`, applied
in order when the server starts, under an advisory lock and in one transaction;
`app.migrations` records which have run. Migrations are append-only: one that has
been deployed is never edited, because it will not run again anywhere it already
has.

| Table | Holds |
|---|---|
| `users` | email (stored lower-cased), display name, password hash |
| `sessions` | browser sessions — SHA-256 of the cookie, expiry |
| `organizations`, `memberships` | one membership per user (a unique index), with its role |
| `instances` | one row per connection, `kind` of `whatsapp`, `postgres` or `telegram` |
| `instance_assignments` | "may use, not manage" grants to members |
| `invitations` | SHA-256 of the invitation code, address, role, expiry |
| `mcp_tokens` | SHA-256 of the connector token, holder, scope, expiry, `last_used_at` |
| `totp_credentials`, `webauthn_credentials`, `recovery_codes`, `mfa_challenges` | second sign-in factors — see [Two-factor authentication](two-factor.md) |

An `instances` row carries, by kind:

- **WhatsApp** — the Evolution instance's `name` and `instance_id`, its
  `base_url`, and the per-instance `api_key`. A bring-your-own connection also
  carries its server's `admin_key` and, once supplied, `evolution_db_url`.
- **Postgres** — the `dsn`, plus `db_host`, `db_port` and `db_database` for
  display. Nothing connects through the display three.
- **Telegram** — the bridge's `base_url`, the session's `instance_id` and
  `api_key`, and for a bring-your-own bridge its `admin_key` and `telegram_db_url`.

Two more columns, `down_since` and `alerted_at`, carry outage state — see
[Connection alerts](alerts.md).

`api_key`, `admin_key`, `dsn`, `evolution_db_url` and `telegram_db_url` never
leave the server — `toPublicInstance()` is the only projection the UI receives —
but they are **not encrypted**: they sit in clear in the database and in every
backup of it. So treat `NUXT_DATABASE_URL` and the database's backups as holding
every connected account.

Foreign keys say what deleting does. A user's tokens, sessions, memberships and
assignments go with them; a connection's tokens and assignments go with it. An
organization that still owns connections **cannot** be deleted, and a connection
does not go with its creator — a cascade there would drop rows pointing at live
WhatsApp sockets without ever telling Evolution.

To start over locally, drop the schema; the next boot recreates it:

```bash
psql postgres://evolution:change-me@localhost:5432/evolution -c 'DROP SCHEMA app CASCADE'
```

## Coming from PocketBase

Versions before this one kept all of this in PocketBase. A deployment still on
PocketBase must first deploy commit `2e1872e` (the merge of ju-li/automata-mcp#46), which imports
every user, password, connection and token into this schema on its first boot —
see [the README at that commit](https://github.com/ju-li/automata-mcp/blob/2e1872e/README.md), "Moving off PocketBase". Accounts imported that way
keep their bcrypt password hash until they next sign in, when it is replaced with
scrypt.
