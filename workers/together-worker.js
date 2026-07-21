/**
 * Cloudflare Worker: Together AI (Meta Llama) Translation Proxy
 *
 * Proxies to Together AI's OpenAI-compatible Chat Completions endpoint so the
 * site can use Meta's Llama models as a hosted LLM engine. Defaults to
 * Llama 4 Maverick (an efficient MoE: ~17B active params, strong multilingual).
 *
 * Deploy steps:
 *   1. npx wrangler init together
 *   2. Replace the generated worker code with this file
 *   3. npx wrangler secret put TOGETHER_API_KEY   (paste your key when prompted)
 *   4. npx wrangler deploy -c workers/wrangler/together.toml
 *
 * The worker will be available at:
 *   https://together.hanyuriyu.workers.dev
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

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "https://www.lingonect.com",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
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
            "Access-Control-Allow-Origin": "https://www.lingonect.com",
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
                  "Access-Control-Allow-Origin": "https://www.lingonect.com",
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
                  "Access-Control-Allow-Origin": "https://www.lingonect.com",
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


    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    try {
      const body = await request.json();

      const res = await fetch("https://api.together.xyz/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${env.TOGETHER_API_KEY}`,
        },
        body: JSON.stringify({
          model: body.model || "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8",
          messages: body.messages,
          temperature: body.temperature ?? 0.3,
          max_tokens: body.max_tokens ?? 1024,
        }),
      });

      const data = await res.json();

      return new Response(JSON.stringify(data), {
        status: res.status,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "https://www.lingonect.com",
        },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: { message: err.message } }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "https://www.lingonect.com",
        },
      });
    }
  },
};
