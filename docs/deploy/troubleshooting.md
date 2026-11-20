# Troubleshooting

Part of the [deployment guides](README.md).

## First checks

1. Is it running? `docker compose ps` (or OMV's **Services** list, or
   `systemctl status skin-hq`).
2. `curl http://<server>:8090/api/health` → `{"ok":true,...}`.
3. The [logs](operations.md#logs): the last lines before a restart say why.

## Symptoms

| Symptom | Fix |
|---|---|
| The stack refuses to start: `set SKINHQ_SESSION_KEY in Environment` (or `in .env`) | The key is missing from the Environment box / `.env` |
| The log says `SKINHQ_SESSION_KEY is required in production` | Bare Node: the key isn't in `/etc/skin-hq.env`, or the unit lacks `EnvironmentFile=` |
| The container restarts with `SqliteError: unable to open database file` | The data folder can't be handed to uid 1000: it is on NTFS/exFAT/FAT, or on a read-only mount. The log line starting with `skin-hq: could not give` says which folder. Move it to a Linux filesystem |
| "Steam session expired — sign in again" | Steam sessions are cookies and drop after a while, often silently. The app notices, hides the inventory and asks you to sign in again. Also expected after changing `SKINHQ_SESSION_KEY` |
| Steam answers 429 / prices stop filling in | Steam is rate-limiting. The sync backs off on its own and a throttled session is *not* signed out. Wait a few minutes, then **Sync now** |
| The CSFloat column is empty | `CSFLOAT_API_KEY` isn't set (or isn't named in the compose file's `environment:`), or CSFloat rejected it |
| A sell stays "awaiting approval" | Confirm (or decline) it in the Steam Mobile app. The app checks with Steam after 90 s and stops waiting after 30 min |
| `Unknown host name. Add it to SKINHQ_ALLOWED_HOSTS` (HTTP 421) | You opened it through a host name that isn't listed. Add the name to `SKINHQ_ALLOWED_HOSTS` (comma-separated) and restart. IP addresses and `localhost` always work |
| The page loads but every action fails, behind a proxy | It is served under a sub-path. Give it its own host name ([https.md](https.md)) |
| The port is already in use | Change the left-hand side of `"8090:3000"` |
| **Pull** is denied | Stale GitHub credentials for the user running Docker: `docker logout ghcr.io` (and with `sudo`), then pull again |
| `no matching manifest for linux/arm/v7` | The host runs a 32-bit OS. Reinstall with a 64-bit one ([why](README.md#the-contract-every-route-shares)) |

## Next

- [operations.md](operations.md): settings, backups, logs
- Back to the overview: [README.md](README.md)
