# Caddy Sidecar

Orcha uses Caddy as a sidecar container to handle TLS termination.  The Express
server binds only to `127.0.0.1:3000` and is never exposed directly to the
internet; all inbound traffic arrives through Caddy on ports 80 and 443.

## Network namespace sharing

In Azure Container Apps a **revision** can hold multiple containers.  When the
Caddy container and the Orcha container are declared in the same revision they
share the same network namespace, which means Caddy can reach the Express server
at `localhost:3000` without any service-discovery or DNS resolution.  This is
the same model as Kubernetes sidecar containers.

The `caddy/Dockerfile` builds a minimal Caddy image that bakes the `Caddyfile`
in at build time so there are no runtime volume mounts required for the
configuration.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `ORCHA_DOMAIN` | yes | The public FQDN that Caddy will serve and request a Let's Encrypt certificate for (e.g. `orcha.example.com`). Set to `localhost` for local development. |
| `ACME_EMAIL` | yes in production | Email address passed to Let's Encrypt for certificate renewal notifications. Ignored when `ORCHA_DOMAIN=localhost`. |

## Let's Encrypt certificate storage

Caddy persists ACME certificates under its data directory.  The `Caddyfile`
global block sets:

```
storage file_system {
    root /data/caddy
}
```

This directs Caddy to store certificates at `/data/caddy` on the shared
persistent volume, which maps to `caddyDataDir` in `getStoragePaths()`.
Keeping certificate data on the same persistent volume as the application
database means a single Azure File Share (or equivalent) covers both concerns
and certificates survive container restarts and redeployments.

## WebSocket upgrade configuration

WebSocket connections use the HTTP/1.1 `Upgrade` mechanism.  HTTP/2 does not
support this mechanism, so the upstream transport must be pinned to HTTP/1.1:

```caddyfile
@websockets {
    header Connection *Upgrade*
    header Upgrade websocket
}

handle @websockets {
    reverse_proxy localhost:3000 {
        transport http {
            versions h1
        }
    }
}
```

Without `versions h1`, Caddy may attempt an HTTP/2 upstream connection which
cannot carry a WebSocket upgrade, causing the handshake to fail.

## Local development override

Set `ORCHA_DOMAIN=localhost` to enable local testing.  Caddy will issue a
self-signed certificate via its built-in `tls internal` mechanism when the
domain is `localhost` (or any non-public name), so no ACME challenge is
attempted.  No value for `ACME_EMAIL` is needed in this case.

Example `docker-compose.override.yml` snippet:

```yaml
services:
  caddy:
    environment:
      - ORCHA_DOMAIN=localhost
      - ACME_EMAIL=dev@localhost
```
