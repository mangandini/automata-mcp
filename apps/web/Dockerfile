# Build context is the REPO ROOT, not apps/web — the lockfile and workspace
# manifest live there:
#
#   docker build -f apps/web/Dockerfile -t claude-whatsapp-mcp-web .
#
# On Railway, set this service's root directory to the repo root and its
# Dockerfile path to apps/web/Dockerfile.

FROM node:22.23.2-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app


# ── deps ─────────────────────────────────────────────────────────────────────
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/
# No BuildKit cache mount here on purpose. Railway rejects one unless its id is
# prefixed with that service's own id (`id=s/<service-id>-<target>`), which would
# hardcode a single Railway service into this Dockerfile and break every other
# build context.
#
# Little is lost: the layer above is keyed on the lockfile, so an unchanged
# lockfile skips this step entirely, and Railway's builders are ephemeral so a
# store cache would rarely survive between builds anyway.
RUN pnpm install --frozen-lockfile --filter web...


# ── build ────────────────────────────────────────────────────────────────────
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web ./apps/web
# `nuxt build` here, not `pnpm build` — the package script passes
# `--dotenv ../../.env`, which does not exist in the image. Runtime config comes
# from NUXT_* environment variables instead.
RUN cd apps/web && pnpm exec nuxt build


# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:22.23.2-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# NITRO_PORT is deliberately NOT set. Nitro resolves `NITRO_PORT || PORT`, so
# pinning it here would make the server ignore the port Railway assigns. Unset,
# it falls back to 3000 for local runs.
#
# Binding :: accepts both IPv6 and IPv4. Legacy Railway environments route the
# private network over IPv6 only, where 0.0.0.0 is unreachable.
ENV NITRO_HOST=::

# The Nitro output is self-contained; no node_modules needed.
COPY --from=build /app/apps/web/.output ./.output

# Fails the build, not the first request, if the native sharp binary (libvips,
# musl) did not make it into the Nitro output or cannot load here, or if `unpdf`
# is not where the PDF worker will look for it. Run from .output/server with the
# runtime's own node, resolving `unpdf` the way server/utils/media-pdf.ts does
# (up the node_modules chain from a module inside the bundle) and refusing a
# copy found anywhere but under .output/server: nothing lies above it in the
# image, so a copy only the workspace had would pass on a developer's machine.
RUN cd /app/.output/server \
 && node --input-type=module -e '\
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

USER node
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
