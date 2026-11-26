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

## Working docs stay out of the repo

Plans, specs, design mockups and screenshots are working documents: write them
locally (`docs/plan.md`, `docs/superpowers/` and `.superpowers/` are
git-ignored) or in the issue/PR, never commit them. What outlives the work goes
into the README, this file or `docs/deploy/`; planned work is tracked in issues.

## README upkeep (MANDATORY)

`README.md` is the project's public front page, so it has to match the app.
Before opening a PR, check the README against your change and update it in
the **same PR** when you add, remove or rename a feature, a control or a setting;
change a command, script, port, environment variable or image tag; or change
what is stored where. Keep its style: plain user-facing wording, no internal
jargon. If nothing in the README is affected, say so in the PR description.
AGENTS.md (architecture) and `docs/deploy/` (deployment guides)
follow the same rule.

## Issue-first workflow (MANDATORY)

Before starting any new work item, create a GitHub issue:

```bash
gh issue create --title "<what>" --body "..."   # → gives an issue number
```

- Name the branch `fix/...`, `feat/...` or `chore/...` (one per issue).
- Put `Fixes #<n>` on its own line in the PR body so the issue auto-closes on merge.
- One issue, one PR, branched off the latest `main`. Every PR targets `main`
  (`Fixes #<n>` only closes issues from there; CI runs on every PR, stacked
  ones included).
- Don't stack by default. Work that needs an unmerged PR goes into that PR, as
  its own commit with its own `Fixes #<n>` line, or waits until it has merged.
- When a stack is unavoidable, keep it small and say "merge #<n> first" in the
  PR body. A squash lands the lower PR as a new commit, so the next PR conflicts
  wherever it edits those lines again. Right after each merge, rebase the next
  branch with `git fetch && git rebase origin/main` (git skips the commit that
  already landed; add `--update-refs` from the top branch to move the whole
  stack), then `git push --force-with-lease`. If the merged PR had several
  commits, git can't match its squash: use
  `git rebase --onto origin/main <old tip of the merged branch>`.

## Git / PR conventions

- `main` is protected (ruleset `main-branch-protection`): **no direct pushes**,
  linear history, and every change lands via a pull request and a **squash
  merge** (the only merge method). Required checks: `check` (CI) and `smoke`
  (image), on a branch that is up to date with `main` (the PR's **Update
  branch** button, or a rebase). CodeQL scans every PR, and Dependabot security
  updates open their own PRs.
- After merging, GitHub auto-deletes the head branch (`delete-branch-on-merge` is on).
- Pattern: create branch → implement → update README/docs → `npm run build && npm test` → push → `gh pr create`
  → merge once the checks pass. Use `gh pr merge --squash` when asked to merge.
- **Never merge your own PR.** Ready PRs are handed over to a reviewer to merge;
  if the author merges, the other party reviews the squash only after the fact.
- Commit messages are imperative, single-paragraph (plus context lines), and
  reference the fix: `Fixes #<n>`.
- **Branch hygiene** — keep the workspace tidy:
  - Always branch off the latest `main` before starting new work.
  - After a PR lands (squash merged), GitHub auto-deletes the remote branch.
    Also delete the local branch afterwards:
    `git checkout main && git fetch --prune && git branch -D <branch>`.
  - Periodically prune stale local branches whose remotes are already gone:
    `git fetch --prune && git for-each-ref --format='%(refname:short) %(upstream:track)' refs/heads | grep gone`.
    Keep the workspace down to `main` plus active work branches.

## Architecture

- `src/server/index.ts` — Express bootstrap: serves `/api/*` and the built
  client from `dist/`. Binds `127.0.0.1:3000` in dev, `0.0.0.0:3000` in the
  container (`HOST` env).
- `src/server/db.ts` — better-sqlite3 in `data/skin-hq.db` (`DATA_DIR` env).
  Tables: `sessions` (encrypted Steam cookies), plus `items` /
  `price_snapshots` / `my_listings` / `pending_listings`. `price_snapshots`
  is pruned after each price phase (`prunePriceSnapshots`): the newest row and
  the newest successful row per item+provider, plus the last successful row of
  each day for 90 days. `latestPriceSnapshots` returns the newest successful
  row (the newest failed one only when none succeeded), so a 429 never hides a
  good price and failed items count as stale for the next sync.
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
- `src/server/selling.ts` — `sellAndTrack()` (sell + pending-sell bookkeeping,
  used by `/api/sell`) and `relist()` (`/api/relist`: check the listing is
  that asset, cancel, re-read inventory contexts, pause, sell from the
  asset's current context; a failed re-sell reports that the item is now
  unlisted).
- `src/server/guard.ts` — the API has no login, so every POST under `/api`
  must be JSON and must not carry a cross-site `Sec-Fetch-Site`; this keeps
  other websites in the same browser from selling, cancelling or logging out.
  Every request must also carry a known `Host` (`isAllowedHost`: localhost,
  IP literals, `SKINHQ_ALLOWED_HOSTS`), which closes DNS rebinding.
  Ids sent on to Steam are digits only (`isSteamId`).
- `src/server/orderbook.ts` — pure decoder for the order book that Steam's
  React SSR listing page embeds in its `renderContext` payload (the classic
  `Market_LoadOrderSpread` HTML globals and the `itemordershistogram`
  endpoint that needs `item_nameid` are both gone).
- `src/server/locks.ts` — pure: when a temporarily locked item becomes
  marketable (`unlockDate`, from the owner text's `[date]` token or
  steamcommunity's `cache_expiration`), stored as `unlocks_at` in the item's
  raw JSON. `buildGrid` shows sellable, listed, pending and locked items
  (locked only under the Locked filter) and drops items that can never be sold
  from the grid and the counts.
- `src/server/floats.ts` — pure offline decoder for own-item floats: Steam's
  CS2 inventory JSON exposes per-asset `asset_properties` whose `propertyid 6`
  ("Item Certificate") is the self-encoded inspect-link hex; it decodes it
  with `@csfloat/cs2-inspect-serializer` into exact float/paint-seed/
  stickers/keychains. `steam.ts` attaches these in `getInventory()` (best-
  effort, contexts 2 + 16) and stores them on `items.own_float/*`.
- `public/` — favicon, apple-touch-icon, manifest icons and
  `manifest.webmanifest` (no service worker). The PNGs are rendered by
  `scripts/gen-icons.mjs` (`npm run icons`, dev dependency `sharp`, which
  loads its prebuilt `@img/*` binary without an install script) and committed.
- `src/client/` — React UI. The Phase 0 spike harness (login, inventory,
  prices, sell/cancel) doubles as the seed of the Phase 1 inventory grid.
  Settings ends with an **About** section built from constants Vite defines
  (`vite.config.ts`, declared in `src/vite-env.d.ts`): `__BUILD_SHA__`,
  `__BUILD_TIME__`, `__REPO__` from the image build's `COMMIT_SHA` /
  `BUILD_TIME` / `GITHUB_REPOSITORY` args ("development build" without them)
  and `__LICENSE__` from `package.json`'s `license` ("not chosen yet" while empty).
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

- Every `updates:` entry in `.github/dependabot.yml` assigns its PRs to
  `ackervekenbm` (`assignees`), so each Dependabot PR notifies the maintainer.
  Keep it on any entry you add.
- Dependabot majors stay **enabled** — do not add `ignore` rules without the
  maintainer asking. One exception: the Docker base image is pinned by digest
  and Dependabot keeps it patched, but Node majors are a deliberate move, so
  they are ignored there.
- Second exception (issue #62): the `typescript` **major** is ignored in the
  npm group because TypeScript 7 (the native-compiler line) is outside
  typescript-eslint's `peer typescript <6.1.0` and would make the weekly group
  uninstallable. Patch/minor updates on the 6.0 line still land. Lift the
  ignore (and plan a deliberate TS7 migration) once typescript-eslint supports it.

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
`ghcr.io/ackervekenbm/skin-hq:latest` / `:<sha7>`. The deployment guide is
`docs/deploy/README.md`, one guide per route plus HTTPS, operations and troubleshooting.
