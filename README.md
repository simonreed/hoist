# hoist

Expose local ports as HTTPS subdomains on your own domain. A focused alternative to ngrok built on Cloudflare Tunnels.

```sh
hoist myapp 3000
hoist api 8080
hoist docs 4000
```

All three run simultaneously over a single tunnel, each on your own domain.

---

## Why not ngrok

ngrok's free tier locks you to ngrok's own domain. Custom domains require a paid plan. hoist uses Cloudflare Tunnels — one background process, any number of named subdomains, your own domain, no per-tunnel fees.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/simonreed/hoist/master/scripts/install.sh | sh
```

Single binary. cloudflared is embedded — no separate install required.

## Setup

Your domain must be on [Cloudflare DNS](https://developers.cloudflare.com/dns/). Run once:

```sh
hoist init yourdomain.com
```

This handles Cloudflare login, tunnel creation, and local config in one step.

---

## Usage

```sh
hoist <subdomain> <port>    # expose localhost:<port> at https://<subdomain>.<domain>
hoist rm <subdomain>        # remove a mapping
hoist ls                    # list active mappings and tunnel status
hoist stop                  # stop the tunnel process
hoist status                # show tunnel ID, config paths, process state
hoist init <domain>         # one-time setup (login + tunnel + config)
```

Running `hoist <subdomain> <port>` again with a different port updates the mapping in place.

---

## How it works

- One named Cloudflare Tunnel runs in the background
- Each `hoist <subdomain> <port>` registers a DNS record and updates the tunnel's ingress config
- All subdomains route through the same process — no per-subdomain processes
- State: `~/.hoist/state.json` · Tunnel config: `~/.cloudflared/config.yml`
- On first run, the embedded cloudflared binary is extracted to `~/.hoist/cloudflared`

---

## Requirements

- macOS (arm64 or x86_64) or Linux (x86_64)
- A domain on [Cloudflare DNS](https://developers.cloudflare.com/dns/)

---

## Build from source

Requires [Bun](https://bun.sh).

```sh
git clone https://github.com/simonreed/hoist
cd hoist
bun run download-cloudflared   # fetch cloudflared for your platform
bun run build                  # outputs dist/hoist
```
