#!/bin/sh
# Downloads the cloudflared binary for the current platform into vendor/cloudflared.
# Run this before building the standalone executable.
#
# Usage: bun run download-cloudflared

set -e

BASE="https://github.com/cloudflare/cloudflared/releases/latest/download"

OS=$(uname -s)
ARCH=$(uname -m)

mkdir -p vendor
TMPDIR_LOCAL=$(mktemp -d)

case "${OS}-${ARCH}" in
  Darwin-arm64)
    echo "Downloading cloudflared (latest) for Darwin arm64..."
    curl -fsSL "${BASE}/cloudflared-darwin-arm64.tgz" -o "${TMPDIR_LOCAL}/cf.tgz"
    tar -xzf "${TMPDIR_LOCAL}/cf.tgz" -C "${TMPDIR_LOCAL}"
    cp "${TMPDIR_LOCAL}/cloudflared" vendor/cloudflared
    ;;
  Darwin-x86_64)
    echo "Downloading cloudflared (latest) for Darwin x86_64..."
    curl -fsSL "${BASE}/cloudflared-darwin-amd64.tgz" -o "${TMPDIR_LOCAL}/cf.tgz"
    tar -xzf "${TMPDIR_LOCAL}/cf.tgz" -C "${TMPDIR_LOCAL}"
    cp "${TMPDIR_LOCAL}/cloudflared" vendor/cloudflared
    ;;
  Linux-x86_64)
    echo "Downloading cloudflared (latest) for Linux x86_64..."
    curl -fsSL "${BASE}/cloudflared-linux-amd64" -o vendor/cloudflared
    ;;
  *)
    echo "Unsupported platform: ${OS}-${ARCH}" >&2
    rm -rf "${TMPDIR_LOCAL}"
    exit 1
    ;;
esac

rm -rf "${TMPDIR_LOCAL}"
chmod +x vendor/cloudflared
echo "Done: vendor/cloudflared ($(du -sh vendor/cloudflared | cut -f1))"
