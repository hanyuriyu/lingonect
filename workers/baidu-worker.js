/**
 * Cloudflare Worker: Baidu Translate Proxy
 *
 * Environment secrets required:
 *   BAIDU_APP_ID     – numeric App ID from 开发者信息
 *   BAIDU_SECRET_KEY – secret key (密钥) from 开发者信息
 *
 * The worker will be available at:
 *   https://baidu.hanyuriyu.workers.dev
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
    // No profile document (404) or it could not be read. This used to mean
    // "legacy" (1000/day), so a brand-new account that never got a profile
    // skipped the 500-request free cap. Decide from the account's own
    // creation time in Firebase Auth instead.
    if (!res.ok) return await __statusFromAccountAge(authHeader);
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

// ── Baidu's IP risk control, and the relay that gets us out of it ───────────
//
// Baidu bans an *IP* (error 58003, 此IP已被封禁) as soon as its risk system sees
// several App IDs translating from that IP on one day. Workers egress from
// Cloudflare's shared address pool, which plenty of other people also proxy
// Baidu through, so we inherit bans earned by strangers. Our account, credits
// and App ID stay perfectly healthy throughout — which is exactly why nothing
// ever shows up in the Baidu console.
//
// The cure is an egress IP that only ever carries our App ID. Point
// BAIDU_RELAY_URL at the relay in workers/baidu-relay/ (with the shared
// BAIDU_RELAY_TOKEN) and the signed request goes out from that fixed IP, which
// Baidu can then whitelist. Leave both unset and the worker calls Baidu
// directly, exactly as it always has.
const BAIDU_API_URL = "https://fanyi-api.baidu.com/api/trans/vip/translate";

// Baidu answers HTTP 200 even when it failed, with the reason in error_code.
// 52001 (request timeout) and 52002 (system error) are transient and worth one
// immediate retry; every other code is a verdict to pass straight through.
const BAIDU_RETRYABLE = ["52001", "52002"];

// POST the already-signed form to Baidu (or to the relay) and parse the reply.
// A non-JSON body means the relay itself failed rather than Baidu, so it is
// reshaped into Baidu's error format to keep one response contract for callers.
async function callBaidu(env, form) {
  const relay = __t(env.BAIDU_RELAY_URL);
  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  if (relay && __t(env.BAIDU_RELAY_TOKEN)) {
    headers["X-Relay-Token"] = __t(env.BAIDU_RELAY_TOKEN);
  }
  const res = await fetch(relay || BAIDU_API_URL, {
    method: "POST",
    headers,
    body: form,
  });
  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch (_) {
    data = {
      error_code: "relay_error",
      error_msg: raw.trim().slice(0, 200) || "Relay returned HTTP " + res.status,
    };
  }
  return { res, data };
}

// Secrets pasted into the Cloudflare dashboard often arrive with a stray
// newline or space attached. Trimming every credential here stops that from
// reaching the provider as a malformed key — which comes back as a 401 and
// reads, wrongly, like a revoked account.
const __t = (v) => (v == null ? "" : String(v).trim());

// ── Cost guard ─────────────────────────────────────────────────
// A valid login is not enough on its own: without limits, any logged-in
// caller could use this worker as an open API — any model, any prompt size,
// any answer length — on our bill. Each request is held to what Lingonect's
// own pages send (engines.html, flashcards.html, seed-ratings.html), sized
// from their largest real call (Contextualize, Triangulate, flashcard
// batches) with headroom:
//   • models      allowed model ids; any other is swapped for defaultModel
//                 (an empty list drops the caller's model, so the worker's
//                 own config decides). Old app builds asking for a retired
//                 model still get an answer.
//   • maxOutputTokens  caps max_tokens / max_completion_tokens
//   • defaultOutputTokens  set when the caller sends none
//   • maxBodyChars     a larger request body is refused (413)
//   • keys        top-level fields passed on; anything else is dropped
const __LIMITS = { maxBodyChars: 20000 };

function __modelAllowed(model, list) {
  return list.some((m) => (m instanceof RegExp ? m.test(model) : m === model));
}

// Returns { request, info } with a sanitised request, or { error } to refuse.
async function __applyCostGuard(request) {
  if (request.method !== "POST") return { request, info: {} };
  const L = typeof __LIMITS === "function" ? __LIMITS(request) : __LIMITS;
  const raw = await request.text();
  const info = { bodyChars: raw.length };
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  const rebuild = (text) => new Request(request.url, { method: "POST", headers, body: text });
  if (raw.length > L.maxBodyChars) {
    return { error: "This request is too large (" + raw.length + " characters; the limit is " + L.maxBodyChars + ").", info };
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch (_) {
    return { request: rebuild(raw), info }; // the worker reports malformed JSON itself
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { request: rebuild(raw), info };

  if (L.keys) {
    for (const k of Object.keys(body)) {
      if (!L.keys.includes(k)) {
        delete body[k];
        (info.droppedKeys = info.droppedKeys || []).push(k);
      }
    }
  }
  if (L.models && body.model != null && !__modelAllowed(String(body.model), L.models)) {
    info.requestedModel = String(body.model);
    if (L.defaultModel === undefined) delete body.model;
    else body.model = L.defaultModel;
  }
  if (L.maxOutputTokens) {
    for (const k of ["max_tokens", "max_completion_tokens"]) {
      if (body[k] == null) continue;
      const n = Math.floor(Number(body[k]));
      body[k] = Number.isFinite(n) && n > 0 ? Math.min(n, L.maxOutputTokens) : (L.defaultOutputTokens || L.maxOutputTokens);
    }
    if (L.defaultOutputTokens && body.max_tokens == null && body.max_completion_tokens == null) {
      body.max_tokens = L.defaultOutputTokens;
    }
  }
  if (L.fix) L.fix(body);
  info.model = body.model;
  info.maxTokens = body.max_tokens ?? body.max_completion_tokens;
  return { request: rebuild(JSON.stringify(body)), info };
}

// One log line per request, readable in Cloudflare > Workers > Logs: who
// called (uid / email), from where (IP, country, page origin) and how big a
// request it was. This is how to tell which account is spending the credits.
function __logRequest(request, auth, info, outcome) {
  try {
    console.log(JSON.stringify({
      lingonect: "request",
      worker: new URL(request.url).hostname.split(".")[0],
      path: new URL(request.url).pathname,
      outcome,
      uid: auth.sub,
      email: auth.email || null,
      anonymous: !!(auth.firebase && auth.firebase.sign_in_provider === "anonymous"),
      ip: request.headers.get("CF-Connecting-IP"),
      country: request.headers.get("CF-IPCountry"),
      origin: request.headers.get("Origin"),
      ...info,
    }));
  } catch (_) {}
}

// Public web API key (the same one embedded in the site's HTML). Used only to
// ask Firebase Auth when the caller's own account was created.
const FIREBASE_WEB_API_KEY = "AIzaSyAWxr3efpy-5Eo8fuXB5xxHHkvrbCcIIA0";

// "free" for an account created on/after the cutoff, else "legacy". Fails safe
// to "legacy", like __resolveUserStatus.
async function __statusFromAccountAge(authHeader) {
  try {
    const res = await fetch(
      "https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" + FIREBASE_WEB_API_KEY,
      {
        method: "POST",
        // The key may be restricted to the site's referrer.
        headers: { "Content-Type": "application/json", "Referer": "https://www.lingonect.com/" },
        body: JSON.stringify({ idToken: authHeader.slice(7).trim() }),
      }
    );
    if (!res.ok) return "legacy";
    const data = await res.json();
    const createdMs = Number(data && data.users && data.users[0] && data.users[0].createdAt);
    return createdMs && createdMs >= NEW_LIMITS_CUTOFF_MS ? "free" : "legacy";
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

    // ── Cost guard + usage log ──────────────────────────────
    // Before the quota block, so an oversized request is refused without
    // costing the caller a request from their allowance.
    {
      const __guard = await __applyCostGuard(request);
      if (__guard.error) {
        __logRequest(request, __authPayload, __guard.info, "refused_too_large");
        return new Response(
          JSON.stringify({ error: { message: __guard.error, code: "request_too_large" } }),
          { status: 413, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": corsOrigin(request) } }
        );
      }
      request = __guard.request;
      __logRequest(request, __authPayload, __guard.info, "accepted");
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
        // Per-IP ceiling across all accounts. Accounts are free to create, so
        // the per-account limits below cannot stop one machine cycling through
        // many of them; this can. Generous on purpose — a school or office
        // shares one IP — and tunable as IP_DAILY_MAX in the dashboard.
        const __ip = request.headers.get("CF-Connecting-IP");
        if (__ip) {
          const __ipMax = parseInt(env.IP_DAILY_MAX, 10) || 5000;
          const __ipKey = "ip:" + __ip + ":" + new Date().toISOString().slice(0, 10);
          const __ipUsed = parseInt((await env.QUOTA_KV.get(__ipKey)) || "0", 10) || 0;
          if (__ipUsed >= __ipMax) {
            __logRequest(request, __authPayload, {}, "refused_ip_limit");
            return new Response(
              JSON.stringify({ error: "Too many requests from this network today. Please try again tomorrow.", code: "ip_limit_reached" }),
              { status: 429, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": corsOrigin(request) } }
            );
          }
          await env.QUOTA_KV.put(__ipKey, String(__ipUsed + 1), { expirationTtl: 172800 });
        }
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

    // A missing secret would otherwise go upstream as "Bearer undefined" and
    // come back as a 401 — indistinguishable from a key the provider revoked.
    // Report the real cause instead, so the engine-health check can name it.
    const __missing = ["BAIDU_APP_ID", "BAIDU_SECRET_KEY"].filter((n) => !__t(env[n]));
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
      const { text, from, to } = await request.json();

      const appid = __t(env.BAIDU_APP_ID);
      const key = __t(env.BAIDU_SECRET_KEY);
      const salt = String(Math.floor(Math.random() * 1e10));
      const signStr = appid + text + salt + key;
      const sign = md5(signStr);

      const form = new URLSearchParams({
        q: text,
        from: from || "auto",
        to: to,
        appid: appid,
        salt: salt,
        sign: sign,
      }).toString();

      let { res, data } = await callBaidu(env, form);
      if (data && BAIDU_RETRYABLE.includes(String(data.error_code))) {
        ({ res, data } = await callBaidu(env, form));
      }

      // Baidu hides failures behind HTTP 200, so the only place the real reason
      // is visible is here. Log it — observability is on for this worker, so
      // `wrangler tail -c workers/wrangler/baidu.toml` shows the live code.
      if (data && data.error_code) {
        console.error(
          "Baidu error_code=" + data.error_code,
          data.error_msg || "",
          __t(env.BAIDU_RELAY_URL) ? "(via relay)" : "(direct from Cloudflare)"
        );
      }

      return new Response(JSON.stringify(data), {
        status: res.status,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": corsOrigin(request),
        },
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: { message: err.message } }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": corsOrigin(request),
          },
        }
      );
    }
  },
};

// ── MD5 (RFC 1321) pure-JS implementation ──

function md5(string) {
  const bytes = new TextEncoder().encode(string);

  // Convert to array of 32-bit words (little-endian)
  let len = bytes.length;
  // Pad: append 0x80, then zeros, then 64-bit length
  let paddedLen = ((len + 8) >>> 6 << 4) + 16;
  let words = new Uint32Array(paddedLen);
  for (let i = 0; i < len; i++) {
    words[i >>> 2] |= bytes[i] << ((i & 3) << 3);
  }
  words[len >>> 2] |= 0x80 << ((len & 3) << 3);
  words[paddedLen - 2] = (len * 8) & 0xFFFFFFFF;
  words[paddedLen - 1] = Math.floor(len * 8 / 0x100000000);

  // Constants
  const S = [
    7,12,17,22, 7,12,17,22, 7,12,17,22, 7,12,17,22,
    5, 9,14,20, 5, 9,14,20, 5, 9,14,20, 5, 9,14,20,
    4,11,16,23, 4,11,16,23, 4,11,16,23, 4,11,16,23,
    6,10,15,21, 6,10,15,21, 6,10,15,21, 6,10,15,21
  ];
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) {
    K[i] = Math.floor(0x100000000 * Math.abs(Math.sin(i + 1)));
  }

  let a0 = 0x67452301;
  let b0 = 0xEFCDAB89;
  let c0 = 0x98BADCFE;
  let d0 = 0x10325476;

  for (let offset = 0; offset < paddedLen; offset += 16) {
    let A = a0, B = b0, C = c0, D = d0;

    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }

      let temp = D;
      D = C;
      C = B;
      let sum = (A + F + K[i] + words[offset + g]) | 0;
      B = (B + ((sum << S[i]) | (sum >>> (32 - S[i])))) | 0;
      A = temp;
    }

    a0 = (a0 + A) | 0;
    b0 = (b0 + B) | 0;
    c0 = (c0 + C) | 0;
    d0 = (d0 + D) | 0;
  }

  function toHex(n) {
    let s = "";
    for (let i = 0; i < 4; i++) {
      s += ((n >> (i * 8 + 4)) & 0xF).toString(16);
      s += ((n >> (i * 8)) & 0xF).toString(16);
    }
    return s;
  }

  return toHex(a0) + toHex(b0) + toHex(c0) + toHex(d0);
}
