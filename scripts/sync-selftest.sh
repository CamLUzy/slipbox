#!/bin/bash
# LAN sync self-test: two instances of an app (or of two different apps) on this computer,
# each with its own data folder, sync over 127.0.0.1 (see tests/app-sync-*.js).
#   bash scripts/sync-selftest.sh <host app binary> [<client app binary>]
set -euo pipefail
cd "$(dirname "$0")/.."
HOST_APP="$1"
CLIENT_APP="${2:-$1}"
TMP="${RUNNER_TEMP:-$(mktemp -d)}/sync-selftest"
rm -rf "$TMP" && mkdir -p "$TMP"
# a fresh port each run: right after a run the last one may still be held by the system
PORT=$((52000 + RANDOM % 4000))
{ echo "const HOST = '127.0.0.1:$PORT';"; cat tests/app-sync-client.js; } > "$TMP/client.js"

ZK_DATA_DIR="$TMP/host" ZK_SYNC_PORT=$PORT ZK_SYNC_NO_BONJOUR=1 ZK_DEVICE_NAME=主机 \
  ZK_SELFTEST="$PWD/tests/app-sync-host.js" ZK_SELFTEST_OUT="$TMP/host.out" "$HOST_APP" > "$TMP/host.log" 2>&1 &
HOST_PID=$!
ZK_DATA_DIR="$TMP/client" ZK_SYNC_NO_BONJOUR=1 ZK_DEVICE_NAME=客户端 \
  ZK_SELFTEST="$TMP/client.js" ZK_SELFTEST_OUT="$TMP/client.out" "$CLIENT_APP" > "$TMP/client.log" 2>&1 &
CLIENT_PID=$!
# neither side may hang the run
for _ in $(seq 1 240); do [ -s "$TMP/client.out" ] && [ -s "$TMP/host.out" ] && break; sleep 1; done
kill "$HOST_PID" "$CLIENT_PID" 2>/dev/null || true

echo "client: $(cat "$TMP/client.out" 2>/dev/null || cat "$TMP/client.log")"
echo "host:   $(cat "$TMP/host.out" 2>/dev/null || cat "$TMP/host.log")"
node scripts/check-sync-selftest.mjs "$TMP/client.out" "$TMP/host.out"
