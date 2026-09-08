#!/usr/bin/env bash
# Build the Windows installer and drop it in ~/Downloads.
#
# electron-builder writes into dist/ as usual — only the two shippable .exe
# files are copied out. The unpacked app dir and the blockmap stay behind in
# dist/ rather than cluttering Downloads.
set -euo pipefail

cd "$(dirname "$0")/.."

DEST="${BUILD_DEST:-$HOME/Downloads}"
VERSION="$(node -p "require('./package.json').version")"
NAME="$(node -p "require('./package.json').build.productName")"

echo "==> Building ${NAME} ${VERSION} for Windows x64"
pnpm exec electron-builder --win

mkdir -p "$DEST"

# Versioned, space-free names — easier to hand to someone over chat.
cp "dist/${NAME} Setup ${VERSION}.exe" "${DEST}/PrintEasy-Setup-${VERSION}-x64.exe"
cp "dist/${NAME} ${VERSION}.exe"       "${DEST}/PrintEasy-Portable-${VERSION}-x64.exe"

echo
echo "==> Done. In ${DEST}:"
ls -lh "${DEST}/PrintEasy-Setup-${VERSION}-x64.exe" "${DEST}/PrintEasy-Portable-${VERSION}-x64.exe" \
  | awk '{printf "    %-8s %s\n", $5, $NF}'
