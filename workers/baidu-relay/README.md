# Baidu relay — why it exists and how to deploy it

## The problem

Baidu Translate answers **HTTP 200** even when it fails, putting the reason in
the body. The body we have been getting is:

```json
{ "error_code": "58003", "error_msg": "..." }
```

`58003` is **此IP已被封禁** — *this IP has been banned*. Baidu's risk control
bans an **IP address**, not an account, as soon as it sees several different
App IDs sending translations from that address on the same day. The ban lifts
overnight and is re-applied the moment it happens again.

Cloudflare Workers do not have their own egress addresses — a `fetch()` from a
Worker leaves through Cloudflare's shared pool, which a great many other people
also proxy Baidu Translate through, each with their own App ID. So Baidu counts
all of those App IDs against the address our request happens to leave from, and
bans it. We then inherit a ban we did not earn.

This explains every symptom exactly:

- The Baidu console shows a healthy, paid account with credits remaining — the
  ban is on an IP, so there is nothing to see there.
- No amount of checking keys, quotas or billing changes anything.
- It is not caused by the iOS work. That change only rewrote the
  `Access-Control-Allow-Origin` *response* header to admit
  `capacitor://localhost`; response headers cannot influence what Baidu sees.
  The timing was a coincidence.

## The fix

Give the Baidu call a **fixed egress IP that only ever carries our App ID**.

`baidu-worker.js` keeps doing everything it does today — Firebase auth, quota
accounting, CORS, MD5 signing. The only change is where the signed request
goes: if `BAIDU_RELAY_URL` is set, it is forwarded through this relay; if not,
the worker calls Baidu directly, exactly as before. Nothing breaks while the
relay does not exist yet.

The relay refuses any request whose `appid` is not ours, so a single App ID can
ever leave that address. That is what keeps the new IP out of the 58003 trap
permanently — and it gives Baidu a specific address to whitelist.

## Deploy

Any host with a **stable outbound IP** works. What matters is not the provider
but that the address does not change and is not shared with strangers calling
Baidu. Serverless platforms with pooled egress (Vercel, Deno Deploy, Render,
Railway) reproduce the original problem — do not use them.

### Option A — a small VPS (surest bet)

Any €4–6/month box (Hetzner, DigitalOcean, Vultr) has a dedicated static IP.
Pick a region near the API — Singapore, Tokyo or Hong Kong — since
`fanyi-api.baidu.com` is in China.

```bash
scp -r workers/baidu-relay youruser@yourhost:~/baidu-relay
ssh youruser@yourhost
cd ~/baidu-relay
docker build -t baidu-relay .
docker run -d --restart=always -p 8080:8080 \
  -e RELAY_TOKEN="<a long random string>" \
  -e BAIDU_APP_ID="<our numeric App ID>" \
  --name baidu-relay baidu-relay
```

Put it behind TLS (Caddy, nginx + certbot, or Cloudflare in front of a
subdomain) so the worker can reach it over HTTPS.

### Option B — Fly.io

```bash
cd workers/baidu-relay
fly launch --no-deploy --copy-config --name lingonect-baidu-relay
fly ips allocate-v4                     # a dedicated IPv4, not the shared one
fly secrets set RELAY_TOKEN="<a long random string>" BAIDU_APP_ID="<App ID>"
fly deploy
```

`fly.toml` keeps one machine always running, because a machine that stops and
restarts can come back behind a different address.

### Verify the egress IP before telling Baidu about it

The address the host *receives* traffic on is not always the one it *sends*
from. Check the sending address from inside the running container, and check it
again after a restart:

```bash
docker exec baidu-relay wget -qO- https://ifconfig.me   # VPS
fly ssh console -C "wget -qO- https://ifconfig.me"      # Fly
```

If the two answers differ, the host is not giving you a fixed egress IP — move
to Option A.

## Wire the worker to the relay

```bash
cd workers/wrangler
wrangler secret put BAIDU_RELAY_URL   -c baidu.toml   # https://your-relay/translate
wrangler secret put BAIDU_RELAY_TOKEN -c baidu.toml   # same string as RELAY_TOKEN
wrangler deploy -c baidu.toml
```

Confirm it took effect — Baidu's real error code is logged by the worker:

```bash
wrangler tail -c baidu.toml
```

A working call logs nothing; a failing one logs
`Baidu error_code=… (via relay)`, which also tells you the relay is in the path.

To roll back to the old direct behaviour, delete the two secrets and redeploy.

## Ask Baidu to whitelist the address

Once the egress IP is fixed and verified, mail **translate_api@baidu.com** and
ask them to lift the ban and register the address. They ask for:

- company name
- product name (Lingonect)
- contact person and contact details
- **server IP** (the verified egress address)
- **APPID**

They reply and lift the ban after checking. This step is not strictly required
— a dedicated IP carrying one App ID should never trip 58003 in the first place
— but it stops a stale ban on a recycled address from biting on day one.
