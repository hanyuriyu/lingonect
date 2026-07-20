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
