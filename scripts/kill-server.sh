#!/usr/bin/env sh
# Fault injection: stop the server with SIGKILL (a crash: no clean shutdown, no flush).
# Local process:  sh scripts/kill-server.sh
# Docker:         sh scripts/kill-server.sh docker
set -e
cd "$(dirname "$0")/.."
if [ "$1" = "docker" ]; then
  docker compose -f deploy/docker-compose.yml kill -s SIGKILL server
  echo "Server container killed. Start it again: docker compose -f deploy/docker-compose.yml start server"
  exit 0
fi
PIDS=$(pgrep -f "bun src/server/main.ts" || true)
if [ -z "$PIDS" ]; then
  echo "No server process found."
  exit 1
fi
kill -9 $PIDS
echo "Killed server process(es): $PIDS. Start it again: sh scripts/start-server.sh"
