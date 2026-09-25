# Deploying SkinHQ on OpenMediaVault (Docker)

SkinHQ runs as a single container published to GHCR. This guide gets it
running on an OpenMediaVault host that has Docker available (the OMV Docker
plugin or Portainer). The image is **public**, so no GHCR login is needed.

The container runs the Express server (API + static client) on port `3000`
inside the container, exposed on the host as `8090`. Data (encrypted Steam
session + the SQLite price/inventory cache) lives in the `skin-hq-data`
named volume, so redeploys keep your session and sync data.

## 1. Prerequisites

- OMV host you can SSH into, or a Portainer instance pointed at it.
- `docker` + `docker compose` available on the host. On OMV with the docker
  plugin or a Debian install: `sudo apt install docker-compose-v2`.

## 2. Create the app directory and files

```bash
mkdir -p ~/skin-hq && cd ~/skin-hq
```

Generate a session-encryption key (any machine with node, `openssl`, or OMV
itself):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# or, if node isn't installed (OMV is Debian, so usually available):
openssl rand -hex 32
# → write this into SKINHQ_SESSION_KEY below
```

Create `.env` next to `docker-compose.yml`:

```bash
cat > .env <<EOF
SKINHQ_SESSION_KEY=<the hex from above>
CSFLOAT_API_KEY=<optional, csfloat.com/api key>
# SYNC_INTERVAL_MIN=<minutes between auto-syncs, 0 disables, default 60>
EOF
chmod 600 .env
```

> `SKINHQ_SESSION_KEY` encrypts the Steam session cookies at rest. If you
> lose it, the stored session can't be decrypted and you'll just sign in
> again (no data loss beyond that). `CSFLOAT_API_KEY` is optional — without
> it the CSFloat price column stays empty. `SYNC_INTERVAL_MIN` (optional,
> default `60`) schedules an automatic sync of inventory, listings, and
> stale prices every N minutes — set `0` to disable and rely on "Sync now"
> alone.

Copy the deploy compose file from the repo root:

```bash
# from the repo: /mnt/c/Dev/skin-hq/docker-compose.yml → ~/skin-hq/docker-compose.yml
# src (FTP/SFTP: /srv/dev-disk-by-id-*/... ) or:
curl -fsSL -o docker-compose.yml \
  https://raw.githubusercontent.com/ackervekenbm/skin-hq/main/docker-compose.yml
```

## 3. Start it

```bash
docker compose up -d
```

This pulls `ghcr.io/ackervekenbm/skin-hq:latest` and starts the container
(`restart: unless-stopped`, so it survives reboots/OMV service restarts).

Verify:

```bash
docker compose ps          # STATUS should be Up (healthy)
curl -fsS http://127.0.0.1:8090/api/health
# → {"ok":true,"version":"0.1.0"}
```

Open <http://<omv-ip>:8090> and sign in with your Steam account name,
password, and a Steam Guard code from the Steam Mobile app. The app is
**semi-auto**: listing actions are confirmed on your phone.

## 4. Keep it updated

`latest` follows `main` in the repo. To upgrade:

```bash
docker compose pull && docker compose up -d
```

For a pinned version instead of a rolling `latest`, use a release tag, e.g.
`image: ghcr.io/ackervekenbm/skin-hq:v0.1.0` in `docker-compose.yml`.

## 5. Troubleshooting

- **Port 8090 already in use** — change the left side of the `ports:` mapping:
  `"8091:3000"`.
- **`SKINHQ_SESSION_KEY` is required** — the `.env` must sit in the same
  directory as `docker-compose.yml`; the compose file fails fast with a clear
  message if it's missing or empty.
- **"Steam session expired — sign in again"** — Steam sessions are cookie-
  based and eventually drop (often silently). The app detects this on its
  own, hides the inventory, and you just sign back in; the grid stays hidden
  (no stale data) until you do.
- **Steam says 429/rate-limited** — the sync engine backs off on its own;
  a throttled-but-valid session is *not* logged out. Give it a few minutes
  and hit "Sync now" again.
- **Firewall** — if <http://omv-ip:8090> won't open from another machine,
  the host firewall is likely filtering the port. Ensure Docker's port
  forwarding is allowed, or access through OMV's WebUI/Portainer proxy.
- **Reset everything** (re-login + fresh price cache):
  `docker compose down -v` deletes the `skin-hq-data` volume. Use with care —
  this also forgets the stored Steam session.

## Alternatives

- **Portainer** — instead of the CLI, create a **Stack** with the contents
  of `docker-compose.yml` / `.env` (as env vars or a file) and deploy from
  the WebUI. Updating is "View → Stack → Update"/pull. Everything else in
  this guide still applies.