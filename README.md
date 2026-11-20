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
  never blocks on live Steam calls.
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

## Run it in Docker

CI publishes a public, secrets-free image for amd64 and arm64:
`ghcr.io/ackervekenbm/skin-hq`. The server doesn't need this repo: copy
`docker-compose.yml` and `.env.example` (as `.env`, with a key from
`openssl rand -hex 32` in `SKINHQ_SESSION_KEY`), then:

```bash
docker compose up -d          # pulls the image and runs it
```

Open <http://localhost:8090>. Your Steam session and the price cache live in
the Docker volume `skin-hq-data`, so updates
(`docker compose pull && docker compose up -d`) keep them. The app has no
login of its own: keep it on your home network.

The full guide, with OpenMediaVault, every setting, updating and rolling
back, backups, HTTPS and troubleshooting, is
[docs/deployment.md](docs/deployment.md).

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
├── docs/deployment.md             # running it on a server (OMV, compose, HTTPS)
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