#!/usr/bin/env sh
# Start the collaboration server. The log goes to the terminal and to logs/server.log.
set -e
cd "$(dirname "$0")/.."
mkdir -p logs
bun src/server/main.ts 2>&1 | tee -a logs/server.log
