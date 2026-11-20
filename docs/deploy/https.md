# HTTPS and a host name

Part of the [deployment guides](README.md).

SkinHQ serves plain HTTP on port `3000`; HTTPS is a reverse proxy's job.

## Does it need HTTPS?

Nothing in the app requires it. But signing in sends your Steam password from
the browser to SkinHQ, and over plain HTTP anyone on the same network can read
it. With HTTPS, sign in over the HTTPS address.

## Rules for any proxy

- **Its own host name**, e.g. `skin-hq.example.home`. The app calls `/api/...`
  from the root, so it can't live under a sub-path.
- Point it at the container's port `3000` (or the host port you published).
  No extra headers or base-URL setting needed.
- Keep the name inside your LAN or tailnet: the app still has no login
  ([why](README.md#keep-it-on-your-lan-or-tailnet)).

## Caddy

On the same Docker network as the app (Caddy reaches it by service name):

```caddyfile
skin-hq.example.home {
  reverse_proxy skin-hq:3000
}
```

Caddy on the host, in front of a published port (`"127.0.0.1:8090:3000"`):

```caddyfile
skin-hq.example.home {
  reverse_proxy 127.0.0.1:8090
}
```

For a name only your LAN can reach, Caddy needs a DNS challenge to get a
real certificate. One way that needs no open ports: a free DuckDNS name
pointed at the server's LAN address, and a Caddy build with the
`caddy-dns/duckdns` module. Jukebox's guide walks through it step by step:
[DuckDNS + Let's Encrypt with Caddy](https://github.com/ackervekenbm/jukebox/blob/main/docs/deploy/https-and-offline.md#duckdns--lets-encrypt-with-caddy).

## nginx

```nginx
server {
  listen 443 ssl;
  server_name skin-hq.example.home;
  ssl_certificate     /etc/ssl/skin-hq.crt;
  ssl_certificate_key /etc/ssl/skin-hq.key;

  location / {
    proxy_pass http://127.0.0.1:8090;
    proxy_set_header Host $host;
  }
}
```

## Tailscale

On a tailnet, `tailscale serve --bg 8090` gives the app an HTTPS address on
your `*.ts.net` name, reachable from your own devices only. Never use
`tailscale funnel`: that puts it on the internet.

## Next

- [operations.md](operations.md): settings, backups, logs
- [troubleshooting.md](troubleshooting.md): when something doesn't work
- Back to the overview: [README.md](README.md)
