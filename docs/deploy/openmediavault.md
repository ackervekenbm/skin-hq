# OpenMediaVault (Compose plugin)

Part of the [deployment guides](README.md).

The [prebuilt image](docker-image.md), run from OMV's web UI. No SSH needed.

## Prerequisites

- omv-extras with the **`openmediavault-compose`** plugin (**System →
  Plugins**), on a 64-bit OS.
- In **Services → Compose → Settings**: a *Compose Files* shared folder (where
  the plugin keeps each stack's files) and a *Data* shared folder (the plugin
  puts its path wherever a file says `CHANGE_TO_COMPOSE_DATA_PATH`).
- A session key: `openssl rand -hex 32` on any machine. Keep it in a password
  manager.

## Create the stack

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
         # Optional: blank uses the app's default (see operations.md#settings).
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

4. **Environment**: the key, one per line, no quotes. Add an optional
   [setting](operations.md#settings) only to change it.

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

## What that file does

- **`CHANGE_TO_COMPOSE_DATA_PATH/skin-hq`**: `<Data folder>/skin-hq/skin-hq.db`
  is all the state, in an ordinary folder you can browse, copy and back up,
  and which **Prune → Volume** can't delete.
- **Ownership is automatic.** The app runs as uid 1000. Each time the container
  starts it gives the `skin-hq` folder and its files to that user, also a
  folder an older image or a restore left owned by root. The folder must be on
  a Linux filesystem (ext4, btrfs, xfs, what OMV formats with): NTFS, exFAT and
  FAT can't store an owner, and the app then can't open its database.
- **Port `8090`**: any free host port works; change the left-hand number only.
  Behind a reverse proxy on the same Docker network you can drop `ports:`
  altogether ([https.md](https.md)).
- **No `container_name`**: compose names it `skin-hq-skin-hq-1`.
- **`logging`**: caps the container log at 30 MB, so it can't fill the disk.
- **The settings are listed, not commented out.** Compose only passes a value
  from the Environment box into the container when the file names it. To use
  another [setting](operations.md#settings), add its line under
  `environment:` the same way.

## Updating

Select the stack → **Pull** → **Up**. The data folder and your Steam session
are untouched. To pin or roll back, replace `:latest` with a commit tag
([tags](docker-image.md#tags)) and press **Up**.

## Backups

A **Services → Compose → Schedule** job with *Backup* enabled stops the stack,
copies its data folder and starts it again: exactly what
[a safe backup](operations.md#backups) needs.

## Reset

**Down** stops the container and keeps the data. To start over (sign in again,
empty cache), also delete the `skin-hq` folder in the Data shared folder.

## Next

- [https.md](https.md): a host name and HTTPS
- [operations.md](operations.md): settings, backups, logs
- [troubleshooting.md](troubleshooting.md): when something doesn't work
- Back to the overview: [README.md](README.md)
