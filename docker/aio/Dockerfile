# The all-in-one image: Postgres, Redis, Evolution API, the web app and the
# Telegram bridge in one container, for a single `docker run`. See
# docs/self-hosting.md, "Single container". docker-compose.yml remains the
# multi-container way to run the same thing.
#
# Build context is the REPO ROOT, like the other two Dockerfiles:
#
#   docker build -f docker/aio/Dockerfile -t automata-mcp-aio .
#
# s6-overlay supervises the processes: it orders start-up (Postgres ready before
# anything connects), restarts what crashes, and stops everything before
# Postgres on shutdown. The service tree is docker/aio/rootfs/etc/s6-overlay/;
# every derived variable is in docker/aio/rootfs/usr/local/bin/automata-env.
#
# State lives under /data and nowhere else — mount a volume there. No VOLUME
# instruction and no BuildKit cache mount, for the Railway reasons given in
# apps/web/Dockerfile.
#
# Every image tag is pinned. Do not relax one to `latest`. Bumping Evolution
# here is the same re-verification CLAUDE.md lists for docker-compose.yml.


# ── web: mirrors the deps and build stages of apps/web/Dockerfile ───────────
FROM node:22.23.2-alpine AS web-base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

FROM web-base AS web-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/
RUN pnpm install --frozen-lockfile --filter web...

FROM web-base AS web-build
COPY --from=web-deps /app/node_modules ./node_modules
COPY --from=web-deps /app/apps/web/node_modules ./apps/web/node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web ./apps/web
RUN cd apps/web && pnpm exec nuxt build


# ── bridge: mirrors the deps stage of apps/telegram-bridge/Dockerfile ───────
FROM web-base AS bridge-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/telegram-bridge/package.json ./apps/telegram-bridge/
RUN pnpm install --frozen-lockfile --prod --filter telegram-bridge...


# ── runtime ─────────────────────────────────────────────────────────────────
# Evolution's own image is the base, so Evolution runs exactly as shipped — its
# Node 24, Prisma engines and boot script. The web app and the bridge keep the
# Node 22 the published images run, as a second binary in /opt/node22.
FROM node:22.23.2-alpine AS node22
FROM redis:8.2.9-alpine AS redis

FROM evoapicloud/evolution-api:v2.3.7 AS runtime

ARG S6_OVERLAY_VERSION=3.2.3.2
ARG S6_OVERLAY_NOARCH_SHA256=5379750ed30a84bbd2e2dd74847ba6b5bd29cd0b2e3ea2ec58049b57eb2eda12
# linux/amd64 only, like the other published images.
ARG S6_OVERLAY_X86_64_SHA256=e6befcc96a437a3831386ecfc51808c5d3e939dc5fe3c02ae9284599e8aa2408

RUN apk add --no-cache postgresql16 postgresql16-client postgresql16-contrib xz \
 && cd /tmp \
 && wget -q https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz \
 && wget -q https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-x86_64.tar.xz \
 && echo "${S6_OVERLAY_NOARCH_SHA256}  s6-overlay-noarch.tar.xz" | sha256sum -c - \
 && echo "${S6_OVERLAY_X86_64_SHA256}  s6-overlay-x86_64.tar.xz" | sha256sum -c - \
 && tar -C / -Jxpf s6-overlay-noarch.tar.xz \
 && tar -C / -Jxpf s6-overlay-x86_64.tar.xz \
 && rm s6-overlay-*.tar.xz

COPY --from=node22 /usr/local/bin/node /opt/node22/bin/node
COPY --from=redis /usr/local/bin/redis-server /usr/local/bin/redis-cli /usr/local/bin/

# Evolution writes paired sessions under its working directory; point both
# directories into the volume. Deleting them forces a QR re-scan of every number.
RUN ln -s /data/evolution/instances /evolution/instances \
 && ln -s /data/evolution/store /evolution/store

COPY --from=web-build /app/apps/web/.output /app/web/.output
# The workspace layout is kept: pnpm's node_modules links are relative to it.
COPY --from=bridge-deps /app/node_modules /app/bridge/node_modules
COPY --from=bridge-deps /app/apps/telegram-bridge/node_modules /app/bridge/apps/telegram-bridge/node_modules
COPY apps/telegram-bridge/package.json /app/bridge/apps/telegram-bridge/
COPY apps/telegram-bridge/src /app/bridge/apps/telegram-bridge/src

COPY docker/aio/rootfs/ /

# Fails the build, not the first boot, if a copied binary cannot run here.
RUN /opt/node22/bin/node --version \
 && redis-server --version \
 && postgres --version \
 && pg_isready --version

# Fails the build, not the first request, if the web app's native sharp binary
# (libvips, musl) did not reach the Nitro output or cannot load under the Node 22
# copied above, or if `unpdf` is not where the PDF worker will look for it. Same
# check as apps/web/Dockerfile (change one, change both).
RUN cd /app/web/.output/server \
 && /opt/node22/bin/node --input-type=module -e '\
    import sharp from "sharp"; \
    import { createRequire } from "node:module"; \
    import { existsSync, readFileSync } from "node:fs"; \
    import { join } from "node:path"; \
    import { pathToFileURL } from "node:url"; \
    const jpeg = await sharp({ create: { width: 1, height: 1, channels: 3, background: "#fff" } }).jpeg().toBuffer(); \
    if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error("sharp did not encode a JPEG"); \
    console.log("sharp", sharp.versions.sharp, "libvips", sharp.versions.vips, "-> jpeg", jpeg.length, "bytes"); \
    const here = process.cwd(); \
    const dir = (createRequire(pathToFileURL(join(here, "chunks", "_", "x.mjs"))).resolve.paths("unpdf") ?? []).map(p => join(p, "unpdf")).find(d => d.startsWith(here + "/") && existsSync(join(d, "package.json"))); \
    if (!dir) throw new Error("unpdf is not under " + here + "/node_modules"); \
    const entry = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).module; \
    const { getDocumentProxy } = await import(pathToFileURL(join(dir, entry)).href); \
    if (typeof getDocumentProxy !== "function") throw new Error("unpdf has no getDocumentProxy"); \
    console.log("unpdf", dir.slice(here.length + 1), "->", entry)'

# NITRO_PORT is deliberately not set, as in apps/web/Dockerfile: the web app
# follows PORT, else 3000. The base image sets TZ=America/Sao_Paulo.
ENV NODE_ENV=production NITRO_HOST=:: TZ=UTC
# A failed start-up step (PORT clashing with an internal port, Postgres that
# never comes up, a failed Evolution migration) stops the container rather than
# leaving it half up.
ENV S6_BEHAVIOUR_IF_STAGE2_FAILS=2
# Evolution's migrations alone outlast s6's 5-second default.
ENV S6_CMD_WAIT_FOR_SERVICES_MAXTIME=0
# Time each service gets to stop before SIGKILL. Run with
# `docker run --stop-timeout 30` so Docker waits that long too.
ENV S6_SERVICES_GRACETIME=20000 S6_KILL_GRACETIME=5000

EXPOSE 3000
ENTRYPOINT ["/init"]
CMD []
