#!/bin/sh
# Creates vendor/cloudflared stub so static imports resolve in dev/test mode.
# The real binary is downloaded by scripts/download-cloudflared.sh

set -e
mkdir -p vendor

if [ ! -f vendor/cloudflared ]; then
  cat > vendor/cloudflared << 'STUB'
#!/bin/sh
echo "hoist: cloudflared not bundled — run: bun run download-cloudflared" >&2
exit 1
STUB
  chmod +x vendor/cloudflared
  echo "setup: created vendor/cloudflared stub"
fi
