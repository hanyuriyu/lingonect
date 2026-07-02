#!/usr/bin/env bash
# Deploy every worker in one pass.
# Run from the repo root:  bash workers/wrangler/deploy-all.sh
#
# Runs non-interactively (auto-confirms the "local config differs from remote"
# prompt) so it doesn't stop partway. Our configs set the intended target
# (compatibility_date, observability on, KV binding), so overriding remote with
# them is expected. A single failed worker is logged and the batch continues.
cd "$(dirname "$0")"
failed=()
for cfg in *.toml; do
  echo ""
  echo "=== Deploying $cfg ==="
  if ! yes 2>/dev/null | wrangler deploy -c "$cfg"; then
    echo "!! $cfg FAILED"
    failed+=("$cfg")
  fi
done
echo ""
if [ ${#failed[@]} -eq 0 ]; then
  echo "All workers deployed."
else
  echo "Deployed, but these failed (re-run is safe): ${failed[*]}"
fi
