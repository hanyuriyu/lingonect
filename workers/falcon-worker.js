/**
 * Cloudflare Worker: Falcon-H1-Arabic Translation Proxy (Technology Innovation
 * Institute's Arabic LLM, Abu Dhabi)
 *
 * TII offers no hosted API — the weights are only on Hugging Face — so we run
 * tiiuae/Falcon-H1-Arabic-7B-Instruct ourselves. Two backends are supported;
 * the worker picks the Space when FALCON_SPACE_URL is set:
 *
 *   A. ZeroGPU Space (HF PRO, $9/month): a private Gradio Space running
 *      workers/falcon-space/app.py. Requests use the HF token owner's daily
 *      ZeroGPU quota (~25 GPU-minutes on PRO).
 *        FALCON_SPACE_URL = https://<user>-<space>.hf.space
 *   B. Inference Endpoint (pay per GPU-hour): vLLM engine, OpenAI-compatible.
 *        FALCON_ENDPOINT_URL = https://<id>.<region>.<cloud>.endpoints.huggingface.cloud
 *
 * Deploy steps:
 *   1. npx wrangler secret put HF_TOKEN -c workers/wrangler/falcon.toml
 *   2. Set FALCON_SPACE_URL (or FALCON_ENDPOINT_URL) in workers/wrangler/falcon.toml
 *   3. npx wrangler deploy -c workers/wrangler/falcon.toml
 *
 * Environment:
 *   HF_TOKEN             (secret, required) — HF access token ("Read" is enough)
 *   FALCON_SPACE_URL     (var)              — backend A
 *   FALCON_ENDPOINT_URL  (var)              — backend B (with or without /v1)
 *   FALCON_MODEL         (var, optional)    — backend B only: served model id;
 *                                            when empty the worker asks /models
 *
 * The worker will be available at:
 *   https://falcon.hanyuriyu.workers.dev
 *
 * Either way the site gets an OpenAI-style chat-completion response back.
 * GET checks the backend is reachable. A sleeping backend (scale-to-zero
 * endpoint, or a Space that has gone to sleep) is reported as "warming up";
 * a spent ZeroGPU quota as "quota_exhausted".
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

function __warmingUp(request) {
  return __json(request, 503, {
    error: {
      message: "Falcon is warming up (the server sleeps when idle). Please try again in a minute or two.",
      code: "warming_up",
    },
  });
}

// ── Backend A: ZeroGPU Space ────────────────────────────────────────────────
// Gradio's HTTP API is two steps: POST /gradio_api/call/chat returns an
// event_id, then GET /gradio_api/call/chat/<event_id> streams server-sent
// events until "complete" (data: ["<reply>"]) or "error".
async function __viaSpace(request, space, authHeaders) {
  if (request.method === "GET") {
    const infoRes = await fetch(`${space}/gradio_api/info`, { headers: authHeaders });
    if (infoRes.status === 503) return __warmingUp(request);
    return new Response(await infoRes.text(), {
      status: infoRes.status,
      headers: {
        "Content-Type": infoRes.headers.get("Content-Type") || "application/json",
        "Access-Control-Allow-Origin": corsOrigin(request),
      },
    });
  }

  const body = await request.json();
  const callRes = await fetch(`${space}/gradio_api/call/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({
      data: [
        JSON.stringify(body.messages || []),
        body.temperature ?? 0.3,
        body.max_tokens ?? 1024,
      ],
    }),
  });
  // A sleeping or rebuilding Space answers 503 (or 404 while it boots).
  if (callRes.status === 503 || callRes.status === 404) return __warmingUp(request);
  if (!callRes.ok) {
    return __json(request, callRes.status, {
      error: { message: `Falcon Space error: ${(await callRes.text()).slice(0, 300)}` },
    });
  }
  const { event_id } = await callRes.json();
  if (!event_id) {
    return __json(request, 502, { error: { message: "Falcon Space returned no event id." } });
  }

  const streamRes = await fetch(`${space}/gradio_api/call/chat/${event_id}`, { headers: authHeaders });
  const sse = await streamRes.text();

  // Walk the SSE blocks; the last "complete" or "error" one decides.
  let reply = null, errorText = null;
  for (const block of sse.split(/\n\n+/)) {
    const ev = (block.match(/^event:\s*(.+)$/m) || [])[1];
    const dataLine = (block.match(/^data:\s*(.*)$/m) || [])[1];
    if (ev === "complete") {
      try { reply = JSON.parse(dataLine)[0]; } catch (_) { reply = null; }
    } else if (ev === "error") {
      errorText = dataLine && dataLine !== "null" ? dataLine : "unknown error";
    }
  }

  if (typeof reply === "string") {
    // Shaped like an OpenAI chat completion so the site parses it unchanged.
    return __json(request, 200, {
      object: "chat.completion",
      model: "tiiuae/Falcon-H1-Arabic-7B-Instruct",
      choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
    });
  }

  const msg = String(errorText || sse.slice(0, 300) || "empty response");
  if (/quota/i.test(msg)) {
    return __json(request, 429, {
      error: {
        message: "Falcon has used up today's free GPU time. Please try again tomorrow.",
        code: "quota_exhausted",
      },
    });
  }
  return __json(request, 502, { error: { message: `Falcon Space error: ${msg}` } });
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
    const space = __t(env.FALCON_SPACE_URL).replace(/\/+$/, "");
    const endpoint = __t(env.FALCON_ENDPOINT_URL).replace(/\/+$/, "");
    if (!apiKey || (!space && !endpoint)) {
      return __json(request, 503, {
        error: {
          message: `Falcon is not configured on our side: ${!apiKey ? "HF_TOKEN" : "FALCON_SPACE_URL"} is not set.`,
          code: "not_configured",
        },
      });
    }

    const authHeaders = { "Authorization": `Bearer ${apiKey}` };

    try {
      if (space) return await __viaSpace(request, space, authHeaders);

      const base = endpoint.endsWith("/v1") ? endpoint : `${endpoint}/v1`;

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
          return __warmingUp(request);
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
      if (res.status === 503) return __warmingUp(request);
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
