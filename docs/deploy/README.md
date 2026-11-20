# Deploying SkinHQ

SkinHQ runs as **one Node process**: it serves the web app, the API, and the
background sync that pulls your inventory, listings and prices from Steam (and
CSFloat). Everything it keeps is in one SQLite file: your Steam session,
encrypted, and the inventory, price and listings cache.

## Which route?

New here? Start with the **prebuilt image**.

| Route | Guide | Good for | Needs |
| --- | --- | --- | --- |
| **Prebuilt image** | [docker-image.md](docker-image.md) | Anything with Docker: no build step, easy updates and rollback, `amd64` and `arm64` | Docker, 64-bit OS |
| **OpenMediaVault** | [openmediavault.md](openmediavault.md) | The OMV Compose plugin, all from the web UI (what the maintainer runs) | OMV with the Compose plugin, 64-bit OS |
| **Build from a checkout (Docker)** | [from-source-docker.md](from-source-docker.md) | A version you patch yourself, or a host that shouldn't pull an image | Docker, git, 64-bit OS |
| **Bare Node** | [from-source-node.md](from-source-node.md) | A box that already runs Node 22+, managed by systemd | Node 22+, git, 64-bit OS |

Whichever route you pick:

- [https.md](https.md): a host name and HTTPS with a reverse proxy.
- [operations.md](operations.md): settings, health checks, backups, updates,
  rollback, logs.
- [troubleshooting.md](troubleshooting.md): symptoms and fixes.

## Keep it on your LAN or tailnet

**SkinHQ has no login, and it holds a signed-in Steam session.** Anyone who can
open it can list and cancel your items. Run it on your home network or your
tailnet only: no port forwarding, no Tailscale Funnel, no VPS without a
firewall in front.

Docker publishes `-p 8090:3000` on **every** network interface, and its
firewall rules bypass ufw and firewalld. When a reverse proxy on the same host
is the only thing that should reach the app, publish it on loopback only:
`-p 127.0.0.1:8090:3000`. Bare Node listens on `127.0.0.1` by default.

The app does refuse writes (sell, cancel, sign out) sent by another website
open in the same browser, so a page elsewhere can't drive it. That doesn't
help against someone who opens SkinHQ itself.

## The contract every route shares

| Item | Value |
| --- | --- |
| Port | The app listens on `3000` (`PORT`). In Docker that is fixed; you choose the host side (the examples use `8090`) |
| Listen address | `HOST`: `127.0.0.1` for bare Node, `0.0.0.0` in the image |
| Data | `DATA_DIR` (default `./data`, `/app/data` in the image) holds `skin-hq.db`. The only state |
| Session key | `SKINHQ_SESSION_KEY`, **required** in production: it encrypts the stored Steam session. Make one with `openssl rand -hex 32` |
| Web app files | `dist/`, next to where the server is started |
| Health | `GET /api/health` → `200 {"ok":true,...}` |
| Prerequisites | Node **22+** (the image ships it) on a **64-bit** `x64`/`arm64` OS; nothing is compiled during install |

All settings are environment variables; the full list is in
[operations.md](operations.md#settings).

**64-bit only.** The image is published for `amd64` and `arm64` only, and the
SQLite library (`better-sqlite3`) ships no 32-bit ARM build. Check the OS, not
the CPU: `dpkg --print-architecture` must print `arm64` or `amd64`.

## Common mistakes

- **Losing the session key.** Without it the stored Steam session can't be
  decrypted. Nothing else is lost: you sign in again. Keep it in a password
  manager.
- **Serving it under a subpath.** The app assumes it lives at `/`, so
  `https://host/skin-hq/` loads the page but every `/api` call fails. Use a
  host name or a port.
- **Opening it to the internet.** See [above](#keep-it-on-your-lan-or-tailnet).

## Versions and tags

Images are built from every commit on `main` and published to
`ghcr.io/ackervekenbm/skin-hq` as `:latest` and `:<sha7>`;
[docker-image.md](docker-image.md#tags) has the tags and how to pin or roll
back. **Settings → About** in the app shows which commit is running.
