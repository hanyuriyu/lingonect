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
Worker leaves through Cloudflare's shared pool. That trips Baidu's rule in two
independent ways at once:

1. **Many App IDs, one address.** A great many other people also proxy Baidu
   Translate through Cloudflare, each with their own App ID. Baidu counts all
   of them against whichever address our request leaves from, and bans it. We
   inherit a ban we did not earn.
2. **One App ID, many addresses.** Baidu also bans when a single App ID is seen
   hopping between addresses during a day. Worker requests egress from whatever
   Cloudflare location served them, so our traffic looks like exactly that.

Either one alone is enough. Both together are why this is constant rather than
occasional, and why it does not clear itself overnight.

This explains every symptom exactly:

- The Baidu console shows a healthy, paid account with credits remaining. The
  ban is on an address, and an address is not account state, so there is no
  place in the console for it to appear — see below.
- No amount of checking keys, quotas or billing changes anything.
- It is not caused by the iOS work. That change only rewrote the
  `Access-Control-Allow-Origin` *response* header to admit
  `capacitor://localhost`; response headers cannot influence what Baidu sees.
  The timing was a coincidence.

## Why the console never mentions it

The console reports things that belong to the account: App ID and key, whether
the service is switched on, usage and credits. A ban on an IP address belongs
to none of those, and Baidu exposes no screen for it — the ban is stated only
in the API response body, as `error_code 58003`.

The strongest evidence that there is no console surface is Baidu's own remedy:
their FAQ tells you to **email translate_api@baidu.com** with your company
name, product name, contact details, **server IP** and **APPID** to have a ban
lifted. If it were account state, it would be a screen and a button, not a
human queue you have to write to and quote your server IP at.

So "the platform doesn't say I'm banned" is the expected observation, not
evidence against. To see the ban stated directly, run `check-baidu-ip.sh`
(below) from two different networks.

## Confirm it yourself in a minute

`check-baidu-ip.sh` sends one correctly signed request and prints Baidu's raw
answer plus the outbound IP it came from:

```bash
export BAIDU_APP_ID=...      # leading space or export, so it stays out of history
export BAIDU_SECRET_KEY=...
bash check-baidu-ip.sh
```

Run it **from your laptop** and then **from the relay host**. Same credentials,
different address, so the address is the only variable. A laptop that
translates fine while the Worker fails proves the account is healthy and the
egress address is the problem. Run it on any host before you point the worker
at it, to be sure that IP is clean to begin with.

You can also read the code straight out of the live site with no setup at all:
open lingonect.com, DevTools → Network → the `baidu.hanyuriyu.workers.dev`
request → Response. The worker passes Baidu's body through untouched, so the
`error_code` is right there.

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
