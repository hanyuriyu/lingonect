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
# Strip spaces/newlines that sneak in with a paste.
key_id="$(printf '%s' "$key_id" | tr -d '[:space:]')"
key_secret="$(printf '%s' "$key_secret" | tr -d '[:space:]')"
if [ -z "$key_id" ] || [ -z "$key_secret" ]; then
  echo "Both values are required — nothing was changed."
  exit 1
fi

# The input is hidden, so show a masked preview: a value pasted twice shows up
# here as an unusual length (an ID is normally 24 characters, a Secret 30).
echo "ID:     ${key_id:0:4}…${key_id: -3}  (${#key_id} characters)"
echo "Secret: ${key_secret:0:3}…${key_secret: -3}  (${#key_secret} characters)"
if [ "${key_id:0:4}" != "LTAI" ]; then
  echo "Warning: an Alibaba AccessKey ID normally starts with LTAI."
fi
read -rp "Store these two values? [y/N] " ok
if [ "$ok" != "y" ] && [ "$ok" != "Y" ]; then
  echo "Nothing was changed."
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
