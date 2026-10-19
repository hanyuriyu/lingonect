/**
 * Cloudflare Worker: Alibaba (Qwen) Translation Proxy
 *
 * Environment secrets required:
 *   Settings > Variables and Secrets > Add:
 *     DASHSCOPE_API_KEY (encrypt)
 *
 * The worker will be available at:
 *   https://alibaba.hanyuriyu.workers.dev
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
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": corsOrigin(request),
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

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    let body;
    try {
      body = await request.json();
    } catch (_) {
      body = {};
    }
    // "mt" = Alibaba Cloud Machine Translation (the NMT behind "Alibaba
    // Translate"); anything else = a Qwen chat call via DashScope.
    const __isMT = body.mode === "mt";

    // A missing secret would otherwise go upstream as "Bearer undefined" and
    // come back as a 401 — indistinguishable from a key the provider revoked.
    // Report the real cause instead, so the engine-health check can name it.
    const __missing = (__isMT
      ? ["ALIBABA_ACCESS_KEY_ID", "ALIBABA_ACCESS_KEY_SECRET"]
      : ["DASHSCOPE_API_KEY"]).filter((n) => !__t(env[n]));
    if (__missing.length) {
      return new Response(
        JSON.stringify({ error: { message: "This engine is not configured on our side (missing " + __missing.join(", ") + ").", code: "not_configured" } }),
        {
          status: 503,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": corsOrigin(request),
          },
        }
      );
    }
    try {
      if (__isMT) {
        const { status, data } = await translateGeneral(env, body);
        return new Response(JSON.stringify(data), {
          status,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": corsOrigin(request),
          },
        });
      }

      // DashScope serves the "Qwen" engine: the reasoning LLM (qwen-max with
      // enable_thinking). Forward the caller's model and the thinking flag.
      const payload = {
        model: body.model || "qwen-plus",
        messages: body.messages,
        temperature: body.temperature ?? 0.3,
        max_tokens: body.max_tokens ?? 1024,
      };
      if (typeof body.enable_thinking === "boolean") {
        payload.enable_thinking = body.enable_thinking;
      }

      const callDashscope = (p) =>
        fetch("https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${__t(env.DASHSCOPE_API_KEY)}`,
          },
          body: JSON.stringify(p),
        });

      let res = await callDashscope(payload);
      // Some Qwen reasoning models only return thinking output in streaming
      // mode and reject a non-streaming request. This proxy is non-streaming,
      // so if a thinking request is rejected, transparently retry once without
      // thinking rather than failing the whole translation.
      if (!res.ok && payload.enable_thinking) {
        const fallback = { ...payload };
        delete fallback.enable_thinking;
        res = await callDashscope(fallback);
      }
      const data = await res.json();
      return new Response(JSON.stringify(data), {
        status: res.status,
        headers: {
          "Content-Type": "application/json",
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

// ---------------------------------------------------------------------------
// Alibaba Cloud Machine Translation (TranslateGeneral, RPC API 2018-10-12)
//
// Needs an AccessKey pair, ideally of a RAM user that only has
// AliyunMTFullAccess:
//   npx wrangler secret put ALIBABA_ACCESS_KEY_ID
//   npx wrangler secret put ALIBABA_ACCESS_KEY_SECRET
// Optional: ALIBABA_MT_ENDPOINT (default mt.aliyuncs.com).
//
// Returns { translated } on success, or { error: { message, code } } with a
// non-2xx status so the site's error matcher can explain it.
// ---------------------------------------------------------------------------
function __pctEncode(v) {
  return encodeURIComponent(v).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

async function translateGeneral(env, body) {
  const params = {
    Format: "JSON",
    Version: "2018-10-12",
    AccessKeyId: __t(env.ALIBABA_ACCESS_KEY_ID),
    SignatureMethod: "HMAC-SHA1",
    SignatureVersion: "1.0",
    SignatureNonce: crypto.randomUUID(),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    Action: "TranslateGeneral",
    FormatType: "text",
    Scene: "general",
    SourceLanguage: body.source || "auto",
    TargetLanguage: body.target,
    SourceText: body.text || "",
  };
  const canonical = Object.keys(params).sort()
    .map((k) => __pctEncode(k) + "=" + __pctEncode(params[k]))
    .join("&");
  const stringToSign = "POST&" + __pctEncode("/") + "&" + __pctEncode(canonical);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(__t(env.ALIBABA_ACCESS_KEY_SECRET) + "&"),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(stringToSign)));
  const signature = btoa(String.fromCharCode(...sig));

  const host = __t(env.ALIBABA_MT_ENDPOINT) || "mt.aliyuncs.com";
  const res = await fetch("https://" + host + "/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: canonical + "&Signature=" + __pctEncode(signature),
  });
  const data = await res.json().catch(() => ({}));

  // Gateway errors (bad key, no permission, service not activated) come back
  // as HTTP 4xx; translation errors as HTTP 200 with a non-"200" Code.
  const ok = res.ok && String(data.Code) === "200" && data.Data && typeof data.Data.Translated === "string";
  if (ok) return { status: 200, data: { translated: data.Data.Translated } };
  return {
    status: res.ok ? 400 : res.status,
    data: {
      error: {
        message: `${data.Code || "Error"}: ${data.Message || "no message"} (RequestId ${data.RequestId || "?"})`,
        code: data.Code,
      },
    },
  };
}
