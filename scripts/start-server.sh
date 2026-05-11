#!/bin/bash
set -e
cd "$(dirname "$0")/.."
echo "Claude Orchestrator v0.3.0: MCP Server has been removed."
echo "Use 'node dist/index.js leader' to start the Leader instead."
exit 1
