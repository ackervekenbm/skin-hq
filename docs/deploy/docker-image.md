# Docker image (prebuilt)

Part of the [deployment guides](README.md).

Pull the published image: no source, no build. This is the shortest path and
the one to prefer for a home server.

```
ghcr.io/ackervekenbm/skin-hq
```

## What you need

- Docker Engine or Docker Desktop
  ([install](https://docs.docker.com/engine/install/)), with the Compose v2
  plugin (`docker compose`) for the compose variant.
- A 64-bit `amd64` or `arm64` host
  ([why](README.md#the-contract-every-route-shares)).
- A session key: `openssl rand -hex 32`. Keep it in a password manager.
- No source, Node or login: the image is public.

## Tags

| Tag | What it is |
| --- | --- |
| `:latest` | The newest build of `main`, for both `amd64` and `arm64` |
| `:<sha7>` | The build of one commit, both architectures, e.g. `:5a51628` |
| `:latest-amd64`, `:latest-arm64` | The newest build, one architecture only |

`:latest` and `:<sha7>` are multi-arch: Docker picks the right one for the
host.

## Run it with compose

Make an empty folder, e.g. `~/skin-hq`, and put the repo's
[`docker-compose.yml`](../../docker-compose.yml) in it. Next to it, a `.env`
(copy [`.env.example`](../../.env.example)) with at least:

```bash
SKINHQ_SESSION_KEY=<the key>
```

Then, in that folder:

```bash
docker compose up -d
docker compose logs -f skin-hq
```

Open <http://localhost:8090>, or `http://<server-ip>:8090` from another
device, and sign in with your Steam account name, password and a Steam Guard
code from the Steam Mobile app.

- The data lives in the Docker volume `skin-hq-data`; updates and restarts
  keep it.
- `docker compose ps` shows `healthy` once the built-in healthcheck passes.
- The app runs as the image's unprivileged `node` user (uid 1000). The
  container starts as root only to hand `/app/data` to that user, including
  files an older image or a restore left there as root. To skip even that, run
  it with `user: "1000:1000"` and a volume that already belongs to uid 1000.
- Port `3000` is fixed inside the image, because the healthcheck probes it. To
  serve on another port, change the **host** side of the mapping
  (`"80:3000"`).
- Behind a reverse proxy on the same host, use `"127.0.0.1:8090:3000"` so only
  the proxy can reach it ([why](README.md#keep-it-on-your-lan-or-tailnet)).

## Or with `docker run`

```bash
docker run -d --name skin-hq \
  -p 8090:3000 \
  -e SKINHQ_SESSION_KEY=<the key> \
  -v skin-hq-data:/app/data \
  --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 \
  --restart unless-stopped \
  ghcr.io/ackervekenbm/skin-hq:latest
```

The `--log-*` flags cap the container log at 30 MB. The key ends up in your
shell history this way; `--env-file .env` avoids that.

## Update

```bash
docker compose pull && docker compose up -d
```

Only the container is replaced; the `skin-hq-data` volume (your Steam session
and the cache) stays. With `docker run`: `docker pull`, `docker rm -f skin-hq`,
and the run command again.

## Pin a version, roll back

`:latest` is convenient but not reproducible. Pin a commit tag instead, in
`docker-compose.yml`:

```yaml
    image: ghcr.io/ackervekenbm/skin-hq:5a51628
```

Pick one from the
[package page](https://github.com/ackervekenbm/skin-hq/pkgs/container/skin-hq).
Rolling back is the same edit with an older tag, then `docker compose up -d`.

## If a pull is denied

The image is public, so pulls need no login. A `denied` or `unauthorized`
error usually means stale GitHub credentials are stored for the user running
`docker`: `docker logout ghcr.io` (and `sudo docker logout ghcr.io`), then
pull again.

## Next

- [https.md](https.md): a host name and HTTPS
- [operations.md](operations.md): settings, backups, logs
- [troubleshooting.md](troubleshooting.md): when something doesn't work
- Back to the overview: [README.md](README.md)
