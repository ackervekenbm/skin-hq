# SkinHQ

A local, single-user **CS2 listing workspace**. Pull your Steam inventory,
see what your skins are really worth (Steam Market floor + order book vs.
cash-out marketplaces like CSFloat/Buff/Skinport), and manage your Steam
Market listings from one screen.

**Semi-auto confirmations**: the app prepares listing changes, but you confirm
them on your phone in the Steam Mobile app — no automated 2FA, no maFile.

## Features

- **Inventory view** — every CS2 item with name, icon, wear/float, trade and
  market status.
- **Price comparison** — per item: Steam lowest + volume, buy-order depth,
  and third-party listings (net after fees) on the pluggable provider.
- **Listing manager** — your active Steam Market listings; sell/cancel with
  a "awaiting your confirmation in Steam Mobile" flow.
- **SQLite cache** — everything synced by paced background jobs; the UI
  never blocks on live Steam calls. Prices are kept for 90 days (one per day,
  plus the newest), so the file stays small.
- **About** — Settings shows which build is running (commit and build time)
  with links to the source, the issue tracker, the author and the license.

## Requirements

- Node.js **22+** for development/build
- A Steam account with CS2 items and **Steam Mobile** installed (for
  confirmations)
- Docker (optional, for containerized hosting)

## Quick start (development)

```bash
npm install
npm run dev
```

Open <http://localhost:5173>. Enter your Steam account name, password and a
current Steam Guard code from the Steam Mobile app on the first screen. The
session is stored encrypted in `data/skin-hq.db` so you don't re-login every
time.

> Credentials go **only** to `steamcommunity.com` (via the `steamcommunity`
> library). Nothing is logged and nothing is sent anywhere else. The
> password is never persisted — only the resulting session cookies, encrypted
> with a key you supply via `SKINHQ_SESSION_KEY`.

## Deployment

SkinHQ is **one Node process**: it serves the app, the API and the background
sync, and runs anywhere Docker or Node 22+ does, on a 64-bit OS.

| Route | Good for |
| --- | --- |
| [Prebuilt Docker image](docs/deploy/docker-image.md) | Anything with Docker: `amd64`/`arm64`, no build, easy updates and rollback |
| [OpenMediaVault](docs/deploy/openmediavault.md) | The OMV Compose plugin, all from the web UI |
| [Docker, built from a checkout](docs/deploy/from-source-docker.md) | Running a version you changed yourself |
| [Bare Node](docs/deploy/from-source-node.md) | A host that already runs Node 22+ (systemd) |

Settings, HTTPS, backups, updates, rollback and troubleshooting are all in
**[docs/deploy/](docs/deploy/README.md)**. Three rules apply to every route:

- **Keep it on your LAN or tailnet.** SkinHQ has no login and holds your
  signed-in Steam session, so anyone who can open it can sell your items
  ([why](docs/deploy/README.md#keep-it-on-your-lan-or-tailnet)).
- **Keep `SKINHQ_SESSION_KEY`** (make one with `openssl rand -hex 32`). It
  encrypts the stored Steam session; lose it and you sign in again.
- **Keep the data folder** (`/app/data` in the image). It holds the session
  and the cache; updates keep it as long as the new container uses the same
  folder or volume.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Vite dev server (5173) + API watch (3000), proxied together |
| `npm run build` | Type-check, lint, production build (client `dist/` + server `dist-server/`) |
| `npm run start` | Run the built server (serves `dist/` + `/api`) |
| `npm run lint` / `lint:fix` | ESLint (flat config; js + typescript-eslint + react-hooks + react-refresh + node globals for server) |

## Project structure

```
├── Dockerfile / docker-compose.yml / .env.example   # containerized hosting
├── .github/
│   ├── workflows/ci.yml           # PR checks (type-check + lint + build)
│   └── dependabot.yml             # weekly dependency-update PRs
├── eslint.config.js / tsconfig.json / tsconfig.server.json / vite.config.ts
├── index.html                     # app shell
├── docs/plan.md                   # living plan — updated as the app evolves
├── docs/deploy/                   # deployment guides, one per route (image, OMV, source, Node) + HTTPS, operations, troubleshooting
└── src/
    ├── server/                    # Express + SQLite + Steam session + price providers
    │   ├── index.ts               # bootstrap + routes
    │   ├── db.ts                  # better-sqlite3 init
    │   ├── steam.ts               # steamcommunity session + raw market calls
    │   ├── price.ts               # pluggable price providers
    │   └── crypto.ts              # AES-256-GCM session-cookie encryption
    ├── client/                    # React UI (spike harness → Phase 1 grid)
    ├── types/steamcommunity.d.ts  # ambient types for steamcommunity
    └── vite-env.d.ts              # build-info constants
```

## How it works

1. **Login** — you enter Steam account + password + Steam Guard code. The
   app logs into steamcommunity.com and stores the session cookies
   (encrypted) in SQLite.
2. **Sync** — inventory is fetched via `getUserInventoryContents(730, 2)`;
   prices are gathered through paced background requests to Steam Market
   endpoints and the pluggable third-party provider.
3. **Sell** — pick an item and a price; the app posts the sell listing to
   Steam and shows "awaiting confirmation in Steam Mobile". Once you confirm
   there, the app's polling sees the live listing.

## Privacy notes

- Credentials are sent only to Steam; the password is never stored.
- Session cookies are encrypted at rest with your `SKINHQ_SESSION_KEY`; the
  key lives in your `.env` only, never in the repo.
- The dev server binds to `127.0.0.1`; the Docker container exposes `8090`
  on your local host by default.
- The app only answers to `localhost`, IP addresses and the host names you
  list in `SKINHQ_ALLOWED_HOSTS`, so a hostile website can't reach it by
  pointing its own name at your server (DNS rebinding).

## Future ideas

- Watchlist alerts ("floor dropped below your ask")
- Bulk relist rules ("match floor minus X%")
- Price-history charts
- Sticker/float appraiser
- Cash-out marketplace comparison details (net after fees)

---

This README is part of the repo and is kept in sync as the app evolves —
when features, commands, or structure change, this file is updated to match.
The roadmap (what's planned vs. shipped) lives in `docs/plan.md`.