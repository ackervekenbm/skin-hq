# SkinHQ — Deployment

SkinHQ is one container: the web UI, the API and the background sync in a
single Node process, with its state in one SQLite file. CI publishes it as
`ghcr.io/ackervekenbm/skin-hq:latest` for `amd64` and `arm64`. The image is
public, so pulling it needs no login.

What every route shares:

- **Any always-on 64-bit Docker host.** The sync runs in the background, so
  the host must stay on. The reference deployment is **OpenMediaVault** with
  its Compose plugin; [plain Docker Compose](#plain-docker-compose) works the
  same.
- **One secret you make yourself**: `SKINHQ_SESSION_KEY`, the key that
  encrypts your stored Steam session. Generate it once:
  `openssl rand -hex 32` (or
  `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).
  The container refuses to start without it.
- **Container port `3000`**, data in **`/app/data`**. Only the host side of
  both is yours to choose.
- **No login in the app, and it holds a signed-in Steam session.** Anyone who
  can open it can list and cancel your items. Keep it on your LAN or tailnet;
  never forward a port to it from the internet.

## OpenMediaVault (Compose plugin)

Prerequisites: omv-extras with the **`openmediavault-compose`** plugin, and
the plugin's *Compose Files* and *Data* shared folders set in **Services →
Compose → Settings**.

1. **Services → Compose → Files → Create** (`+`).
2. **Name**: `skin-hq` (a stack name, not a filename).
3. **File**: paste

   ```yaml
   services:
     skin-hq:
       image: ghcr.io/ackervekenbm/skin-hq:latest
       ports:
         - "8090:3000"
       environment:
         SKINHQ_SESSION_KEY: ${SKINHQ_SESSION_KEY:?set SKINHQ_SESSION_KEY in Environment}
         # Optional: blank uses the app's default (table below).
         CSFLOAT_API_KEY: ${CSFLOAT_API_KEY:-}
         SYNC_INTERVAL_MIN: ${SYNC_INTERVAL_MIN:-}
       volumes:
         - CHANGE_TO_COMPOSE_DATA_PATH/skin-hq:/app/data
       logging:
         driver: json-file
         options:
           max-size: "10m"
           max-file: "3"
       restart: unless-stopped
   ```

4. **Environment**: the key, one per line, no quotes. Add an optional setting
   from the [table](#settings) only to change it.

   ```bash
   SKINHQ_SESSION_KEY=...
   CSFLOAT_API_KEY=...
   ```

5. **Save**, select the entry, **Up**. Open `http://<server-ip>:8090` and sign
   in with your Steam account name, password and a Steam Guard code from the
   Steam Mobile app.

Verify: **Services → Compose → Services** shows the container running (and
healthy after half a minute), and `http://<server-ip>:8090/api/health`
returns `{"ok":true,...}`.

What the file does:

- **`CHANGE_TO_COMPOSE_DATA_PATH/skin-hq`**: the plugin fills in the *Data*
  shared folder's path, so `<Data folder>/skin-hq/skin-hq.db` is the whole
  server-side state: an ordinary folder you can browse, copy and back up,
  which **Prune → Volume** can't delete.
- **Ownership is automatic.** The app runs as the unprivileged user uid 1000.
  Each time the container starts it gives the `skin-hq` folder and the files
  in it to that user, also a folder an older image or a restore left owned by
  root. Nothing to set up and no SSH needed. The folder must sit on a Linux
  filesystem (ext4, btrfs, xfs, what OMV formats with): NTFS, exFAT and FAT
  can't store an owner, and the app then can't open its database.
- **Port `8090`**: any free host port works; change the left-hand number only.
  Behind a [reverse proxy](#https--reverse-proxy) on the same Docker network
  you can drop `ports:` altogether.
- **No `container_name`**: compose names it `skin-hq-skin-hq-1`.
- **`logging`**: caps the container log at 30 MB, so it can't fill the disk.
- **The settings are listed, not commented out.** Compose only passes a value
  from the Environment box into the container when the file names it. To use
  one of the advanced settings, add its line under `environment:` the same way.

## Plain Docker Compose

The repo's [`docker-compose.yml`](../docker-compose.yml) is the same stack with
a named volume (`skin-hq-data`) instead of the OMV folder. The host doesn't
need the repo: copy that file, and next to it a `.env` with the key (copy
[`.env.example`](../.env.example)), then:

```bash
docker compose up -d
curl http://localhost:8090/api/health     # {"ok":true,...}
```

## Settings

All optional except the session key. Leaving a setting out, or empty, keeps
the default.

| Variable | Default | What it does |
|---|---|---|
| `SKINHQ_SESSION_KEY` | (required) | Encrypts the stored Steam session cookies. Any long random string; 64 hex characters from the command above is the norm |
| `CSFLOAT_API_KEY` | none | CSFloat key (<https://csfloat.com/api>). Fills the CSFloat price column; without it that column stays empty |
| `SYNC_INTERVAL_MIN` | `60` | Minutes between automatic syncs of inventory, listings and prices. `0` turns them off: only **Sync now** syncs |
| `SYNC_PRICE_FRESH_MS` | `21600000` (6 h) | A price younger than this isn't fetched again, which keeps frequent syncs cheap and under Steam's limits |
| `SYNC_PRICE_DELAY_MS` | `1000` | Pause between two price requests to Steam |
| `SYNC_PRICE_429_ABORT` | `3` | The price phase stops after this many "too many requests" answers from Steam, and picks up on the next sync |
| `SKINHQ_PROBE_TTL_MS` | `600000` (10 min) | How often an idle app checks whether Steam still accepts the session |
| `SKINHQ_DECLINE_GRACE_MS` | `90000` (90 s) | How long a sell waits for your phone confirmation before the app asks Steam whether it went through |
| `SKINHQ_PENDING_TTL_MS` | `1800000` (30 min) | After this, a sell that was never confirmed or declined stops blocking the item |
| `FX_EUR_USD` | `1.1` | How many USD one EUR buys, used to compare Steam's euro prices with CSFloat's dollar prices |

The image sets `HOST=0.0.0.0`, `PORT=3000` and `DATA_DIR=/app/data` itself;
leave those alone.

## Updating

OMV: select the stack → **Pull** → **Up**. Plain compose:
`docker compose pull && docker compose up -d`. An unchanged image is a no-op;
the data folder and your Steam session are untouched either way.

To pin a version instead of tracking `:latest`, use a commit tag,
`ghcr.io/ackervekenbm/skin-hq:<sha7>`: every image published from `main` is
also tagged with its 7-character commit SHA (listed on the repo's *Packages*
page). Editing that line and pressing **Up** is also how you roll back.
**Settings → About** in the app shows which commit is running.

## Backups

`skin-hq.db` in the data folder is the only state: the encrypted Steam
session and the inventory, price and listings cache. The database runs in WAL
mode, so `skin-hq.db-wal` and `-shm` sit next to it. Stop the container, copy
the folder, start it again; on OMV, a **Services → Compose → Schedule** job
with *Backup* enabled does exactly that. Never copy the folder while the
container runs: you can catch a half-written WAL file.

Keep `SKINHQ_SESSION_KEY` with the backup (in a password manager, not next to
the file). Without it the restored session can't be decrypted; you just sign
in again, nothing else is lost. The cache rebuilds itself on the next sync
anyway, so a lost data folder only costs a sign-in and one slow sync.

## HTTPS / reverse proxy

Any reverse proxy works: point it at the container's port `3000` (e.g.
`reverse_proxy skin-hq:3000` in Caddy with both containers on one Docker
network). Give it its own host name: the UI calls `/api/...` from the root,
so it can't live under a sub-path. No headers or base-URL setting needed.

It still has no login, so keep the proxied name inside your LAN. The app does
refuse writes (sell, cancel, sign out) that come from another site open in
the same browser, so other apps behind the same proxy can't drive it.

## Troubleshooting

| Symptom | Fix |
|---|---|
| The stack refuses to start: `set SKINHQ_SESSION_KEY in Environment` | The key is missing from the Environment box / `.env` |
| The container restarts with `SqliteError: unable to open database file` | The data folder can't be handed to uid 1000: it is on NTFS/exFAT/FAT, or on a read-only mount. The log line starting with `skin-hq: could not give` says which folder. Move it to a Linux filesystem |
| "Steam session expired — sign in again" | Steam sessions are cookies and drop after a while, often silently. The app notices, hides the inventory and asks you to sign in again. Also expected after changing `SKINHQ_SESSION_KEY` |
| Steam answers 429 / prices stop filling in | Steam is rate-limiting. The sync backs off on its own and a throttled session is *not* signed out. Wait a few minutes, then **Sync now** |
| The CSFloat column is empty | `CSFLOAT_API_KEY` isn't set, or CSFloat rejected it |
| A sell stays "awaiting approval" | Confirm (or decline) it in the Steam Mobile app. The app checks with Steam after 90 s and gives up waiting after 30 min |
| The port is already in use | Change the left-hand side of `"8090:3000"` |
| Logs | OMV: **Services → Compose → Services** → the container → **Logs**. Plain: `docker compose logs skin-hq` |

## Reset

**Down** stops the container and keeps the data folder. To start over
(sign in again, empty cache), also delete the `skin-hq` folder in the Data
shared folder (plain compose: `docker compose down -v`).
