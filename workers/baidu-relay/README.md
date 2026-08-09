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

The worker calls the relay over HTTPS, so `docker-compose.yml` runs the relay
behind Caddy, which obtains and renews the certificate by itself. Point a
**DNS-only (grey cloud)** A record — say `relay.lingonect.com` — at the box
first, and open ports 80 and 443. Grey cloud matters: proxying it through
Cloudflare would put Cloudflare back in the path.

```bash
scp -r workers/baidu-relay youruser@yourhost:~/baidu-relay
ssh youruser@yourhost
cd ~/baidu-relay

cp .env.example .env
openssl rand -hex 32          # paste into RELAY_TOKEN, keep it for the worker
nano .env                     # set RELAY_DOMAIN, RELAY_TOKEN, BAIDU_APP_ID

docker compose up -d
curl https://relay.lingonect.com/healthz     # expect: ok
```

`.env` is gitignored and holds the shared token. Note that the Baidu **secret
key never comes here** — it stays in the Cloudflare worker. The relay only
needs the App ID, to reject anything that is not ours.

### Option B — Fly.io

The IP that matters here is the **egress** one. Fly's `fly ips allocate-v4`
buys a dedicated *ingress* address, which is a different thing and does nothing
for us: Fly's docs are explicit that inbound anycast addresses "are not used
for outbound connections made from within a Machine". By default outbound
traffic leaves through a shared NAT pool that rotates — the same class of
problem as Cloudflare, just a smaller pool. Allocate a **static egress IP**:

```bash
cd workers/baidu-relay
fly launch --no-deploy --copy-config --name lingonect-baidu-relay
fly secrets set RELAY_TOKEN="<a long random string>" BAIDU_APP_ID="<App ID>"
fly deploy

fly machines list                       # note the machine ID
fly machine egress-ip allocate <machine-id>
```

That costs about $0.005/hour (~$3.60/month). An app-scoped alternative,
`fly ips allocate-egress`, survives machines being recreated by a redeploy,
where a machine-scoped one may not — worth preferring if your flyctl has it.

You do **not** need a dedicated ingress IPv4 ($2/mo) as well; the free shared
one is fine for reaching the relay.

`fly.toml` keeps one machine always running, because a machine that stops and
restarts can come back behind a different address. Keep it at exactly one
machine — Fly creates two by default for high availability, and two machines
mean two egress addresses, which is the "one App ID, many addresses" trigger.

Verify the egress address afterwards regardless: some users report outbound
traffic still leaving over IPv6, or not using the allocated address at all.

### Verify the egress IP before telling Baidu about it

The address the host *receives* traffic on is not always the one it *sends*
from. Check the sending address from inside the running container, and check it
again after a restart:

```bash
docker compose exec relay wget -qO- https://ifconfig.me/ip   # VPS
fly ssh console -C "wget -qO- https://ifconfig.me/ip"     # Fly
```

If the two answers differ, the host is not giving you a fixed egress IP — move
to Option A.

Then confirm Baidu is happy with that address *before* wiring the worker to it.
Do this **from your laptop, through the relay** — the image carries only
`server.js`, so there is no shell to run the diagnostic in on the box, and
going through the relay tests the real path anyway: reachability, the token,
the App ID guard, and Baidu's verdict on the relay's address.

```bash
export BAIDU_APP_ID=... BAIDU_SECRET_KEY=...
export BAIDU_RELAY_URL=https://your-relay/translate
export BAIDU_RELAY_TOKEN=...
bash check-baidu-ip.sh
unset BAIDU_APP_ID BAIDU_SECRET_KEY BAIDU_RELAY_TOKEN
```

A successful translation means this IP is clean and you can skip the Baidu
email entirely. A 58003 means you inherited someone else's ban — see "If Baidu
never replies" below; reassigning the address is usually quicker than asking.

One thing to check in the console while you are there: if a **server IP
whitelist** is configured against the App ID in 开发者信息, the relay's address
has to be added to it, or Baidu answers 58000 instead.

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

## Ask Baidu to whitelist the address (optional)

**This step is insurance, not the fix.** The relay is the fix: a dedicated
address carrying exactly one App ID cannot meet either ban condition, so it
should never earn a 58003 of its own. The email matters in one narrow case —
the address you were assigned was *already* banned before you got it, because
a previous tenant abused it.

You can check for that case before it costs you anything: run
`check-baidu-ip.sh` **on the host**, before pointing the worker at it. A clean
answer there means you never need to write to anyone.

If the address does turn out to be dirty, mail **translate_api@baidu.com**.
Send every field they ask for — their FAQ warns that incomplete information
hurts the review — and write it in Chinese; `unban-email-template.md` in this
directory is ready to fill in and send.

### If Baidu never replies

Very likely you will not need them to, because **58003 expires on its own**.
Baidu's own wording is 次日解封 — banned for the day, released the next. The
reason ours never cleared is that Cloudflare's shared pool kept re-triggering
it around the clock. On a dedicated address carrying one App ID there is
nothing left to re-trigger it, so an inherited ban simply ages out, typically
within a day. The email only saves you that wait.

So if the queue stays silent:

1. **Wait 24–48 hours and re-run `check-baidu-ip.sh`.** Nothing is re-arming
   the ban any more, so it should lapse by itself.
2. **If it is still banned, change the address.** The ban is on an IP, and IPs
   are cheap and fungible — swapping one is far quicker than any support
   queue, and needs nobody's permission:

   ```bash
   fly ips release <old-ip> && fly ips allocate-v4     # Fly
   ```

   On a VPS, detach and attach a new floating IP, or rebuild the box (a
   different region gives you a different pool). Re-run `check-baidu-ip.sh`
   after each change and keep the first address that answers cleanly.
3. **Only then chase the email**, and treat a reply as a bonus.

There is no scenario here where a silent support queue leaves Baidu broken.
The worst case is a day's wait or a few minutes' work reassigning an address.
