#!/usr/bin/env sh
# Concurrency demo with 3 client processes: alice, bob and carol insert at position 0 at the same time.
# Usage: DEMO_PASSWORD=<password> sh scripts/concurrent-cli.sh <docId> [server URL]
set -e
cd "$(dirname "$0")/.."
DOC="$1"
SERVER="${2:-http://localhost:3000}"
if [ -z "$DOC" ] || [ -z "$DEMO_PASSWORD" ]; then
  echo "Usage: DEMO_PASSWORD=<password> sh scripts/concurrent-cli.sh <docId> [server URL]"
  exit 2
fi
mkdir -p logs
for U in alice bob carol; do
  bun src/client/cli.ts --server "$SERVER" --user "$U" --password "$DEMO_PASSWORD" --doc "$DOC" \
    --script "sleep 1000; ins 0 [$U]; sleep 1500; wait-saved; show; quit" > "logs/cli-$U.log" 2>&1 &
done
wait
for U in alice bob carol; do
  echo "== $U"
  tail -n 2 "logs/cli-$U.log"
done
