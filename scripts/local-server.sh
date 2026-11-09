#!/bin/bash
# Start the built server on 127.0.0.1. `next start` refuses output: standalone.
# Data and bops.local.json stay in the repo. The standalone folder's cwd is not used for them.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
if [[ ! -f "$root/.next/standalone/server.js" ]]; then
  echo "Build first: npx next build" >&2
  exit 1
fi
rm -rf "$root/.next/standalone/.data" "$root/.next/standalone/bops.local.json"
mkdir -p "$root/.next/standalone/.next" "$root/.data"
rm -rf "$root/.next/standalone/.next/static" "$root/.next/standalone/public"
cp -R "$root/.next/static" "$root/.next/standalone/.next/static"
if [[ -d "$root/public" ]]; then cp -R "$root/public" "$root/.next/standalone/public"; fi
export BOPS_REPO_ROOT="$root"
export BOPS_DATA_DIR="$root/.data"
export BOPS_LOCAL_CONFIG="$root/bops.local.json"
export BOPS_CLOUD_HOME="$root/.data"
export HOSTNAME=127.0.0.1
export PORT="${PORT:-3210}"
cd "$root/.next/standalone"
exec node server.js
