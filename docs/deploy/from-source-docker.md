# Docker, built from a checkout

Part of the [deployment guides](README.md).

Build the image yourself from the repo, e.g. to run a version with your own
changes. It is the same image CI publishes, built on your machine.

## What you need

- Docker with the Compose v2 plugin, and `git`.
- A 64-bit `amd64` or `arm64` host
  ([why](README.md#the-contract-every-route-shares)). The build itself needs
  no compiler: nothing native is built during install.
- A session key: `openssl rand -hex 32`.

## Run it

```bash
git clone https://github.com/ackervekenbm/skin-hq.git
cd skin-hq
cp .env.example .env          # put the key in SKINHQ_SESSION_KEY
docker build -t ghcr.io/ackervekenbm/skin-hq:latest \
  --build-arg COMMIT_SHA=$(git rev-parse HEAD) \
  --build-arg BUILD_TIME=$(git log -1 --format=%cI) .
docker compose up -d
```

Tagging the build with the image name the compose file uses makes
`docker compose up` run your build instead of pulling. Don't run
`docker compose pull` afterwards: it would replace your build with the
published one.

The `--build-arg`s are optional: they fill in **Settings → About**, which
otherwise says "development build".

Everything about the running container (port, data volume, user, logs) is as
in [docker-image.md](docker-image.md#run-it-with-compose).

## Updating

```bash
git pull
docker build -t ghcr.io/ackervekenbm/skin-hq:latest \
  --build-arg COMMIT_SHA=$(git rev-parse HEAD) \
  --build-arg BUILD_TIME=$(git log -1 --format=%cI) .
docker compose up -d
```

The data volume stays.

## Next

- [https.md](https.md): a host name and HTTPS
- [operations.md](operations.md): settings, backups, logs
- [troubleshooting.md](troubleshooting.md): when something doesn't work
- Back to the overview: [README.md](README.md)
