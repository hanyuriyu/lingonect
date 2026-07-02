#!/usr/bin/env bash
# Deploy every worker. Run from the repo root: bash workers/wrangler/deploy-all.sh
set -euo pipefail
cd "$(dirname "$0")"
for cfg in *.toml; do
  echo "=== Deploying $cfg ==="
  wrangler deploy -c "$cfg"
done
echo "All workers deployed."
