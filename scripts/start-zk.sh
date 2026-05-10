#!/bin/bash
set -e
cd "$(dirname "$0")/.."
echo "Starting ZooKeeper..."
docker-compose up -d
echo "Waiting for ZooKeeper to be ready..."
until echo ruok | nc -w1 127.0.0.1 2181 2>/dev/null | grep -q imok; do
  sleep 1
done
echo "ZooKeeper is ready."
