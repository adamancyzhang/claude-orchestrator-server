#!/bin/bash
set -e
cd "$(dirname "$0")/.."

echo "============================================"
echo " Claude Orchestrator v0.3.0 Workspace Tests"
echo "============================================"
echo ""

# Build the latest dist
echo "--- Building dist ---"
npm run build
echo ""

# Run each scenario in a separate process with isolated ZK root path
TESTS_DIR="workspace-tests/scenarios"
PASS_COUNT=0
FAIL_COUNT=0
TOTAL_COUNT=0

for test_file in "$TESTS_DIR"/*.test.js; do
  if [ ! -f "$test_file" ]; then
    continue
  fi
  TOTAL_COUNT=$((TOTAL_COUNT + 1))
  test_name=$(basename "$test_file" .test.js)

  echo "--- Running: $test_name ---"
  # Set ZK_ROOT_PATH via env var so it's available BEFORE ESM imports evaluate
  if ZK_ROOT_PATH="/workspace-test-${test_name}-$$" node "$test_file"; then
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
  echo ""
done

echo "============================================"
echo " Results: $PASS_COUNT passed, $FAIL_COUNT failed, $TOTAL_COUNT total"
echo "============================================"

if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
