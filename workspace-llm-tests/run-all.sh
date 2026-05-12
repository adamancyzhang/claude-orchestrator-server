#!/bin/bash
set -e
cd "$(dirname "$0")/.."

echo "============================================"
echo " Claude Orchestrator LLM Template Tests"
echo "============================================"
echo ""

# Build the latest dist
echo "--- Building dist ---"
npm run build
echo ""

# Initialize templates via setup
echo "--- Setting up agent templates ---"
node dist/index.js setup --name "LLM-Test" --role "builder" 2>&1
echo ""

# Verify templates exist
AGENTS_DIR=".claude-orchestrator/agents"
for t in worker-plan.md worker-build.md worker-verify.md worker-review.md worker-accept.md worker.md leader.md leader-decide.md leader-decompose.md; do
  if [ -f "$AGENTS_DIR/$t" ]; then
    echo "  OK: $t"
  else
    echo "  MISSING: $t"
  fi
done
echo ""

# Run each scenario
TESTS_DIR="workspace-llm-tests/scenarios"
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
  if node "$test_file"; then
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
