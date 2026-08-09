#!/usr/bin/env bash
#
# Ask Baidu what it thinks of the IP you are running this from.
#
# Baidu never reports an IP ban in the console — the console shows account
# state (App ID, credits, service status) and a ban is not account state. The
# only place the ban is ever stated is in the API response body, which is what
# this script prints.
#
# Run it twice to settle the question in a minute:
#
#   1. From your laptop      → same App ID, a clean residential IP.
#   2. From the relay host   → the fixed IP you plan to give Baidu.
#
# Same credentials, different address. If your laptop translates fine and the
# Worker does not, the account is healthy and the address is the variable.
# Run it on the relay host before wiring it up, to be sure that IP is clean.
#
# Usage:
#   export BAIDU_APP_ID=... BAIDU_SECRET_KEY=...
#   bash check-baidu-ip.sh ["text to translate"]
#
# Set the two values with `export` (or a leading space) rather than inline, so
# the secret key does not linger in your shell history.

set -uo pipefail

APP_ID="${BAIDU_APP_ID:-}"
SECRET="${BAIDU_SECRET_KEY:-}"
TEXT="${1:-hello world}"
API="https://fanyi-api.baidu.com/api/trans/vip/translate"

# Set BAIDU_RELAY_URL (and BAIDU_RELAY_TOKEN) to send the signed request through
# the relay instead of straight to Baidu. That answers the question that
# actually matters — what Baidu makes of the *relay's* address — from your own
# laptop, and exercises the same path the worker will take: relay reachable,
# token accepted, App ID guard passed, Baidu's verdict returned.
RELAY_URL="${BAIDU_RELAY_URL:-}"
RELAY_TOKEN="${BAIDU_RELAY_TOKEN:-}"

if [ -z "$APP_ID" ] || [ -z "$SECRET" ]; then
  echo "Set BAIDU_APP_ID and BAIDU_SECRET_KEY first. See the header of this file." >&2
  exit 1
fi

# Catch unreplaced placeholders here rather than letting Baidu answer 52003 to
# them, which reads like a real account fault and sends you to the wrong page.
case "$APP_ID" in
  *[!0-9]*)
    echo "BAIDU_APP_ID is '${APP_ID}', which is not a numeric App ID." >&2
    echo "Copy the real values from 开发者信息:" >&2
    echo "  https://fanyi-api.baidu.com/manage/developer" >&2
    exit 1 ;;
esac
if [ "$SECRET" = "your-secret-key" ]; then
  echo "BAIDU_SECRET_KEY is still the placeholder. See 开发者信息:" >&2
  echo "  https://fanyi-api.baidu.com/manage/developer" >&2
  exit 1
fi

command -v openssl >/dev/null 2>&1 || { echo "openssl is required." >&2; exit 1; }

# Baidu's signature: md5(appid + q + salt + secret), over UTF-8 bytes.
salt="$(date +%s)$$"
sign="$(printf '%s' "${APP_ID}${TEXT}${salt}${SECRET}" | openssl dgst -md5 | awk '{print $NF}')"

if [ -n "$RELAY_URL" ]; then
  echo "Calling Baidu as App ID ${APP_ID} THROUGH THE RELAY at ${RELAY_URL}"
  echo "The address being tested is the relay's, not this machine's."
  echo
  body="$(curl -sS --max-time 25 -X POST "$RELAY_URL" \
    -H "X-Relay-Token: ${RELAY_TOKEN}" \
    --data-urlencode "q=${TEXT}" \
    --data "from=auto" --data "to=zh" \
    --data "appid=${APP_ID}" --data "salt=${salt}" --data "sign=${sign}")"
else
  echo "Calling Baidu as App ID ${APP_ID} directly."
  echo "Outbound IP seen by the internet: $(curl -s --max-time 10 https://ifconfig.me/ip || echo '(could not determine)')"
  echo
  body="$(curl -sS --max-time 25 -X POST "$API" \
    --data-urlencode "q=${TEXT}" \
    --data "from=auto" --data "to=zh" \
    --data "appid=${APP_ID}" --data "salt=${salt}" --data "sign=${sign}")"
fi

echo "Baidu replied:"
echo "  ${body}"
echo

# Baidu answers HTTP 200 whether it worked or not, so the body is the verdict.
code="$(printf '%s' "$body" | sed -n 's/.*"error_code"[[:space:]]*:[[:space:]]*"\{0,1\}\([A-Za-z0-9_]*\).*/\1/p')"

case "$code" in
  "")      if [ -n "$RELAY_URL" ]; then
             echo "→ Success, through the relay. Baidu accepts the relay's IP —"
             echo "  the whole path works. Wire the worker to it."
           else
             echo "→ Success. This IP can talk to Baidu with this App ID."
           fi ;;
  relay_forbidden)
           echo "→ The relay rejected the token. BAIDU_RELAY_TOKEN here must match"
           echo "  RELAY_TOKEN on the relay exactly." ;;
  relay_appid)
           echo "→ The relay refused this App ID. Its BAIDU_APP_ID does not match"
           echo "  the one used here — check 'fly secrets list' against BAIDU_APP_ID." ;;
  relay_upstream)
           echo "→ The relay could not reach Baidu at all. Check it is running." ;;
  relay_body|relay_method)
           echo "→ The relay rejected the request shape (${code}). Not a Baidu verdict." ;;
  58003)   echo "→ 58003 此IP已被封禁: this IP is banned. The account is fine — Baidu"
           echo "  bans the address, never the account, which is why the console is"
           echo "  silent. Run this from another network and it will succeed." ;;
  58000)   echo "→ 58000: this IP is not permitted. Check the IP whitelist set on the"
           echo "  App ID in 开发者信息, or clear it." ;;
  58002)   echo "→ 58002: the service is switched off for this App ID in the console." ;;
  52003)   echo "→ 52003 UNAUTHORIZED USER: wrong App ID, or the general translate API"
           echo "  is not enabled on it. This one IS visible in the console." ;;
  54001)   echo "→ 54001: signature error — App ID and secret key do not match." ;;
  54003)   echo "→ 54003: rate limited (QPS). Wait and retry; not a ban." ;;
  54004)   echo "→ 54004: account balance insufficient. Visible in the console." ;;
  54005)   echo "→ 54005: long queries sent too fast. Wait and retry; not a ban." ;;
  52001|52002)
           echo "→ ${code}: transient timeout/system error on Baidu's side. Retry." ;;
  *)       echo "→ error_code ${code}: see https://fanyi-api.baidu.com/doc/21" ;;
esac
