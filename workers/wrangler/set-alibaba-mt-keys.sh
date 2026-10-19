#!/usr/bin/env bash
# Store the Alibaba Cloud Machine Translation AccessKey pair on the "alibaba"
# worker, then deploy it.
# Run from the repo root:  bash workers/wrangler/set-alibaba-mt-keys.sh
#
# The keys are typed at a hidden prompt and piped straight to Cloudflare, so
# they never land in a file, in the repo or in your shell history.
set -euo pipefail
cd "$(dirname "$0")"

read -rsp "Alibaba AccessKey ID (LTA…): " key_id; echo
read -rsp "Alibaba AccessKey Secret: " key_secret; echo
if [ -z "$key_id" ] || [ -z "$key_secret" ]; then
  echo "Both values are required — nothing was changed."
  exit 1
fi

printf '%s' "$key_id"     | wrangler secret put ALIBABA_ACCESS_KEY_ID     -c alibaba.toml
printf '%s' "$key_secret" | wrangler secret put ALIBABA_ACCESS_KEY_SECRET -c alibaba.toml
unset key_id key_secret

echo ""
echo "=== Deploying alibaba ==="
yes 2>/dev/null | wrangler deploy -c alibaba.toml
echo ""
echo "Done. Alibaba Translate now uses Machine Translation once the site change is live."
