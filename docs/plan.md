# SkinHQ — Living Plan

A local, single-user CS2 listing workspace. Node/TypeScript, single npm
package, React+Vite frontend on Express backend with better-sqlite3. Pulls
your CS2 inventory, overlays live Steam + third-party market data, and
manages Steam Market listings via a semi-auto workflow (you confirm on your
phone in the Steam Mobile app).

**Repo**: `ackervekenbm/skin-hq`
**Host**: `/mnt/c/Dev/skin-hq`

## Phase 0 — Spike & scaffold

Validate the risky endpoints end-to-end before investing in the full read
experience. Scaffold includes the full tooling baseline (CI, AGENTS.md,
Dockerfile) so later phases land in an already-proven container.

### Checklist

- [x] Scaffold: package.json, tsconfigs, eslint, vite, index.html, Dockerfile,
      docker-compose, .github/ci.yml, AGENTS.md, README.md, docs/plan.md
- [x] `npm install` — deps resolve, no peer errors
- [x] `npm run build` green (typecheck + lint + client + server)
- [x] Server boots in prod layout; `/api/health`, `/api/auth/status`,
      SPA fallback, `/api/items` (SQLite) verified via curl
- [x] Price overview: `/market/priceoverview/` (lowest + volume) — live
      verified: `AK-47 | Redline (Field-Tested)` → Steam lowest €37.00,
      volume 78
- [x] Order book: `getMarketItem()` auto-commodity detection wired; live
      verified alongside priceoverview (same €37.00 low)
- [PARTIAL] Steam login via `steamcommunity` — code path complete; requires
      live Steam credentials (user signs in at the browser). Pending: real
      Guard-code login → inventory → one sell round-trip with phone confirm
- [PARTIAL] Sell listing: `POST /market/sellitem/` — implemented, awaiting
      live credentials to observe `needs_mobile_confirmation`
- [PARTIAL] Cancel listing: `POST /market/removelisting/{id}` — implemented,
      awaiting live credentials
- [ ] Confirm in Steam Mobile; verify listing appears/disappears
- [x] Repo created + pushed: `https://github.com/ackervekenbm/skin-hq` (private)
- [ ] Docker build passes locally — **blocked**: Docker not installed on the
      dev machine (Sep 2026); Dockerfile mirrors vinyl-vault's proven
      pattern, CI will validate on GitHub runners

### Notes

- Branch protection on `main` requires **GitHub Pro** for private repos
  (`403 Upgrade to GitHub Pro or make this repository public`). Deferred:
  either upgrade to Pro or make the repo public. Until then, commits land
  directly on `main` — keep `npm run build` green before each one.

### Live spike findings (Sep 2026)

- `steamcommunity@3.50.3` (installed) — no `getCookies()`; session cookies
  come from the `login()` callback. Ambient types declared in
  `src/types/steamcommunity.d.ts` for exactly what we use.
- Server boot is slow (~5-8s on WSL) — steamcommunity's require chain. Not a
  problem, but don't assume the health probe responds within 2s in tests.
- **CSFloat public endpoint returns `HTTP 403` for bare client requests**
  (no User-Agent / origin). Graceful degradation worked as designed.
  Phase 1: use a browser-like UA, find the stable public search endpoint,
  or switch the third-party provider to a keyed/reliable source (cs2.sh /
  csmarketapi free tier). Provider interface already isolates this.
- Module-load ordering gotcha: schema is created at `db.ts` import time
  (not from `index.ts`), because `steam.ts` restores the session at load.

## Phase 1 — Read core

Inventory grid with price/float comparison across Steam and third-party
marketplaces. Background sync jobs with throttling.

- SQLite schema: `items`, `price_snapshots`, `my_listings`, `sessions`
- Background jobs: inventory sync (sequential with delay), Steam
  priceoverview + histogram, third-party prices (pluggable provider),
  CSFloat inspect for float/stickers
- React UI: inventory grid (wear, phase, stickers, Steam floor+volume,
  buy depth, third-party prices, listing status), compare view
  (Steam order book vs cash-out marketplaces, net after fees)

## Phase 2 — Listing management (semi-auto)

Semi-auto means: the app computes prices, cancels/re-lists via API, but
every sell action requires confirmation in your Steam Mobile app. No
maFile, no 2FA bypass, no Steam Guard automation.

- My-listings sync via `/market/mylistings/render/`
- Sell dialog: suggested price (floor, median, floor minus margin),
  Steam fee math (`/market/calculatesellprice/`), confirmation-pending state
- Bulk relist ("match floor minus X%") with paced, idempotent batches
- Watchlist alerts ("floor dropped below your ask")

## Phase 3 — Polish

- Price-history charts
- Tag/ignore items, CSV export
- Sticker/phase appraiser
- Docker quickstart in README

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| **Steam ToS § Automation** — listing automation is technically grey-area | Semi-auto: you confirm every sell on your phone; no auto-confirm code ever touches the account |
| **Rate limits** — Steam throttles ~200 req/5min on inventories and 10 req/30s on market endpoints | Background jobs with token-bucket pacing + exponential backoff; UI never blocks on live calls |
| **Endpoint drift** — Valve has changed market endpoints before | Spike validates endpoints in 2026 reality; market layer isolated so fixes are local |
| **Session expiry** — Steam cookie sessions don't last forever | Detect via `sessionExpired` event; prompt re-login; fallback login via the web UI |
| **CSFloat API changes** — third-party provider may shift auth/shape | Pluggable provider interface; graceful fallback to Steam-only data |
| **Docker not installed locally** — container builds unvalidated on dev machine | Structure matches vinyl-vault's proven pattern; CI will validate on GitHub runners |
| **better-sqlite3 on Alpine/musl** — native prebuilt may not match | Verified in Phase 0 spike; fallback: `node:22-slim` (debian) |

## Costs

| Item | Cost |
|---|---|
| Steam data (priceoverview, histogram, pricehistory) | Free (unofficial endpoints) |
| CSFloat inspect API | Free (rate-limited, unauthenticated) |
| Third-party price aggregator (cs2.sh, csmarketapi, steamapis) | $0 on free tiers to start |
| Docker | $0 (local compose) |
