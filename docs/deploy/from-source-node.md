# Bare Node (from a checkout)

Part of the [deployment guides](README.md).

Run the built server directly under Node, with systemd keeping it alive. Use
this when the host already runs Node and you'd rather not add Docker.

## What you need

- **Node 22 or newer** and `git`. Check with `node -v`; if your distribution's
  Node is older, install a current LTS from
  [NodeSource](https://github.com/nodesource/distributions).
- **A 64-bit OS**: `node -p process.arch` must print `x64` or `arm64`
  ([why](README.md#the-contract-every-route-shares)).
- No C compiler, Python or `make`: the repo's `.npmrc` turns install scripts
  off and the SQLite library ships its binary.
- A session key: `openssl rand -hex 32`.

## Install as a service

The checkout lives in `/opt/skin-hq`, the database in `/var/lib/skin-hq`, and
a system user `skin-hq` owns both.

**1. Create the service user:**

```bash
sudo useradd --system --user-group --create-home --home-dir /var/cache/skin-hq \
  --shell /usr/sbin/nologin skin-hq
sudo install -d -o skin-hq -g skin-hq /opt/skin-hq
```

**2. Clone and build as that user** (`-H` keeps npm's cache in its home):

```bash
sudo -u skin-hq -H git clone https://github.com/ackervekenbm/skin-hq.git /opt/skin-hq
sudo -u skin-hq -H bash -c 'cd /opt/skin-hq && npm ci && npm run build'
```

**3. Store the key** where only root can read it; systemd passes it on:

```bash
sudo install -m 600 /dev/null /etc/skin-hq.env
echo "SKINHQ_SESSION_KEY=$(openssl rand -hex 32)" | sudo tee /etc/skin-hq.env >/dev/null
```

Add `CSFLOAT_API_KEY=...` or any other [setting](operations.md#settings) to
that file, one per line.

**4. Write the unit:**

```bash
sudo tee /etc/systemd/system/skin-hq.service >/dev/null <<'EOF'
[Unit]
Description=SkinHQ (CS2 listing workspace)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=skin-hq
Group=skin-hq
# The server serves dist/ from its working directory.
WorkingDirectory=/opt/skin-hq
Environment=NODE_ENV=production
Environment=HOST=127.0.0.1
Environment=PORT=3000
Environment=DATA_DIR=/var/lib/skin-hq
EnvironmentFile=/etc/skin-hq.env
# Creates /var/lib/skin-hq for User=, readable by it only.
StateDirectory=skin-hq
StateDirectoryMode=0700
ExecStart=/usr/bin/node dist-server/index.js
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now skin-hq
```

Check: `curl http://127.0.0.1:3000/api/health` → `{"ok":true,...}`.

`HOST=127.0.0.1` means only this machine reaches it: put a
[reverse proxy](https.md) in front, or set `HOST=0.0.0.0` to open it to your
LAN ([read this first](README.md#keep-it-on-your-lan-or-tailnet)).

## Updating

```bash
sudo -u skin-hq -H bash -c 'cd /opt/skin-hq && git pull && npm ci && npm run build'
sudo systemctl restart skin-hq
```

To roll back, `git checkout <commit>` instead of `git pull`, then build and
restart the same way.

## Logs

`journalctl -u skin-hq -f`.

## Next

- [https.md](https.md): a host name and HTTPS
- [operations.md](operations.md): settings, backups
- [troubleshooting.md](troubleshooting.md): when something doesn't work
- Back to the overview: [README.md](README.md)
