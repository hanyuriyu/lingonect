/**
 * Cloudflare Worker: Falcon-H1-Arabic Translation Proxy (Technology Innovation
 * Institute's Arabic LLM, Abu Dhabi)
 *
 * TII offers no hosted API — the weights are only on Hugging Face. We run
 * tiiuae/Falcon-H1-Arabic-7B-Instruct on our own Hugging Face Inference
 * Endpoint (vLLM engine), which exposes an OpenAI-compatible API at
 *   https://<endpoint-id>.<region>.<cloud>.endpoints.huggingface.cloud/v1
 *
 * Deploy steps:
 *   1. npx wrangler secret put HF_TOKEN -c workers/wrangler/falcon.toml
 *   2. Set FALCON_ENDPOINT_URL in workers/wrangler/falcon.toml
 *   3. npx wrangler deploy -c workers/wrangler/falcon.toml
 *
 * Environment:
 *   HF_TOKEN             (secret, required) — HF access token with permission
 *                                            to call the endpoint
 *   FALCON_ENDPOINT_URL  (var, required)    — the endpoint URL from the HF
 *                                            dashboard (with or without /v1)
 *   FALCON_MODEL         (var, optional)    — served model id; when empty the
 *                                            worker asks the endpoint's /models
 *
 * The worker will be available at:
 *   https://falcon.hanyuriyu.workers.dev
 *
 * GET returns the endpoint's model list. POST proxies a chat completion.
 * With scale-to-zero, the first request after an idle spell wakes the GPU;
 * HF answers 503 for the minutes that takes, and we pass that on as a plain
 * "warming up" message rather than a generic failure.
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

// Model id the endpoint serves, discovered once per isolate when FALCON_MODEL
// isn't set (vLLM rejects any other name).
let __servedModel = null;

function __json(request, status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": corsOrigin(request),
    },
  });
}

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

    // A missing secret would otherwise reach Fanar as "Bearer undefined" and
    // A missing secret would otherwise reach HF as "Bearer undefined" and come
    // back as a 401 — indistinguishable from a revoked token. Say so plainly.
    const apiKey = __t(env.HF_TOKEN);
    const endpoint = __t(env.FALCON_ENDPOINT_URL).replace(/\/+$/, "");
    if (!apiKey || !endpoint) {
      return __json(request, 503, {
        error: {
          message: `Falcon is not configured on our side: ${!apiKey ? "HF_TOKEN" : "FALCON_ENDPOINT_URL"} is not set.`,
          code: "not_configured",
        },
      });
    }

    const base = endpoint.endsWith("/v1") ? endpoint : `${endpoint}/v1`;
    const authHeaders = { "Authorization": `Bearer ${apiKey}` };

    try {
      // GET → model list, to confirm the endpoint is up and what it serves.
      if (request.method === "GET") {
        const listRes = await fetch(`${base}/models`, { headers: authHeaders });
        return new Response(await listRes.text(), {
          status: listRes.status,
          headers: {
            "Content-Type": listRes.headers.get("Content-Type") || "application/json",
            "Access-Control-Allow-Origin": corsOrigin(request),
          },
        });
      }

      let model = __t(env.FALCON_MODEL) || __servedModel;
      if (!model) {
        const listRes = await fetch(`${base}/models`, { headers: authHeaders });
        if (listRes.ok) {
          const list = await listRes.json().catch(() => null);
          model = list && list.data && list.data[0] && list.data[0].id;
          if (model) __servedModel = model;
        } else if (listRes.status === 503) {
          return __json(request, 503, {
            error: {
              message: "Falcon is warming up (the server sleeps when idle). Please try again in a minute or two.",
              code: "warming_up",
            },
          });
        }
      }

      const body = await request.json();
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({
          model: model || "tiiuae/Falcon-H1-Arabic-7B-Instruct",
          messages: body.messages,
          temperature: body.temperature ?? 0.3,
          max_tokens: body.max_tokens ?? 1024,
        }),
      });
      if (res.status === 503) {
        return __json(request, 503, {
          error: {
            message: "Falcon is warming up (the server sleeps when idle). Please try again in a minute or two.",
            code: "warming_up",
          },
        });
      }
      // Forwarded verbatim so the site's error classifier sees the upstream wording.
      return new Response(await res.text(), {
        status: res.status,
        headers: {
          "Content-Type": res.headers.get("Content-Type") || "application/json",
          "Access-Control-Allow-Origin": corsOrigin(request),
        },
      });
    } catch (err) {
      return __json(request, 500, { error: { message: err.message } });
    }
  },
};
