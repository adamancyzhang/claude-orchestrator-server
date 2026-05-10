#!/bin/bash
set -e
cd "$(dirname "$0")/.."
echo "Stopping ZooKeeper..."
docker-compose down
echo "All services stopped."
