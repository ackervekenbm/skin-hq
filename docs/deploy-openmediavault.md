# Deploying SkinHQ on OpenMediaVault (Compose plugin UI)

SkinHQ runs as a single container published to GHCR. This guide gets it
running on an OpenMediaVault host using the **Compose plugin's web UI** — no
SSH needed. The image is **public**, so no GHCR login is required.

- Port `3000` inside the container (the server's own port) is exposed on the
  host as `8090`, so you open `http://<omv-ip>:8090`.
- Data (the SQLite price/inventory cache + the encrypted Steam session) lives
  in a folder on your shared storage, so redeploys and updates keep your
  session and sync data, and you can back it up like any other file.

## 1. Prerequisites

- OMV with the **Compose plugin** installed (System → Plugins →
  `openmediavault-compose`). This gives you Services → Compose.
- A shared folder for the app data (created under Storage → Shared Folders).

## 2. One-time plugin settings

Services → **Compose** → **Settings**:

- **Compose Files** — the folder where the plugin stores each project's
  `.yaml`/`.env` files. Pick a shared folder (default ownership/permissions
  are fine).
- **Data** — a shared folder acting as the *global data path*. The plugin
  substitutes it wherever the placeholder `CHANGE_TO_COMPOSE_DATA_PATH`
  appears in a compose file. Point it at your app-data folder.
- **Backup** (optional) — a destination folder for the plugin's scheduled
  backups of compose files and relative-path volumes.

The colon-vs-dash reminder on path syntax: in `volumes` a path like
`CHANGE_TO_COMPOSE_DATA_PATH/skin-hq:/app/data` means *host folder on the
left, container folder on the right*. The container side (`/app/data`) is
fixed — that's where the app writes its database.

## 3. Create the project

Services → **Compose** → **Files** → **+** (Add), name it `skin-hq` and paste
this into the **File** field:

```yaml
services:
  skin-hq:
    image: ghcr.io/ackervekenbm/skin-hq:latest
    container_name: skin-hq
    ports:
      - "8090:3000"
    environment:
      SKINHQ_SESSION_KEY: ${SKINHQ_SESSION_KEY:?set SKINHQ_SESSION_KEY in the Environment field}
      CSFLOAT_API_KEY: ${CSFLOAT_API_KEY:-}
      # Auto-sync cadence in minutes; 0 disables (manual "Sync now" only).
      SYNC_INTERVAL_MIN: ${SYNC_INTERVAL_MIN:-60}
    volumes:
      - CHANGE_TO_COMPOSE_DATA_PATH/skin-hq:/app/data
    restart: unless-stopped
```

Then put the values in the **Environment** field (the plugin's per-project
`.env`):

```
SKINHQ_SESSION_KEY=<64 hex chars — see below>
CSFLOAT_API_KEY=
SYNC_INTERVAL_MIN=60
```

- `SKINHQ_SESSION_KEY` is **required**; the container refuses to start
  without it. Generate 32 random bytes as hex (64 characters), e.g. from any
  box with node or openssl: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
  or `openssl rand -hex 32`.
- `CSFLOAT_API_KEY` is optional — no CSFloat price column without it.
- `SYNC_INTERVAL_MIN` is optional (default `60`): auto-syncs inventory,
  listings and stale prices every N minutes; `0` disables auto-sync.

> Losing `SKINHQ_SESSION_KEY` means the stored Steam session can't be
> decrypted — you just sign in again, no other data loss.

## 4. Pull and start

In the project's **Executor** view: **Pull** (fetches
`ghcr.io/ackervekenbm/skin-hq:latest`), then **Up**. The container starts
with `restart: unless-stopped`, so it survives OMV/reboots. Wait for the
status to turn healthy (the image self-checks `/api/health`).

## 5. Sign in

Open <http://<omv-ip>:8090> and sign in with your Steam account name,
password, and a Steam Guard code from the Steam Mobile app. The app is
**semi-auto**: listing actions are confirmed on your phone.

## 6. Updating

`latest` follows the repo's `main`, so updates are: **Pull** → **Up** again.
Your data stays in the Data shared folder untouched.

## 7. Troubleshooting

- **Port 8090 already in use** — change the left side of `"8090:3000"`.
- **Container won't start / exits** — most often a missing or empty
  `SKINHQ_SESSION_KEY` (check the plugin's log output).
- **"Steam session expired — sign in again"** — Steam sessions are cookie-
  based and eventually drop (often silently). The app detects this on its
  own, hides the inventory, and you just sign back in; the grid stays hidden
  (no stale data) until you do.
- **Steam says 429/rate-limited** — the sync engine backs off on its own;
  a throttled-but-valid session is *not* logged out. Give it a few minutes
  and hit "Sync now" again.
- **Nothing listens on port 8090** — check the container is Up (not exited)
  and that your OMV firewall/host doesn't filter the port.

## 8. Reset everything

In the project's Executor view: **Down** (the container stops; data in
`/app/data` is kept). To also wipe the data (re-login + fresh price cache),
delete the `skin-hq` folder inside your Data shared folder.

## Alternatives

- **Portainer / plain Docker CLI** — the same compose file works; the
  `CHANGE_TO_COMPOSE_DATA_PATH` placeholder must be replaced with your shared
  folder's physical path (e.g. `/srv/dev-disk-by-uuid-…/skin-hq`), since the
  substitution is an OMV Compose-plugin feature.