# hoist — v1.0 Roadmap Plan

## Executive Summary

hoist replaces ngrok for developers who own a Cloudflare domain and need multiple simultaneous HTTPS subdomains for local development. v1.0 ships as a single self-contained binary (cloudflared embedded, no external dependencies) distributed via `curl -fsSL https://hoist.sh | sh`. Success: a developer goes from cold machine to live HTTPS URL on their own domain in under 3 minutes, with one install command and two setup commands.

## ICPs covered

| ID | Profile | Key need |
|----|---------|----------|
| ICP-A | Solo indie developer | Webhook/OAuth testing, single subdomain daily |
| ICP-B | Multi-project developer | 3+ subdomains simultaneously |
| ICP-C | ngrok switcher | Drop-in replacement, same muscle memory |
| ICP-D | Returning/lapsed user | Stale state recovery, credential refresh |

---

## Sequence diagram coverage

| Diagram | Phase | Notes |
|---------|-------|-------|
| S01 First-time install + init | P4, P6 | Core onboarding |
| S02 Daily usage single subdomain | P1 | Already works |
| S03 Multiple subdomains | P1 | Already works |
| S04 Add subdomain while running | P1 | Already works |
| S05 Port not listening (502) | P1 | Already works — watch shows 502 |
| S06 Stale PID after reboot | P1 | Already works |
| S07 Credentials expired | P4 | New: --reauth flag |
| S08 DNS idempotent | P1 | Already works |
| S09 DNS conflict | P1 | Already works — exits with error |
| S10 rm with remaining mappings | P1 | Already works |
| S11 rm last mapping | P1 | Already works |
| S12 Tunnel crash mid-session | P1 | Partially — no auto-restart |
| S13 watch standalone no-stop | P1 | Already works |
| S14 ls empty state | P1 | Already works |
| S15 hoist before init | P1 | Needs message update (share→hoist) |
| S16 Domain not on Cloudflare DNS | P4 | Error message improvement |
| S17 install.sh permission denied | P6 | Fallback to ~/.local/bin |
| S18 Linux x86_64 install | P5, P6 | CI build target |
| S19 Unsupported platform | P6 | install.sh guard |
| S20 Self-extract cloudflared | P3 | New capability |

---

## Data model

### State file: `~/.hoist/state.json`

```json
{
  "domain": "simonreed.co",
  "tunnelName": "hoist-dev",
  "tunnelId": "a763e6ef-...",
  "mappings": [
    { "subdomain": "passflow", "port": 5555 },
    { "subdomain": "assay", "port": 3000 }
  ]
}
```

No schema changes required through v1.0. Rename from `~/.share-cli/` to `~/.hoist/` in Phase 1.

### Filesystem layout (v1.0)

```
~/.hoist/
  state.json          — domain, tunnel name/ID, active mappings
  cloudflared.pid     — PID of running cloudflared process
  cloudflared.log     — append-only debug log (request/response lines)
  bin/
    cloudflared       — self-extracted embedded binary (written on first run)
  <tunnel-id>.json    — cloudflared tunnel credentials (written by cloudflared)
  cert.pem            — cloudflared origin certificate (written by cloudflared)

~/.cloudflared/
  config.yml          — generated tunnel ingress config (written by hoist)
```

Note: cloudflared writes cert.pem and tunnel credentials to `~/.cloudflared/` by default. In Phase 3 we redirect these to `~/.hoist/` via `--origincert` and `--credentials-file` flags so the entire hoist footprint is in one directory.

---

## Phase 1 — Rename share → hoist

**Scope:** Rename binary, state directory, and all user-facing strings. No functional changes.

**Changes required:**
- `package.json`: rename `"share"` bin to `"hoist"`, package name to `"hoist"`
- `src/cli.js` → `src/cli.js` (no rename, file stays): replace all `~/.share-cli` paths with `~/.hoist`; replace all `share` in user-facing strings with `hoist`
- `README.md`: update all references
- `npm unlink share && npm link` to update the global binary
- Directory rename: `share-cli/` → `hoist/` (git mv or new repo push)

**Success criteria — happy path:**
- `hoist passflow 5555` works identically to `share passflow 5555`
- State is stored at `~/.hoist/state.json`
- `which hoist` resolves correctly

**Success criteria — edge cases:**
- Old `~/.share-cli/state.json` data is not silently lost. Migration note: if `~/.share-cli/state.json` exists and `~/.hoist/state.json` does not, copy it and print: `"Migrated state from ~/.share-cli to ~/.hoist"`
- `share` binary still on PATH from old `npm link` — user sees "command not found" only if they removed npm link; no automatic conflict

**Error states:**
- `npm link` fails due to permission → document `sudo npm link` or use `--prefix ~/.local`

---

## Phase 2 — Port to TypeScript + Bun

**Scope:** Rewrite `src/cli.js` as `src/cli.ts`. Required for Bun compile in Phase 3.

**Changes required:**
- Install Bun: `curl -fsSL https://bun.sh/install | bash`
- Add `tsconfig.json` (target: ESNext, module: ESNext, strict: true)
- Port all functions with explicit types:
  - `State`: `{ domain: string; tunnelName: string; tunnelId: string; mappings: Mapping[] }`
  - `Mapping`: `{ subdomain: string; port: number }`
  - `TunnelStatus`: `{ running: boolean; pid: number | null }`
  - `LogEvent`: `{ type: "req" | "res"; time: string; ... }`
  - `WatchOptions`: `{ filterHost?: string | null; stopOnExit?: boolean }`
- Keep all `node:fs`, `node:os`, `node:path`, `node:child_process` imports as-is — Bun supports the Node.js compatibility layer and these work unchanged. Do not replace with Bun-native APIs; the Node.js APIs are sufficient and avoid Bun-specific lock-in at this stage.
- Update `package.json` bin to point to `src/cli.ts`
- Shebang: `#!/usr/bin/env bun`
- Update `npm link` → `bun link`

**Success criteria — happy path:**
- `bun run src/cli.ts passflow 5555` works identically to Node version
- `bun build --compile src/cli.ts --outfile hoist` produces a working binary
- Compiled binary runs without Bun or Node installed: `./hoist passflow 5555`

**Success criteria — edge cases:**
- All existing functionality (watch, logs, rm, ls, stop, run, status, init) passes manual smoke test
- No TypeScript errors (`bun typecheck`)

**Error states:**
- Bun not installed → document install step; Phase 2 is blocked until Bun is available
- Type errors in port → fix before proceeding; do not use `any` to paper over

---

## Phase 3 — Embed cloudflared binary

**Scope:** Bundle the cloudflared binary for each target platform into the hoist binary. Self-extract on first run.

**Changes required:**

### 3a — Download cloudflared binaries for each target
```
assets/
  cloudflared-macos-arm64      (from cloudflare/cloudflared releases)
  cloudflared-macos-x86_64
  cloudflared-linux-x86_64
```

These are downloaded at build time by GitHub Actions (Phase 5), not committed to git.

### 3b — Bun asset embedding API

At the top of `cli.ts`, import the platform-specific binary as a file asset:

```typescript
// These imports are resolved at compile time by bun build --compile
// At runtime they resolve to the path of the extracted embedded file
import cloudflaredDarwinArm64 from "../assets/cloudflared-darwin-arm64" with { type: "file" };
import cloudflaredDarwinX64   from "../assets/cloudflared-darwin-x64"   with { type: "file" };
import cloudflaredLinuxX64    from "../assets/cloudflared-linux-x64"     with { type: "file" };

function embeddedCloudflaredPath(): string {
  const key = `${process.platform}-${process.arch}`;
  switch (key) {
    case "darwin-arm64": return cloudflaredDarwinArm64;
    case "darwin-x64":   return cloudflaredDarwinX64;
    case "linux-x64":    return cloudflaredLinuxX64;
    default:
      console.error(`No embedded cloudflared for platform: ${key}`);
      process.exit(1);
  }
}
```

At runtime in a compiled binary, these string imports resolve to the path where Bun has extracted the embedded asset. The file already exists — no manual extraction is needed. `chmod +x` must still be called once:

```typescript
function cloudflaredBin(): string {
  const dest = join(HOIST_DIR, "bin", "cloudflared");
  if (existsSync(dest)) return dest;

  mkdirSync(join(HOIST_DIR, "bin"), { recursive: true });
  // Bun has already extracted the asset; copy to our controlled path
  copyFileSync(embeddedCloudflaredPath(), dest);
  chmodSync(dest, 0o755);
  return dest;
}
```

- `copyFileSync` and `chmodSync` added to imports from `node:fs`
- All `spawnSync("cloudflared", ...)` and `spawn("cloudflared", ...)` calls replaced with `spawnSync(cloudflaredBin(), ...)` and `spawn(cloudflaredBin(), ...)`
- `requireCloudflared()` function removed entirely

### 3c — Bun compile command

```bash
bun build --compile \
  --asset-naming [dir]/[name] \
  --assets assets/ \
  --target bun-darwin-arm64 \
  --outfile dist/hoist-macos-arm64 \
  src/cli.ts
```

### 3d — Redirect cloudflared data directory

Pass `--origincert` and `--credentials-file` to all cloudflared spawns so the entire hoist footprint lives in `~/.hoist/`:

| Call site | Flags added |
|-----------|-------------|
| `cloudflared tunnel login` | `--origincert ~/.hoist/cert.pem` |
| `cloudflared tunnel create <name>` | `--credentials-file ~/.hoist/<name>.json` |
| `cloudflared tunnel list` | `--origincert ~/.hoist/cert.pem` |
| `cloudflared tunnel route dns` | `--origincert ~/.hoist/cert.pem` |
| `cloudflared tunnel run` (spawn) | `--origincert ~/.hoist/cert.pem` (config.yml references `~/.hoist/<id>.json`) |

`config.yml` `credentials-file` field updated to `~/.hoist/<tunnel-id>.json`.

**Success criteria — happy path:**
- `dist/hoist-macos-arm64 passflow 5555` works on a machine with no cloudflared installed
- `~/.hoist/bin/cloudflared` is created on first run
- Subsequent runs reuse the extracted binary (no re-extraction)

**Success criteria — edge cases:**
- If `~/.hoist/bin/cloudflared` exists but is corrupt or wrong arch → detect via `cloudflared --version` exit code → re-extract
- If `~/.hoist/bin/` is not writable → exit with: `"Cannot write to ~/.hoist/bin/. Check permissions."`
- Binary size: expect ~42MB per platform binary — acceptable for a dev tool

**Error states:**
- Asset not found in bundle (wrong platform at build time) → exit: `"No cloudflared binary bundled for your platform (darwin/arm64). Download manually: https://github.com/simonreed/hoist/releases"`

---

## Phase 4 — Simplified init

**Scope:** `hoist init <domain>` replaces the three-step setup (login + tunnel create + init). Handles everything automatically.

**Changes required:**

### New `cmdInit` flow

```
hoist init <domain> [--reauth]
```

1. Check `~/.hoist/cert.pem` — if missing or `--reauth` passed:
   - Run `cloudflared tunnel login --origincert ~/.hoist/cert.pem`
   - Open browser, wait for callback
   - On timeout (10min): exit with "Login timed out. Try again."
   - On success: print "Authenticated."
2. Check `~/.hoist/state.json` — if tunnel already exists and `--reauth` not passed:
   - Print "Already initialised for <domain> (tunnel: <name>). Use --reinit to recreate."
   - Exit 0
3. Auto-generate tunnel name from domain: `<domain-root>-hoist` (e.g. `simonreed-hoist`)
4. Run `cloudflared tunnel create <tunnel-name> --credentials-file ~/.hoist/<id>.json`
5. Save state, write config
6. Print: `"Ready. Run: hoist <subdomain> <port>"`

### Flags
- `--reauth` — re-run browser login, keep existing tunnel
- `--reinit` — delete existing tunnel and create fresh (destructive, confirm prompt)
- `--tunnel <name>` — use an existing named tunnel instead of auto-creating one (for name conflict recovery)

### Credential expiry detection (S07)
In `startTunnel()`, detect if cloudflared process exits within 3 seconds with a non-zero code and log contains "certificate" or "expired":
```
"Tunnel failed to start. Credentials may have expired. Run: hoist init <domain> --reauth"
```

### Domain-not-on-Cloudflare improvement (S16)
In `ensureDns()`, detect cloudflared error output containing "zone" or "not found":
```
"DNS failed: <domain> is not managed by Cloudflare DNS.
 Transfer your domain's nameservers to Cloudflare, then retry."
```

**Success criteria — happy path (S01):**
- `hoist init simonreed.co` completes: opens browser, waits, creates tunnel, saves state
- Total time from cold: under 60 seconds (excluding browser interaction)
- `hoist passflow 5555` works immediately after

**Success criteria — edge cases:**
- `hoist init` when already initialised → "Already initialised" message, no destructive action (S07 reauth path)
- Browser login times out → clean error, process exits, no partial state written
- `cloudflared tunnel create` fails (name conflict) → auto-append `-2`, retry once; if still fails: print `"Could not create tunnel. A tunnel named '<name>' and '<name>-2' already exist in your Cloudflare account. Run: cloudflared tunnel list to see existing tunnels, then: hoist init <domain> --tunnel <existing-name>"` and exit 1
- `--reinit` without confirmation → prompt: "This will delete tunnel <name>. Type the tunnel name to confirm:"

**Error states:**
- No network → cloudflared login URL cannot be generated → `"No network connection. Check your internet and retry."`
- Cloudflare API rate limit → pass through cloudflared error with note: `"Cloudflare rate limit hit. Wait 60s and retry."`

---

## Phase 5 — GitHub Actions CI

**Scope:** Automated builds producing platform binaries on every push to main and on version tags.

**Changes required:**

### `.github/workflows/release.yml`

Triggered by: `push` to `main` (draft release) and `tags` matching `v*` (published release).

Matrix:
```yaml
strategy:
  matrix:
    include:
      - target: bun-darwin-arm64
        os: macos-latest
        asset: hoist-macos-arm64
      - target: bun-darwin-x64
        os: macos-13
        asset: hoist-macos-x86_64
      - target: bun-linux-x64
        os: ubuntu-latest
        asset: hoist-linux-x86_64
```

Build steps per matrix job:
1. `actions/checkout`
2. `oven-sh/setup-bun@v2`
3. Download correct cloudflared binary for target platform into `assets/`
4. `bun build --compile --target=${{ matrix.target }} --assets assets/ ...`
5. Upload artifact: `${{ matrix.asset }}`

Release job (runs after all matrix jobs, tag pushes only):
1. Download all three artifacts
2. `gh release create $TAG --generate-notes hoist-macos-arm64 hoist-macos-x86_64 hoist-linux-x86_64`

### Cloudflared version pinning

Pin to a specific cloudflared release version in the workflow. Document upgrade process. Do not use `latest` — breaking changes in cloudflared have historically caused issues.

Pinned version at time of writing: `2026.3.0`

**Success criteria — happy path:**
- Push to main → CI produces three binaries as artifacts within 10 minutes
- Tag `v1.0.0` → GitHub Release created with all three binaries attached and auto-generated changelog

**Success criteria — edge cases:**
- cloudflared download URL changes → build fails visibly with clear error; pin URL pattern in workflow constants
- One platform build fails → other platforms still publish; release is created with available binaries + note in release body
- Bun version incompatibility → pin Bun version in workflow (`bun-version: "1.x"`)

**Error states:**
- `gh release create` fails due to missing `GH_TOKEN` permissions → document required repo settings (Actions → Workflow permissions → Read and write)

---

## Phase 6 — install.sh + distribution

**Scope:** One-line install script and `hoist.sh` domain.

### install.sh logic

```bash
#!/usr/bin/env bash
set -euo pipefail

REPO="simonreed/hoist"
INSTALL_DIR="/usr/local/bin"

# 1. Detect platform
OS=$(uname -s)
ARCH=$(uname -m)

case "$OS-$ARCH" in
  Darwin-arm64)   ASSET="hoist-macos-arm64" ;;
  Darwin-x86_64)  ASSET="hoist-macos-x86_64" ;;
  Linux-x86_64)   ASSET="hoist-linux-x86_64" ;;
  *)
    echo "Unsupported platform: $OS-$ARCH"
    echo "Download manually: https://github.com/$REPO/releases"
    exit 1 ;;
esac

# 2. Get latest release URL
URL=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
  | grep "browser_download_url.*$ASSET\"" \
  | cut -d '"' -f 4)

# 3. Download
TMP=$(mktemp)
curl -fsSL "$URL" -o "$TMP"
chmod +x "$TMP"

# 4. Install — try /usr/local/bin, fall back to ~/.local/bin
if [ -w "$INSTALL_DIR" ]; then
  mv "$TMP" "$INSTALL_DIR/hoist"
  echo "hoist installed to $INSTALL_DIR/hoist"
else
  INSTALL_DIR="$HOME/.local/bin"
  mkdir -p "$INSTALL_DIR"
  mv "$TMP" "$INSTALL_DIR/hoist"
  echo "hoist installed to $INSTALL_DIR/hoist"
  echo ""
  echo "Add to PATH if not already present:"
  echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
fi

echo ""
echo "Next: hoist init <your-cloudflare-domain>"
```

### Distribution options

**Option A (simplest): GitHub raw URL**
```
curl -fsSL https://raw.githubusercontent.com/simonreed/hoist/main/install.sh | sh
```
No custom domain needed. Works immediately. Use for v1.0.

**Option B: Custom domain (post-v1.0)**
Point `hoist.sh` (or `gethoist.dev`) to a Cloudflare Worker that serves install.sh. Allows download tracking and platform-specific redirects without changing the install URL.

**v1.0 uses Option A.** Custom domain is post-v1.0.

### README install section
```
curl -fsSL https://raw.githubusercontent.com/simonreed/hoist/main/install.sh | sh
hoist init simonreed.co
hoist passflow 5555
```

**Success criteria — happy path (S01, S17, S18):**
- macOS arm64: install completes, `hoist --version` works
- macOS x86_64: same
- Linux x86_64: same
- `/usr/local/bin` not writable: falls back to `~/.local/bin` with PATH instruction (S17)

**Success criteria — edge cases:**
- Network drops mid-download: `curl -fsSL` exits non-zero → `set -euo pipefail` kills script cleanly; temp file cleaned up
- GitHub API rate limit (no auth): script retries once with 5s sleep; on second failure prints manual URL
- Unsupported platform: clear message + manual URL (S19)
- hoist already installed: overwrites silently (idempotent)

**Error states:**
- Binary download returns 404 (release not found) → print: `"No release found. Check https://github.com/simonreed/hoist/releases"`
- `chmod +x` fails → unlikely (temp file); if occurs, print error and manual install instructions

---

## Phase 7 — v1.0 Release

**Scope:** Cut the v1.0 tag, verify all platforms, publish.

### Pre-release checklist

- [ ] All phases 1–6 complete and smoke-tested
- [ ] macOS arm64 binary tested on clean machine (no Node, no cloudflared, no Bun)
- [ ] macOS x86_64 binary tested (can use GitHub Actions macOS-13 runner)
- [ ] Linux x86_64 binary tested (Docker: `FROM ubuntu:22.04`)
- [ ] `hoist init simonreed.co` → `hoist passflow 5555` under 3 minutes from zero
- [ ] `hoist watch` shows live requests correctly
- [ ] Ctrl-C stops tunnel and exits cleanly
- [ ] `hoist rm` with stale PID works
- [ ] Credential expiry message is clear
- [ ] install.sh script tested on all three platforms
- [ ] README accurate: install command, init steps, command reference
- [ ] GitHub repo visibility: keep private or make public (decision required)
- [ ] Log rotation: truncate `cloudflared.log` on tunnel start if >10MB (prevents unbounded growth)

### Versioning

`v1.0.0` — semantic versioning from here. Binary embeds version string, printed via `hoist --version`.

### Post-v1.0 backlog (out of scope for v1.0)

- Custom domain for install URL (hoist.sh or gethoist.dev)
- Windows support (requires different install mechanism)
- Auto-restart on tunnel crash
- `hoist update` command (self-update via GitHub releases API)
- `hoist init --token <api-token>` (non-interactive auth for CI environments)
- Linux arm64 binary

---

## Open questions

1. **Public vs private repo** — Does hoist ship as open source? Affects whether install.sh can use `github.com/simonreed/hoist` or needs a different distribution host.

2. **cloudflared version policy** — How to handle cloudflared updates? Options: (a) pin version and update manually on each hoist release, (b) check for updates on `hoist init` and warn if cloudflared is outdated.

3. **Tunnel name collision** — Auto-generated tunnel name (`simonreed-hoist`) may already exist if user ran `cloudflared tunnel create` manually. Phase 4 handles this with `-2` suffix retry but UX could be cleaner.

4. **Multiple domains** — Current design assumes one domain per hoist install. If a user wants `passflow.simonreed.co` AND `api.myotherdomain.com`, they'd need two hoist inits. Worth noting as a known limitation, not a v1.0 feature.

5. **Multiple domains** — Current design assumes one domain per hoist install. Known v1.0 limitation. Not addressed further here.
