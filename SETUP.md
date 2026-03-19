# share — Cloudflare tunnel CLI

Replaces `ngrok http 5555 --hostname=passflow.ngrok.io` with `share passflow 5555`.

One background `cloudflared` process serves all hostnames over HTTPS on your own domain.

---

## One-time setup

### 1. Install cloudflared

```sh
brew install cloudflared
```

### 2. Authenticate with Cloudflare

```sh
cloudflared tunnel login
```

This opens a browser to authorise your Cloudflare account and writes a certificate to `~/.cloudflared/cert.pem`.

### 3. Create a named tunnel

```sh
cloudflared tunnel create simonreed-dev
```

This creates a persistent tunnel (not ephemeral like ngrok free tier) and writes credentials to `~/.cloudflared/<tunnel-id>.json`.

### 4. Install the CLI

```sh
cd ~/claude/my-life/share-cli
npm link
```

This puts `share` on your PATH via Node.js.

### 5. Initialise

```sh
share init simonreed.co simonreed-dev
```

---

## Daily usage

```sh
share assay 3000          # https://assay.simonreed.co -> localhost:3000
share passflow 5555       # https://passflow.simonreed.co -> localhost:5555
share membercanoe 3009    # https://membercanoe.simonreed.co -> localhost:3009

share ls                  # list all active mappings
share rm assay            # remove a mapping
share stop                # stop the tunnel process
share run                 # run in foreground (useful for debugging)
share status              # show config paths and tunnel ID
```

Running `share <subdomain> <port>` a second time with a different port updates the mapping in-place and restarts the tunnel.

---

## How it works

- State lives at `~/.share-cli/state.json`
- Cloudflared config is written to `~/.cloudflared/config.yml` on every change
- DNS records are created via `cloudflared tunnel route dns` (idempotent — safe to run repeatedly)
- The tunnel process runs detached in the background; its PID is tracked at `~/.share-cli/cloudflared.pid`
- All subdomains share one tunnel connection to Cloudflare; routing by hostname happens in the ingress config

---

## Requirements

- `cloudflared` installed and authenticated
- Domain on Cloudflare DNS (required for `tunnel route dns` to work)
- Node.js >= 18
