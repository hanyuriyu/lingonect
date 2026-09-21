/**
 * Cloudflare Worker: Kimi (Moonshot AI) Translation Proxy
 *
 * Talks to Moonshot AI's own OpenAI-compatible API rather than routing Kimi
 * through Together AI. Together serves some Kimi builds only from *dedicated*
 * deployments, so a stopped deployment there fails every request with
 * "No deployments are ready to serve this endpoint" no matter which model id
 * we ask for. A direct Moonshot key removes that whole failure mode.
 *
 * Note: a Kimi consumer subscription (kimi.com) is NOT API access — the key
 * comes from the developer console and is billed separately.
 *
 * The console and the API sit on different domains, which is an easy hour to
 * lose: keys are issued at platform.kimi.ai, but calls still go to
 * api.moonshot.ai/v1. There is no api.kimi.ai endpoint.
 *
 * Regions are separate accounts: a key issued on the mainland-China platform
 * answers 401 against the international host and vice versa. Point
 * KIMI_BASE_URL at https://api.moonshot.cn/v1 for a .cn key.
 *
 * Deploy steps:
 *   1. npx wrangler secret put KIMI_API_KEY -c workers/wrangler/kimi.toml
 *   2. npx wrangler deploy -c workers/wrangler/kimi.toml
 *
 * Environment:
 *   KIMI_API_KEY      (secret, required) — key from platform.kimi.ai. The name
 *                                          MOONSHOT_API_KEY is accepted too,
 *                                          since that is what Moonshot's own
 *                                          docs call it.
 *   KIMI_BASE_URL     (var, optional)    — API host, for the .cn region
 *   KIMI_MODEL        (var, optional)    — model id, so a rename upstream is a
 *                                          dashboard edit, not a deploy
 *   KIMI_TEMPERATURE  (var, optional)    — defaults to 1, which thinking-mode
 *                                          models require. Instant-mode models
 *                                          prefer 0.6.
 *
 * The worker will be available at:
 *   https://kimi.hanyuriyu.workers.dev
 *
 * GET returns the upstream model list, which is how you find the current model
 * id without logging into the console. POST proxies a chat completion.
 */

// ---------------------------------------------------------------------------
// Firebase ID-token verification
//
// CORS only restricts browsers; it does nothing against direct HTTP calls.
// To stop anyone from spending our API credits via curl, every request must
// carry a valid Firebase ID token (Authorization: Bearer <idToken>) issued
// for this project. The token is an RS256 JWT signed by Google; we verify the
// signature against Google's public keys and validate the standard claims.
// ---------------------------------------------------------------------------
const FIREBASE_PROJECT_ID = "lingonect-4db51";
const FIREBASE_JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

// Cached Firebase public keys, reused across requests in the same isolate.
let __jwksCache = null;
let __jwksExpiry = 0;

async function __getFirebaseKeys() {
  const now = Date.now();
  if (__jwksCache && now < __jwksExpiry) return __jwksCache;
  const res = await fetch(FIREBASE_JWKS_URL);
  if (!res.ok) throw new Error("Failed to fetch Firebase public keys");
  const jwks = await res.json();
  const cc = res.headers.get("cache-control") || "";
  const m = cc.match(/max-age=(\d+)/);
  const maxAge = m ? parseInt(m[1], 10) : 3600;
  __jwksCache = jwks.keys || [];
  __jwksExpiry = now + maxAge * 1000;
  return __jwksCache;
}

function __b64urlToBytes(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function __decodeJwtPart(s) {
  return JSON.parse(new TextDecoder().decode(__b64urlToBytes(s)));
}

/**
 * Verify a Firebase ID token (RS256 JWT) for this project.
 * Returns the decoded payload if valid, otherwise null.
 */
async function verifyFirebaseToken(authHeader) {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7).trim();
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  let header, payload;
  try {
    header = __decodeJwtPart(parts[0]);
    payload = __decodeJwtPart(parts[1]);
  } catch (_) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (header.alg !== "RS256" || !header.kid) return null;
  if (payload.aud !== FIREBASE_PROJECT_ID) return null;
  if (payload.iss !== "https://securetoken.google.com/" + FIREBASE_PROJECT_ID) return null;
  if (!payload.sub) return null;
  if (typeof payload.exp !== "number" || payload.exp <= now) return null;
  if (typeof payload.iat !== "number" || payload.iat > now + 300) return null;
  // Mirror the app's own gate: only email-verified accounts may use the proxies.
  if (payload.email_verified !== true) return null;

  let keys;
  try {
    keys = await __getFirebaseKeys();
  } catch (_) {
    return null;
  }
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return null;

  let cryptoKey;
  try {
    cryptoKey = await crypto.subtle.importKey(
      "jwk",
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
  } catch (_) {
    return null;
  }

  const data = new TextEncoder().encode(parts[0] + "." + parts[1]);
  const sig = __b64urlToBytes(parts[2]);
  let valid;
  try {
    valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, sig, data);
  } catch (_) {
    return null;
  }
  return valid ? payload : null;
}

// ── New-user request-limit policy ──────────────────────────────
// Profiles created on or after this instant are subject to the 500-request
// free cap; anyone created earlier is grandfathered. Stripe (added later) can
// override per-user by writing plan "pro" (subscriber) or "free" to the profile.
const NEW_LIMITS_CUTOFF_MS = Date.parse("2026-07-19T00:00:00Z");
const FIRESTORE_PROFILE_BASE =
  "https://firestore.googleapis.com/v1/projects/" + FIREBASE_PROJECT_ID +
  "/databases/(default)/documents/profiles/";

// Classify a user as "pro" (subscriber, 800/day), "free" (new user, 500
// lifetime), or "legacy" (grandfathered, 1000/day). Reads the user's own
// profile from Firestore with their forwarded ID token. Fails safe to "legacy"
// so a hiccup never blocks a grandfathered or paying user.
async function __resolveUserStatus(uid, authHeader) {
  try {
    const res = await fetch(FIRESTORE_PROFILE_BASE + uid, {
      headers: { Authorization: authHeader },
    });
    if (!res.ok) return "legacy";
    const doc = await res.json();
    const f = (doc && doc.fields) || {};
    const plan = f.plan && f.plan.stringValue;
    const subscribed = f.subscribed && f.subscribed.booleanValue === true;
    if (plan === "pro" || subscribed) return "pro";
    if (plan === "free") return "free";
    const created = f.createdAt && f.createdAt.timestampValue;
    const createdMs = created ? Date.parse(created) : 0;
    if (createdMs && createdMs >= NEW_LIMITS_CUTOFF_MS) return "free";
    return "legacy";
  } catch (_) {
    return "legacy";
  }
}

// Origins allowed to call this worker. The website plus the native iOS app
// (Capacitor serves the bundled app from capacitor://localhost) and localhost
// for development. Anything else falls back to the canonical site origin, so
// the browser's CORS check blocks it.
const CORS_ALLOWED_ORIGINS = [
  "https://www.lingonect.com",
  "https://lingonect.com",
  "https://hanyuriyu.github.io",
  "capacitor://localhost",
  "http://localhost",
  "https://localhost",
];
function corsOrigin(request) {
  const o = request.headers.get("Origin");
  return CORS_ALLOWED_ORIGINS.includes(o) ? o : "https://www.lingonect.com";
}

// Secrets pasted into the Cloudflare dashboard often arrive with a stray
// newline or space attached. Trimming every credential here stops that from
// reaching the provider as a malformed key — which comes back as a 401 and
// reads, wrongly, like a revoked account.
const __t = (v) => (v == null ? "" : String(v).trim());

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": corsOrigin(request),
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Max-Age": "86400",
        },
      });
    }
    // Reject anything without a valid Firebase ID token before doing any work.
    const __authPayload = await verifyFirebaseToken(request.headers.get("Authorization"));
    if (!__authPayload) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        {
          status: 401,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": corsOrigin(request),
          },
        }
      );
    }

    // ── Per-user request limits ─────────────────────────────
    // Admin is always exempt. Everything below fails open: any KV/Firestore
    // hiccup lets the request through rather than blocking a paying or
    // grandfathered user.
    //   • Grandfathered users (profile created before the cutoff, or with no
    //     explicit plan) keep the legacy allowance of 1000 requests/UTC-day.
    //   • Subscribers (plan "pro") get 800 requests/UTC-day.
    //   • New free users (plan "free", or a profile created on/after the
    //     cutoff) get 500 requests total, ever. After that they must subscribe.
    if (env.QUOTA_KV && __authPayload.email !== "linguisticsconsulting@gmail.com") {
      try {
        const __uid = __authPayload.sub;
        // Resolve the user's status, cached in KV so Firestore is hit at most
        // once every 10 minutes per user.
        let __status = await env.QUOTA_KV.get("st:" + __uid);
        if (!__status) {
          __status = await __resolveUserStatus(__uid, request.headers.get("Authorization"));
          await env.QUOTA_KV.put("st:" + __uid, __status, { expirationTtl: 600 });
        }

        if (__status === "free") {
          // Lifetime cap: 500 requests, ever.
          const __tKey = "t:" + __uid;
          const __total = parseInt((await env.QUOTA_KV.get(__tKey)) || "0", 10) || 0;
          if (__total >= 500) {
            return new Response(
              JSON.stringify({ error: "You've used all 500 free requests. Subscribe to keep translating.", code: "free_limit_reached" }),
              {
                status: 429,
                headers: {
                  "Content-Type": "application/json",
                  "Access-Control-Allow-Origin": corsOrigin(request),
                },
              }
            );
          }
          await env.QUOTA_KV.put(__tKey, String(__total + 1));
        } else {
          // Daily cap: 800/day for subscribers, 1000/day for grandfathered users.
          const __dailyMax = __status === "pro" ? 800 : 1000;
          const __day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
          const __qKey = "q:" + __uid + ":" + __day;
          const __used = parseInt((await env.QUOTA_KV.get(__qKey)) || "0", 10) || 0;
          if (__used >= __dailyMax) {
            return new Response(
              JSON.stringify({ error: "Daily request limit reached. Please try again tomorrow.", code: "daily_limit_reached" }),
              {
                status: 429,
                headers: {
                  "Content-Type": "application/json",
                  "Access-Control-Allow-Origin": corsOrigin(request),
                },
              }
            );
          }
          // Counter auto-expires after 2 days so old day-keys clean themselves up.
          await env.QUOTA_KV.put(__qKey, String(__used + 1), { expirationTtl: 172800 });
        }
      } catch (_) {
        // KV/Firestore unavailable — allow the request rather than blocking the user.
      }
    }


    if (request.method !== "POST" && request.method !== "GET") {
      return new Response("Method not allowed", { status: 405 });
    }

    // A missing or unset secret would otherwise reach Moonshot as
    // "Bearer undefined" and come back as a 401, which reads to the user as
    // "our credentials were rejected" — true, but it hides that there are no
    // credentials at all. Say so plainly instead.
    // Either name works: the console is branded Kimi, while Moonshot's own
    // docs say MOONSHOT_API_KEY. Accepting both removes a way to misname it.
    const apiKey = __t(env.KIMI_API_KEY) || __t(env.MOONSHOT_API_KEY);
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: { message: "Kimi is not configured on our side: KIMI_API_KEY is not set.", code: "not_configured" } }),
        {
          status: 503,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": corsOrigin(request),
          },
        }
      );
    }

    // Keys come from platform.kimi.ai, but the API host is api.moonshot.ai.
    const base = (__t(env.KIMI_BASE_URL) || __t(env.MOONSHOT_BASE_URL) || "https://api.moonshot.ai/v1").replace(/\/+$/, "");

    try {
      // GET → model list. Handy for confirming which Kimi ids this key can
      // actually reach before pointing the site at one.
      if (request.method === "GET") {
        const listRes = await fetch(`${base}/models`, {
          headers: { "Authorization": `Bearer ${apiKey}` },
        });
        return new Response(await listRes.text(), {
          status: listRes.status,
          headers: {
            "Content-Type": listRes.headers.get("Content-Type") || "application/json",
            "Access-Control-Allow-Origin": corsOrigin(request),
          },
        });
      }

      const body = await request.json();

      const payload = {
        // kimi-k2-0905-preview, kimi-k2-thinking, kimi-k2.5 and the whole
        // moonshot-v1 series are retired and answer 404 now. Keep this on a
        // current id; GET this worker to see what the key can actually reach.
        model: body.model || __t(env.KIMI_MODEL) || "kimi-k2.6",
        messages: body.messages,
        // Thinking-mode models pin temperature: kimi-k2.6 accepts only 1 and
        // rejects the 0.3 the rest of our proxies use for translation. Default
        // to what the current model wants; the retry below covers the rest.
        temperature: body.temperature ?? Number(__t(env.KIMI_TEMPERATURE) || "1"),
        max_tokens: body.max_tokens ?? 1024,
      };

      const call = (p) => fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify(p),
      });

      let res = await call(payload);
      // Forwarded verbatim: Moonshot's own wording ("model not found",
      // "insufficient balance") is far more useful to the site's error
      // classifier than a re-wrapped message would be.
      let responseBody = await res.text();

      // Moonshot names the value it will accept — "only 1 is allowed for this
      // model" — so a temperature rejection is self-correcting rather than
      // something to chase through a redeploy every time a model changes its
      // mind. Retried once, only for this error.
      if (!res.ok && /temperature/i.test(responseBody)) {
        const allowed = responseBody.match(/only\s+([\d.]+)\s+is allowed/i);
        const retry = Object.assign({}, payload, {
          temperature: allowed ? Number(allowed[1]) : 1,
        });
        if (retry.temperature !== payload.temperature && !Number.isNaN(retry.temperature)) {
          res = await call(retry);
          responseBody = await res.text();
        }
      }

      return new Response(responseBody, {
        status: res.status,
        headers: {
          "Content-Type": res.headers.get("Content-Type") || "application/json",
          "Access-Control-Allow-Origin": corsOrigin(request),
        },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: { message: err.message } }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": corsOrigin(request),
        },
      });
    }
  },
};
