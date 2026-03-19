#!/bin/sh
# hoist installer
# Usage: curl -fsSL https://raw.githubusercontent.com/simonreed/hoist/master/scripts/install.sh | sh

set -e

REPO="simonreed/hoist"
BIN_DIR="/usr/local/bin"
BIN_NAME="hoist"

OS=$(uname -s)
ARCH=$(uname -m)

case "${OS}-${ARCH}" in
  Darwin-arm64)  FILE="hoist-darwin-arm64" ;;
  Darwin-x86_64) FILE="hoist-darwin-x86_64" ;;
  Linux-x86_64)  FILE="hoist-linux-x86_64" ;;
  *)
    echo "Unsupported platform: ${OS}-${ARCH}" >&2
    echo "Build from source: https://github.com/${REPO}" >&2
    exit 1
    ;;
esac

URL="https://github.com/${REPO}/releases/latest/download/${FILE}"

echo "Installing hoist..."
echo "  Platform: ${OS} ${ARCH}"
echo "  Source:   ${URL}"
echo ""

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

curl -fsSL "$URL" -o "$TMP"
chmod +x "$TMP"

if [ -w "$BIN_DIR" ]; then
  mv "$TMP" "$BIN_DIR/$BIN_NAME"
else
  echo "Writing to $BIN_DIR requires sudo..."
  sudo mv "$TMP" "$BIN_DIR/$BIN_NAME"
fi

echo "Installed: $BIN_DIR/$BIN_NAME"
echo ""
echo "Next steps:"
echo "  hoist init your-domain.com"
echo "  hoist myapp 3000"
