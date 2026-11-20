# Operations

Part of the [deployment guides](README.md).

## Settings

All settings are environment variables. All are optional except the session
key; leaving one out, or empty, keeps the default.

| Variable | Default | What it does |
|---|---|---|
| `SKINHQ_SESSION_KEY` | (required) | Encrypts the stored Steam session cookies. Any long random string; `openssl rand -hex 32` is the norm. Changing it means signing in to Steam again |
| `CSFLOAT_API_KEY` | none | CSFloat key (<https://csfloat.com/api>). Fills the CSFloat price column; without it that column stays empty |
| `SKINHQ_ALLOWED_HOSTS` | none | Host names SkinHQ answers to besides `localhost` and IP addresses, comma-separated, e.g. `skin-hq.example.home,nas.local`. Needed for any name you open it through (a reverse proxy, a `.local` name); others get `421` |
| `SYNC_INTERVAL_MIN` | `60` | Minutes between automatic syncs of inventory, listings and prices. `0` turns them off: only **Sync now** syncs |
| `SYNC_PRICE_FRESH_MS` | `21600000` (6 h) | A price younger than this isn't fetched again, which keeps frequent syncs cheap and under Steam's limits |
| `SYNC_PRICE_DELAY_MS` | `1000` | Pause between two price requests to Steam |
| `SYNC_PRICE_429_ABORT` | `3` | The price phase stops after this many "too many requests" answers from Steam, and picks up on the next sync |
| `SKINHQ_PROBE_TTL_MS` | `600000` (10 min) | How often an idle app checks whether Steam still accepts the session |
| `SKINHQ_DECLINE_GRACE_MS` | `90000` (90 s) | How long a sell waits for your phone confirmation before the app asks Steam whether it went through |
| `SKINHQ_PENDING_TTL_MS` | `1800000` (30 min) | After this, a sell that was never confirmed or declined stops blocking the item |
| `SKINHQ_RELIST_GAP_MS` | `1500` | Pause between cancelling the old listing and placing the new one when you relist |
| `FX_EUR_USD` | `1.1` | How many USD one EUR buys, used to compare Steam's euro prices with CSFloat's dollar prices |
| `HOST` | `127.0.0.1` (`0.0.0.0` in the image) | Address the server listens on |
| `PORT` | `3000` | Port the server listens on. Leave it alone in Docker: the healthcheck probes `3000` |
| `DATA_DIR` | `./data` (`/app/data` in the image) | Folder holding `skin-hq.db` |

In Docker, compose only passes a variable into the container when the
compose file names it under `environment:`; a line in `.env` alone isn't
enough.

## Which build is running?

**Settings → About** in the app shows the commit and build time, with a link
to the commit. A build made without the commit (a plain `npm run build`, or
`docker build` without the build args) says "development build".

## What lives where

| What | Where |
| --- | --- |
| Encrypted Steam session, inventory, prices (the newest, plus one per day for 90 days), your listings | `skin-hq.db` in the data folder (`skin-hq.db-wal` and `-shm` next to it) |
| Session key | Only in your environment (`.env`, OMV's Environment box, `/etc/skin-hq.env`) |
| Steam password | Nowhere: it is sent to Steam once at sign-in and never stored |

## Health

`GET /api/health` answers `200 {"ok":true,...}` while the server runs. The
image's healthcheck calls it every 30 s, so `docker ps` shows `healthy`. It
doesn't check Steam: whether the session still works shows in the app.

## Backups

`skin-hq.db` is the only state, and the database runs in WAL mode. Stop the
app, copy the data folder (all `skin-hq.db*` files together), start it again.
Never copy it while the app runs: you can catch a half-written WAL file. On
OMV, a **Services → Compose → Schedule** job with *Backup* enabled does this
for you.

Keep the session key separately, in a password manager. Without it the
restored session can't be decrypted; you sign in again and nothing else is
lost. The cache rebuilds on the next sync anyway, so even a lost data folder
only costs a sign-in and one slow sync.

To restore: stop the app, put the files back in the data folder, start it.
In Docker the container hands restored files to its user by itself.

## Updating

| Route | Update |
| --- | --- |
| Prebuilt image | `docker compose pull && docker compose up -d` |
| OpenMediaVault | Select the stack → **Pull** → **Up** |
| Docker from a checkout | `git pull`, rebuild, `docker compose up -d` ([details](from-source-docker.md#updating)) |
| Bare Node | `git pull && npm ci && npm run build`, restart ([details](from-source-node.md#updating)) |

The data folder and your Steam session are untouched by an update. Reload the
page in the browser to get the new UI.

## Rollback

Images: replace `:latest` with an older commit tag
([tags](docker-image.md#pin-a-version-roll-back)) and start again. Bare Node:
`git checkout <commit>`, build, restart. The database stays; the app adds new
columns when it needs them, so take a backup before rolling back across a
long stretch of changes.

## Logs

- Docker: `docker compose logs -f skin-hq`
- OMV: **Services → Compose → Services** → the container → **Logs**
- Bare Node: `journalctl -u skin-hq -f`

The compose examples cap the container log at 30 MB (`logging:`); without
that, it grows until the disk is full.
