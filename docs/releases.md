# Releases

The three images built from this repo are published to GHCR when `main` is
merged into `prod`:

| Image | Built from | Used by |
|---|---|---|
| `ghcr.io/ju-li/automata-mcp-web` | `apps/web/Dockerfile` | `docker-compose.yml`, Railway |
| `ghcr.io/ju-li/automata-mcp-telegram-bridge` | `apps/telegram-bridge/Dockerfile` | `docker-compose.yml`, Railway |
| `ghcr.io/ju-li/automata-mcp-aio` | `docker/aio/Dockerfile` | [single container](self-hosting.md#single-container) |

The all-in-one image builds the web app and the bridge from the same commit as
the other two, on top of Evolution's pinned image, so one version names the same
code in all three.

The web image also builds and runs on arm64 when built on an arm64 host (the
native `sharp` binary is chosen when the image is built, so build on the
architecture it will run on). The all-in-one image cannot be built for arm64,
because it downloads an amd64 s6-overlay.

Each release is tagged `X.Y.Z`, `X.Y`, `X`, `latest` and `sha-<commit>`, for
`linux/amd64`. **Point a service or a template at the major tag (`:1`), not
`:latest`.** The web service migrates its schema at boot and migrations only go
forward, so a major release reaching a deployment on its next restart is not
something to opt into by accident.

The version lives in one place — `"version"` in the root `package.json` — and is
always three-part. To cut a release:

1. Bump `"version"` on `main`, through an ordinary PR.
2. Open a PR from `main` into `prod`. The `release-check` workflow refuses it
   unless the version is `X.Y.Z`, is not already released and is above the
   latest release, and it builds all three images to prove they still build.
3. Merge it with **Create a merge commit** — never squash, or `prod` stops being
   an ancestor of `main` and every later release PR shows old commits again.
   The `release` workflow then pushes all three images and only after that creates
   the `vX.Y.Z` git tag and the GitHub Release, so a tag always means its images
   exist.

One-time setup on GitHub, which no workflow can do for you:

- Create the `prod` branch from `main`, and protect it: require a pull request
  and the `release-check` jobs (`version`, `build`).
- After the first release, open each package under the repository's
  **Packages** and set its visibility to **Public**. GHCR creates packages
  private, and Railway — or anyone deploying a template or running the
  all-in-one image — cannot pull a private image without credentials.
  `automata-mcp-aio` appears only after the first release that includes it, and
  needs the same step then.
