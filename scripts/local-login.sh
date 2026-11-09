#!/bin/bash
# Worker and server for a login item. Both stay on 127.0.0.1. Not installed by itself.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
export BOPS_WORKER_BIND=127.0.0.1
export BOPS_WORKER_PORT="${BOPS_WORKER_PORT:-8791}"
if ! curl -sf "http://127.0.0.1:${BOPS_WORKER_PORT}/health" >/dev/null; then
  node workers/bops-local-worker.mjs >>"$root/.data/worker.log" 2>&1 &
fi
exec bash scripts/local-server.sh
