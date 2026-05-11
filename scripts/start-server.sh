#!/bin/bash
set -e
cd "$(dirname "$0")/.."
echo "Starting Claude Orchestrator Server..."
node dist/index.js server
