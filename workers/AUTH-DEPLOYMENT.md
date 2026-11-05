# Worker authentication — deployment notes

## What changed and why

Previously the Cloudflare Workers only set `Access-Control-Allow-Origin:
https://www.lingonect.com`. CORS is enforced by **browsers only** — it does
nothing against a direct HTTP call. Anyone who discovered a worker URL (e.g.
`claudetranslate.hanyuriyu.workers.dev`) could `curl` it and spend our
Anthropic / OpenAI / DeepL / etc. credits.

Every worker now requires a valid **Firebase ID token** on each request:

- Frontend (`engines.html`, `flashcards.html`, `seed-ratings.html`) sends
  `Authorization: Bearer <idToken>` via the new `workerFetch()` helper, which
  pulls the token from `auth.currentUser.getIdToken()`.
- Each worker verifies the RS256 JWT against Google's public keys
  (`securetoken@system` JWK endpoint) and checks the standard claims:
  `aud === "lingonect-4db51"`, the matching `iss`, `exp` not expired, a sane
  `iat`, and `email_verified === true` (mirrors the app's own login gate).
  Invalid/missing token → `401 Unauthorized`, before any upstream API call.

Public keys are cached in-isolate per the endpoint's `Cache-Control`, so the
JWKS fetch does not run on every request.

## Rollout ordering (important)

The OPTIONS preflight now advertises `Access-Control-Allow-Headers:
Content-Type, Authorization`. A browser will **block** a request that sends the
`Authorization` header if the (live) worker's preflight doesn't allow it.

Therefore deploy in this order:

1. **Redeploy all 23 workers to Cloudflare first** (or at the same time as the
   site). Each worker is still a single self-contained file — paste/deploy as
   before; no new secrets or env vars are needed.
2. **Then** publish the frontend (merge this branch). Pushing the frontend
   alone, while the live workers are the old version, would break translation
   until the workers are updated.

Because this branch isn't the GitHub Pages source, nothing goes live until you
merge — so redeploy the workers around merge time.

## Not auth, but recommended (no code here)

For defense in depth against a compromised/abusive *logged-in* account, add a
Cloudflare **Rate Limiting** rule per worker route in the dashboard. That's
configuration, not code, so it isn't part of this change.

## Deploying a worker without a desktop

`workers/wrangler/deploy-all.sh` needs a machine with wrangler on it. When you
only have a phone or tablet, use CI instead: **Actions > Deploy workers > Run
workflow**, and give it the worker name (a `workers/wrangler/*.toml` name
without the extension — `together`, `kimi`, …) or `all`.

Two things have to be in place first:

1. The `CLOUDFLARE_API_TOKEN` repository secret (Settings > Secrets and
   variables > Actions). Create the token in the Cloudflare dashboard under
   My Profile > API Tokens with the **Edit Cloudflare Workers** template. Add
   `CLOUDFLARE_ACCOUNT_ID` too if that token can reach several accounts.
2. `.github/workflows/workers.yml` on `main` — GitHub only offers "Run
   workflow" for workflows on the default branch. The run itself can still
   target any branch.

A deploy uploads the worker code and the `[vars]` from its `.toml`. It does not
touch worker **secrets** (`TOGETHER_API_KEY`, `KIMI_API_KEY`, …), which stay as
Cloudflare holds them. It does overwrite `[vars]`, so a value edited in the
dashboard — `KIMI_MODEL`, say — goes back to what the `.toml` says: change it
there as well, or the next deploy reverts it.

## Cost guard, usage log and per-IP limits

A valid login is not enough on its own: before this, any logged-in caller
could pick the model, the prompt size and the answer length, and so use a
worker as an open AI API on our bill. Every worker now runs
`__applyCostGuard` before the quota block:

- **Model allow-list** (`__LIMITS.models`). Any other model id is swapped for
  the worker's default model rather than refused, so old app builds still get
  an answer. When `engines.html` switches a model, add the new id to that
  worker's `__LIMITS` too, or it will quietly be replaced by the default.
- **Output cap** (`maxOutputTokens`), sized from the largest real call:
  Claude 12000 (Contextualize, romanized), OpenAI and DeepSeek 8192
  (flashcard batches), Kimi 8192, the other LLMs 4096. Gemini has a
  `maxOutputTokens` of 8192 in its own payload.
- **Input cap** (`maxBodyChars`): Claude 400k characters (Contextualize and
  Triangulate merges carry every engine's answer), OpenAI 200k, other LLMs
  100k, plain translation APIs 20k, OpenAI TTS 6k. Larger → `413`.
- **Field allow-list** (`keys`) on the workers that forward the body whole
  (Claude, OpenAI, Perplexity): e.g. tools / web search, `n` are dropped.
  Perplexity's `search_context_size: "high"` is lowered to `"medium"`.

Every request writes one JSON log line (`"lingonect": "request"`) with uid,
email, IP, country, origin, model and size. Read them in Cloudflare →
Workers & Pages → (worker) → Logs, and filter on `email` or `uid` to see who
is spending.

Quota changes:

- A user with no Firestore profile used to count as "legacy" (1000/day). Now
  the worker asks Firebase Auth when the account was created: on/after the
  cutoff → "free" (500 lifetime), before → "legacy".
- Per-IP ceiling across all accounts: `IP_DAILY_MAX` (default 5000/day).
- Anonymous users (free engines in the apps) are also capped per IP:
  `ANON_DAILY_PER_IP` (default 300/day).

The anonymous-origin check can still be faked by a script (it only stops
browsers); the per-IP and the shared `ANON_DAILY_TOTAL` ceilings bound it.
Firebase App Check would be the full fix.
