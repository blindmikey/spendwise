# Hosting Spend Wise

Run the web version on your own server and reach it from any browser. It's
plain Node - Electron is a dev dependency and is never installed on a server.
One process owns the database, so everyone editing through it merges cleanly.

- [Install](#install)
- [Docker](#docker)
- [Configuration](#configuration)
- [Putting it on the internet safely](#putting-it-on-the-internet-safely)
- [Reverse proxy configs](#reverse-proxy-configs)
- [Security model](#security-model)
- [Desktop-only features](#desktop-only-features)

## Install

**Node 18 or newer.** The full suite plus a live login → edit → merge →
close-out round trip is verified on Node 18 and 22; the Docker image ships
Node 22.


```bash
npm i -g spendwise
spendwise-server --set-password  # required - everyone signs in with this
spendwise-server                 # → http://localhost:4180
```

The database lands in `./data/db.json` relative to where you start it; set
`FINANCES_DB_PATH` to put it somewhere deliberate. Back that one file up and
you've backed up everything.

### Running it as a service

A minimal systemd unit:

```ini
# /etc/systemd/system/spendwise.service
[Unit]
Description=Spend Wise
After=network.target

[Service]
User=spendwise
Environment=FINANCES_DB_PATH=/srv/spendwise/db.json
Environment=FINANCES_HOST=127.0.0.1
Environment=FINANCES_TRUST_PROXY=1
ExecStart=/usr/bin/spendwise-server
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now spendwise
```

## Docker

> **Untested.** The Dockerfile is included and builds, but hasn't been run in
> anger yet. If you try it, issues and corrections are welcome.

```bash
docker build -t spendwise .
docker run -d --name spendwise \
  -p 4180:4180 \
  -v /srv/spendwise:/data \
  -e FINANCES_PASSWORD=change-me \
  -e FINANCES_TRUST_PROXY=1 \
  spendwise
```

`FINANCES_PASSWORD` applies **only on first run**, when the database has no
password yet - it never overwrites one set later. To change it afterwards:

```bash
docker exec -it spendwise node src/server/cli.mjs --set-password
```

The `/data` volume holds `db.json`. Nothing else in the container is worth
keeping.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `FINANCES_DB_PATH` | `./data/db.json` | the whole database |
| `FINANCES_PORT` / `PORT` | `4180` | |
| `FINANCES_HOST` | `0.0.0.0` | bind `127.0.0.1` when a proxy is in front |
| `FINANCES_PASSWORD` | - | sets the login on first run only |
| `FINANCES_TRUST_PROXY` | `0` | number of reverse proxies in front (usually `1`) |
| `FINANCES_SECURE_COOKIE` | off | force `Secure` cookies (auto-detected from `X-Forwarded-Proto` when a proxy is trusted) |

(The `FINANCES_*` prefix predates the rename to Spend Wise and still works.)

## Putting it on the internet safely

The server speaks **plain HTTP** and has no TLS of its own. It's fine on a LAN
or a private network; on the public internet **always terminate HTTPS in front
of it**, or the app password crosses the network in the clear.

- **Private network (simplest):** put the host and your phone on
  [Tailscale](https://tailscale.com) - reachable anywhere, nothing exposed,
  encrypted end to end.
- **Cloudflare Tunnel:** point `cloudflared` at `localhost:4180` for an HTTPS
  URL without opening a router port.
- **Reverse proxy:** terminate TLS there and set `FINANCES_TRUST_PROXY=1`.
  Configs below.

### `FINANCES_TRUST_PROXY` matters

Rate limiting keys on the client IP, so the server has to know which IP is real.

- **Unset behind a proxy:** every request appears to come from the proxy, so one
  attacker's failed logins lock out *everyone*.
- **Set higher than the proxies you actually run:** a client can forge
  `X-Forwarded-For` and dodge the lockout entirely.

Set it to the real number of hops - one proxy in front means `1`.

### Setting it from the desktop app

If you turn on web access from the **desktop app** (Settings → Web access)
rather than running the server from the CLI, there are no env vars to set.
Expand **Behind a reverse proxy?** in that same panel to set the trusted-hop
count and force `Secure` cookies. The settings persist and apply the next time
web access starts.

The two sources combine: a value set in that panel wins; if it's left alone,
`FINANCES_TRUST_PROXY` / `FINANCES_SECURE_COOKIE` from the environment apply;
otherwise the default is no trusted proxy. So once you set a hop count in the
panel it overrides the env var - pick one place and stick with it.

## Reverse proxy configs

All three assume Spend Wise is bound to `127.0.0.1:4180`
(`FINANCES_HOST=127.0.0.1`) and that you set `FINANCES_TRUST_PROXY=1`.

### Caddy

Caddy gets you an automatic Let's Encrypt certificate and sets
`X-Forwarded-For` / `X-Forwarded-Proto` for you.

```caddyfile
# /etc/caddy/Caddyfile
spendwise.example.com {
    reverse_proxy 127.0.0.1:4180
}
```

### nginx

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name spendwise.example.com;

    ssl_certificate     /etc/letsencrypt/live/spendwise.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/spendwise.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:4180;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 80;
    server_name spendwise.example.com;
    return 301 https://$host$request_uri;
}
```

### Apache

Needs `proxy`, `proxy_http`, `ssl` and `headers`:

```bash
a2enmod proxy proxy_http ssl headers
```

```apache
<IfModule mod_ssl.c>
<VirtualHost *:443>
    ServerName spendwise.example.com

    SSLEngine on
    SSLCertificateFile    /etc/letsencrypt/live/spendwise.example.com/fullchain.pem
    SSLCertificateKeyFile /etc/letsencrypt/live/spendwise.example.com/privkey.pem

    ProxyPreserveHost On
    ProxyPass        / http://127.0.0.1:4180/
    ProxyPassReverse / http://127.0.0.1:4180/

    RequestHeader set X-Forwarded-Proto "https"
    RequestHeader set X-Forwarded-Port "443"

    ErrorLog ${APACHE_LOG_DIR}/spendwise_error.log
    CustomLog ${APACHE_LOG_DIR}/spendwise_access.log combined
</VirtualHost>
</IfModule>

<VirtualHost *:80>
    ServerName spendwise.example.com
    Redirect permanent / https://spendwise.example.com/
</VirtualHost>
```

Apache's `mod_proxy_http` appends the client to `X-Forwarded-For` on its own;
don't set that header manually or you'll break the hop count.

## Security model

- One shared app password; there are **no separate user accounts**. Everyone who
  signs in sees and edits the same data.
- Failed logins are rate-limited per client IP: 5 misses → 15 minute lockout.
- The password is scrypt-hashed and stored in `db.json`. The hash never leaves
  the server.
- Sessions are HttpOnly cookies held in memory - a restart signs everyone out.
- Password management is desktop/CLI-only, so a web client can't change it.
- **Anyone who can read `db.json` can read your finances.** The password protects
  the app, not the file - use file permissions.
- **Keep the database outside `src/`.** Only files under `src/` are ever served,
  so the default `./data/db.json` can't be fetched over HTTP no matter what the
  URL says - a reverse proxy deny rule isn't needed and wouldn't do anything.
  Pointing `FINANCES_DB_PATH` at a path inside `src/` puts it back in the served
  tree, which is the one way to undo that.
- **One outbound request:** once a day the server GETs this project's latest
  release tag from `api.github.com` so it can flag an update. It's an
  unauthenticated public read - no identifier, nothing about your data - and it
  fails silently on an air-gapped box. Untick **Settings → Updates → Check
  GitHub for new releases** to stop it; the choice lives in `db.json`, so you
  set it once for everyone using your server.

## Desktop-only features

Server mode has no native dialogs, so these live in the desktop app:

- exporting a copy of the database
- moving / relocating the database file
- importing legacy data
- setting or changing the app password (also available via
  `spendwise-server --set-password`)

Point the desktop app at the same file when you need them - one writer at a
time.
