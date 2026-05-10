#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

# ── Colors ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# ── Help ──
if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
    echo "Usage: bash scripts/publish.sh [patch|minor|major]"
    echo ""
    echo "  patch  0.1.0 → 0.1.1  (bug fixes)"
    echo "  minor  0.1.0 → 0.2.0  (new features, backwards-compatible)  [default]"
    echo "  major  0.1.0 → 1.0.0  (breaking changes)"
    echo ""
    echo "Flow:"
    echo "  1. Bump version in package.json & pyproject.toml"
    echo "  2. Git commit + tag"
    echo "  3. Build native binary for current platform"
    echo "  4. Create GitHub Release with binary attached"
    echo "  5. Publish to npm"
    exit 0
fi

BUMP="${1:-minor}"

if [ "$BUMP" != "patch" ] && [ "$BUMP" != "minor" ] && [ "$BUMP" != "major" ]; then
    echo -e "${RED}Error: bump must be 'patch', 'minor', or 'major'${NC}"
    exit 1
fi

# ── 0. Pre-flight checks ──

if [ -n "$(git status --porcelain)" ]; then
    echo -e "${RED}Error: working tree is not clean. Commit or stash changes first.${NC}"
    exit 1
fi

if ! command -v npm &>/dev/null; then
    echo -e "${RED}Error: npm not found${NC}"
    exit 1
fi

if ! command -v gh &>/dev/null; then
    echo -e "${RED}Error: GitHub CLI (gh) not found. Install: brew install gh${NC}"
    exit 1
fi

# ── 1. Bump version ──

OLD_VERSION=$(node -p "require('./package.json').version")
npm version "$BUMP" --no-git-tag-version 2>/dev/null
NEW_VERSION=$(node -p "require('./package.json').version")

# Sync to pyproject.toml
if [ "$(uname)" = "Darwin" ]; then
    sed -i '' "s/version = \"${OLD_VERSION}\"/version = \"${NEW_VERSION}\"/" pyproject.toml
else
    sed -i "s/version = \"${OLD_VERSION}\"/version = \"${NEW_VERSION}\"/" pyproject.toml
fi

echo -e "${GREEN}Bumped version: ${OLD_VERSION} → ${NEW_VERSION}${NC}"

# ── 2. Git commit + tag ──

git add package.json pyproject.toml
git commit -m "chore: bump version to v${NEW_VERSION}"
git tag "v${NEW_VERSION}"

echo -e "${GREEN}Created tag: v${NEW_VERSION}${NC}"

# ── 3. Build binary for current platform ──

PLATFORM=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$ARCH" in
    arm64|aarch64) ARCH="arm64" ;;
    x86_64)        ARCH="x64" ;;
    *)             echo -e "${RED}Unknown arch: $ARCH${NC}"; exit 1 ;;
esac

BINARY_NAME="claude-orchestrator-${PLATFORM}-${ARCH}"

echo -e "${YELLOW}Building binary for ${PLATFORM}-${ARCH}...${NC}"
pip install pyinstaller --quiet
pyinstaller --onefile --name "$BINARY_NAME" cli_entry.py

echo -e "${GREEN}Built: dist/${BINARY_NAME}${NC}"

# ── 4. Push to remote ──

echo -e "${YELLOW}Pushing commit and tag...${NC}"
git push origin master
git push origin "v${NEW_VERSION}"

# ── 5. Create GitHub Release ──

echo -e "${YELLOW}Creating GitHub Release...${NC}"
gh release create "v${NEW_VERSION}" \
    "dist/${BINARY_NAME}" \
    --title "v${NEW_VERSION}" \
    --notes "Release v${NEW_VERSION}" \
    --repo adamancyzhang/claude-orchestrator-server

echo -e "${GREEN}GitHub Release created with ${BINARY_NAME}${NC}"

# ── 6. Publish to npm ──

echo -e "${YELLOW}Publishing to npm...${NC}"
npm publish --access public

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  Published v${NEW_VERSION} to npm${NC}"
echo -e "${GREEN}  https://www.npmjs.com/package/@adamancyzhang/claude-orchestrator${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${YELLOW}Note: only ${PLATFORM}-${ARCH} binary was built.${NC}"
echo -e "${YELLOW}For other platforms, build and upload manually or set up CI.${NC}"
echo ""
echo -e "  macOS x64:   bash scripts/build-binary.sh (on Intel Mac)"
echo -e "  Linux x64:   bash scripts/build-binary.sh (on Linux x64)"
echo -e "  Then:        gh release upload v${NEW_VERSION} dist/<binary-name>"
