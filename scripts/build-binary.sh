#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

PLATFORM=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$ARCH" in
    arm64|aarch64) ARCH="arm64" ;;
    x86_64)        ARCH="x64" ;;
    *)             echo "Unknown arch: $ARCH"; exit 1 ;;
esac

BINARY_NAME="claude-orchestrator-${PLATFORM}-${ARCH}"

echo "Building for ${PLATFORM}-${ARCH}..."
pip install pyinstaller --quiet
pyinstaller --onefile --name "$BINARY_NAME" cli_entry.py

echo "Binary built: dist/${BINARY_NAME}"
ls -lh "dist/${BINARY_NAME}"

echo ""
echo "To create a GitHub Release:"
echo "  gh release create v0.1.0 dist/${BINARY_NAME}"
echo ""
echo "Or to test locally:"
echo "  dist/${BINARY_NAME} --help"
