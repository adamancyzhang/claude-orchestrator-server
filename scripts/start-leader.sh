#!/bin/bash
set -e
cd "$(dirname "$0")/.."
echo "Starting Claude Orchestrator Leader (v0.3.0)..."
node dist/index.js leader
