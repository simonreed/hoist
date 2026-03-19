# hoist

Expose local ports as HTTPS subdomains on your own domain. A focused replacement for ngrok that runs on Cloudflare Tunnels.

```
hoist passflow 5555
hoist assay 3000
hoist membercanoe 3009
```

All three run simultaneously over a single tunnel, each on your own domain.

---

## Why

ngrok works but has two problems: you're on ngrok's domain, and the free tier limits you to one tunnel at a time. Hoist uses Cloudflare Tunnels — one background process, unlimited named subdomains, your own domain, ~40% lower latency.

## How it works

- One named Cloudflare Tunnel runs in the background
- Each `hoist <subdomain> <port>` call registers a DNS record and updates the tunnel's ingress config
- All subdomains route through the same tunnel process — no per-subdomain processes
- State lives at `~/.hoist/state.json`; tunnel config at `~/.cloudflared/config.yml`

## Setup

### 1. Install cloudflared

```sh
brew install cloudflared
```

### 2. Authenticate

```sh
cloudflared tunnel login
```

Opens a browser. Authorise your Cloudflare account. Certificate is written to `~/.cloudflared/cert.pem`.

Your domain must be on Cloudflare DNS.

### 3. Create a tunnel

```sh
cloudflared tunnel create my-tunnel
```

### 4. Install hoist

```sh
npm install -g hoist   # or: npm link from the repo
```

### 5. Initialise

```sh
hoist init simonreed.co my-tunnel
```

---

## Usage

```sh
hoist <subdomain> <port>    # expose localhost:<port> at https://<subdomain>.<domain>
hoist rm <subdomain>        # remove a mapping
hoist ls                    # list active mappings and tunnel status
hoist watch                 # live request view (method, path, status)
hoist stop                  # stop the tunnel process
hoist run                   # run tunnel in foreground (debugging)
hoist status                # show tunnel ID, config paths, process state
hoist init <domain> <name>  # one-time setup
```

Running `hoist <subdomain> <port>` starts the tunnel and immediately opens the live request view. Ctrl-C stops the tunnel.

Running a subdomain a second time with a different port updates the mapping in-place.

---

## Requirements

- macOS (Linux untested but should work)
- Node.js >= 18
- `cloudflared` installed and authenticated
- Domain on Cloudflare DNS
