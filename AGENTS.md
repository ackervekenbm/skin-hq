# SkinHQ

A local, single-user Counter-Strike 2 listing workspace. It pulls your CS2
inventory, shows Steam + third-party market prices and liquidity, and lets
you manage Steam Market listings via a **semi-auto** workflow — listing
actions are prepared by the app but confirmed by you on your phone in the
Steam Mobile app. No maFile, no 2FA/Steam Guard automation.

One npm package: Express + better-sqlite3 backend (`src/server/`), React +
Vite frontend (`src/client/`), shared types in `src/types/`.

## Build, lint, verify

```bash
npm install       # install deps (uses package-lock.json, commit it)
npm run build     # = typecheck && lint && vite build && tsup server  ← the verify step
npm test          # vitest unit tests (tests/, node env)
```

Installs are **script-free**: `.npmrc` sets `ignore-scripts=true`.
`better-sqlite3` (13.x) ships `prebuilds/<platform>.node` (glibc + musl, amd64 +
arm64), so nothing needs compiling, but npm would otherwise run its legacy
implicit `node-gyp rebuild` on every install, which wants python3/make/g++ and
discards the shipped binary. protobufjs's postinstall only prints a warning, so
skipping it is safe. The Dockerfile relies on this; a dependency that genuinely
needs an install script cannot be added without revisiting `.npmrc`.

**Verification for every change is `npm run build && npm test`** (`npm run
build` = typecheck && lint && vite build && tsup server). CI runs the `check`
job (`npm ci && npm run build && npm test`) on every PR, and a green `check`
is required to merge. Every PR also runs the **smoke** job
(`.github/workflows/docker-build.yml`): build the image, boot it, and check
that the app runs as `node`, takes over a root-owned data volume (without
following a planted symlink) and works with `--user 1000:1000`.

## Issue-first workflow (MANDATORY)

Before starting any new work item, create a GitHub issue:

```bash
gh issue create --title "<what>" --body "..."   # → gives an issue number
```

- Name the branch `fix/...`, `feat/...` or `chore/...` (one per issue).
- Put `Fixes #<n>` on its own line in the PR body so the issue auto-closes on merge.
- Stack branches only when fixes are directly related; otherwise branch off `main`.

## Git / PR conventions

- `main` is protected: **no direct pushes** — every change lands via a pull
  request and a **squash merge**. Required check: `check` (CI). Branch
  auto-delete on merge is expected.
- **The PR author never merges their own PR.** Open the PR, make sure the
  `check` status passes, then stop and let the maintainer review and merge.
- Pattern: create branch → implement → `npm run build && npm test` → push → `gh pr create`
  → wait for `check` to pass → leave for maintainer review.
- Commit messages are imperative, single-paragraph (plus context lines), and
  reference the fix: `Fixes #<n>`.
- **Branch hygiene** — keep the workspace tidy:
  - Always branch off the latest `main` before starting new work.
  - After a PR lands (squash merged), GitHub auto-deletes the remote branch.
    Also delete the local branch afterwards:
    `git checkout main && git fetch --prune && git branch -D <branch>`.
  - Periodically prune stale local branches whose remotes are already gone:
    `git branch -vv` (look for `[origin/...: gone]`) or
    `git fetch --prune && git for-each-ref --format='%(refname:short) %(upstream:track)' refs/heads | grep gone`. Keep the workspace down to `main` plus active work branches.

## Architecture

- `src/server/index.ts` — Express bootstrap: serves `/api/*` and the built
  client from `dist/`. Binds `127.0.0.1:3000` in dev, `0.0.0.0:3000` in the
  container (`HOST` env).
- `src/server/db.ts` — better-sqlite3 in `data/skin-hq.db` (`DATA_DIR` env).
  Tables: `sessions` (encrypted Steam cookies), plus `items` /
  `price_snapshots` / `my_listings` as Phase 1 lands.
- `src/server/steam.ts` — `steamcommunity` singleton. `login()` with a Steam
  Guard code entered in the UI; `setCookies()` to restore a stored session.
  Raw market POST/GETs (`sellitem`, `removelisting`, `mylistings`, price
  endpoints) go through the library's `httpRequestPost`/`httpRequestGet` so
  the cookie jar is always in play. Session cookies are stored encrypted
  (AES-256-GCM, key from `SKINHQ_SESSION_KEY` env).
- `src/server/price.ts` — pluggable price providers. Steam provider
  combines `priceoverview` with the SSR orderbook (`marketOrderSpread`);
  CSFloat provider is a best-effort raw fetch. Provider interface:
  `{ name, getItem(hash) }`.
- `src/server/orderbook.ts` — pure decoder for the order book that Steam's
  React SSR listing page embeds in its `renderContext` payload (the classic
  `Market_LoadOrderSpread` HTML globals and the `itemordershistogram`
  endpoint that needs `item_nameid` are both gone).
- `src/server/floats.ts` — pure offline decoder for own-item floats: Steam's
  CS2 inventory JSON exposes per-asset `asset_properties` whose `propertyid 6`
  ("Item Certificate") is the self-encoded inspect-link hex; it decodes it
  with `@csfloat/cs2-inspect-serializer` into exact float/paint-seed/
  stickers/keychains. `steam.ts` attaches these in `getInventory()` (best-
  effort, contexts 2 + 16) and stores them on `items.own_float/*`.
- `src/client/` — React UI. The Phase 0 spike harness (login, inventory,
  prices, sell/cancel) doubles as the seed of the Phase 1 inventory grid.
- `src/types/steamcommunity.d.ts` — ambient declarations for
  `steamcommunity@3.50.3` (ships no types). Declare only what we use.
- Vite dev proxies `/api` → `http://127.0.0.1:3000`; `npm run dev` runs the
  API (`tsx watch`) and the UI (`vite`) together.

## Platform caveats (important)

- Steam rate limits: inventories (sequential, delay between page fetches,
  exponential backoff on 429s) and market endpoints (pace raw POSTs; keep
  a delay between sell/cancel batches). UI never blocks on live calls —
  background jobs write snapshots to SQLite, UI reads the cache.
- `better-sqlite3` is a native module: must stay external in the tsup build
  and be installed in the runtime image. Its bundled musl prebuild serves
  `node:22-alpine`; a major that changes the native ABI or drops a musl
  prebuild is caught by the smoke job before merge.
- Steam sessions are cookie-based and do not survive forever; handle
  `sessionExpired` and surface a re-login prompt.

## Dependencies / Dependabot

- Dependabot majors stay **enabled** — do not add `ignore` rules without the
  maintainer asking. One exception: the Docker base image is pinned by digest
  and Dependabot keeps it patched, but Node majors are a deliberate move, so
  they are ignored there.

## Deployment (local)

```bash
cp .env.example .env   # set SKINHQ_SESSION_KEY
docker compose up --build
```

Open <http://localhost:8090>. The container runs the Express server
(`node:22-alpine`, pinned by digest, healthcheck against `/api/health`) with a
named volume for `/app/data` (SQLite + encrypted session). The process runs as
the image's unprivileged `node` user (uid 1000): `docker-entrypoint.sh` starts
as root only to hand `/app/data` to `node` (files a root-run image or a
restore left there) and then drops to it with `su-exec`.

On `main`, after the smoke job, the image is built natively per arch (amd64 +
arm64 runners, no QEMU) and combined into the multi-arch
`ghcr.io/ackervekenbm/skin-hq:latest` / `:<sha7>`. The OpenMediaVault guide is
`docs/deploy-openmediavault.md`.