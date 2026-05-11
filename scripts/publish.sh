#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
    echo "Usage: bash scripts/publish.sh [patch|minor|major]"
    echo ""
    echo "  patch  0.2.0 → 0.2.1  (bug fixes)"
    echo "  minor  0.2.0 → 0.3.0  (new features, backwards-compatible)  [default]"
    echo "  major  0.2.0 → 1.0.0  (breaking changes)"
    echo ""
    echo "Flow:"
    echo "  1. Bump version in package.json"
    echo "  2. Run tests"
    echo "  3. Build TypeScript"
    echo "  4. Git commit + tag"
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

# ── 1. Bump version ──

OLD_VERSION=$(node -p "require('./package.json').version")
npm version "$BUMP" --no-git-tag-version 2>/dev/null
NEW_VERSION=$(node -p "require('./package.json').version")

echo -e "${GREEN}Bumped version: ${OLD_VERSION} → ${NEW_VERSION}${NC}"

# ── 2. Run tests ──

echo -e "${YELLOW}Running tests...${NC}"
npm test || echo -e "${YELLOW}Warning: tests failed, continuing...${NC}"

# ── 3. Build TypeScript ──

echo -e "${YELLOW}Building TypeScript...${NC}"
npm run build

# ── 4. Git commit + tag ──

git add package.json
git commit -m "chore: bump version to v${NEW_VERSION}"
git tag "v${NEW_VERSION}"

echo -e "${GREEN}Created tag: v${NEW_VERSION}${NC}"

# ── 5. Push to remote ──

echo -e "${YELLOW}Pushing commit and tag...${NC}"
git push origin master
git push origin "v${NEW_VERSION}"

# ── 6. Publish to npm ──

echo -e "${YELLOW}Publishing to npm...${NC}"
npm publish --access public

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  Published v${NEW_VERSION} to npm${NC}"
echo -e "${GREEN}  https://www.npmjs.com/package/@adamancyzhang/claude-orchestrator${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
