#!/bin/bash
set -e
cd "$(dirname "$0")/.."
pip install -e ".[dev]"
echo "Starting Claude MCP Server..."
python -m src.server
