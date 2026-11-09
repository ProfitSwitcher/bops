#!/bin/bash
# Start the built server on 127.0.0.1. `next start` refuses output: standalone.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ ! -f .next/standalone/server.js ]]; then
  echo "Build first: npx next build" >&2
  exit 1
fi
mkdir -p .next/standalone/.next
rm -rf .next/standalone/.next/static .next/standalone/public
cp -R .next/static .next/standalone/.next/static
if [[ -d public ]]; then cp -R public .next/standalone/public; fi
export HOSTNAME=127.0.0.1
export PORT="${PORT:-3210}"
exec node .next/standalone/server.js
