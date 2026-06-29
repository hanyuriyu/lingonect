/**
 * Cloudflare Worker: Meta NLLB-200 Translation Proxy
 *
 * Uses community-hosted NLLB API Spaces on Hugging Face that run
 * facebook/nllb-200-distilled-600M (or 1.3B) via CTranslate2.
 *
 * No API token required.
 *
 * The worker will be available at:
 *   https://meta.hanyuriyu.workers.dev
 */

// NLLB API endpoints to try in order — put your own HF Space duplicate first
const NLLB_ENDPOINTS = [
  "https://hanyuriyu-nllb-api.hf.space/api/v4/translator",
  "https://vutuka-fast-inference-nllb.hf.space/api/v4/translator",
  "https://winstxnhdw-nllb-api.hf.space/api/v4/translator",
];

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

export default {
  async fetch(request, env) {
    const CORS = {
      "Access-Control-Allow-Origin": "https://www.lingonect.com",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
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


    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    try {
      const { text, source, target } = await request.json();

      if (!text || !target) {
        return new Response(
          JSON.stringify({ error: "Missing 'text' and/or 'target' fields" }),
          { status: 400, headers: { "Content-Type": "application/json", ...CORS } }
        );
      }

      const srcLang = source || "eng_Latn";
      let lastError = "";

      for (const endpoint of NLLB_ENDPOINTS) {
        const url = `${endpoint}?text=${encodeURIComponent(text)}&source=${encodeURIComponent(srcLang)}&target=${encodeURIComponent(target)}`;

        // Retry up to 3 times if the Space is waking up (503)
        let res;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            res = await fetch(url);
          } catch {
            continue;
          }
          if (res.status !== 503) break;
          await new Promise(r => setTimeout(r, (attempt + 1) * 5000));
        }

        if (!res || !res.ok) {
          lastError = res ? await res.text() : "fetch failed";
          continue; // try next endpoint
        }

        const raw = await res.text();

        let data;
        try { data = JSON.parse(raw); } catch { data = null; }

        // Normalize response
        let result;
        if (typeof data === "string") {
          result = data;
        } else if (data?.result) {
          result = data.result;
        } else if (Array.isArray(data) && data[0]?.translation_text) {
          result = data[0].translation_text;
        } else {
          result = raw.trim();
        }

        return new Response(JSON.stringify({ result }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...CORS },
        });
      }

      // All endpoints failed
      let errorMsg;
      try {
        const parsed = JSON.parse(lastError);
        errorMsg = parsed?.error || parsed?.detail || lastError;
      } catch {
        errorMsg = lastError;
      }
      return new Response(
        JSON.stringify({ error: errorMsg || "All NLLB endpoints unavailable" }),
        { status: 200, headers: { "Content-Type": "application/json", ...CORS } }
      );
    } catch (err) {
      return new Response(
        JSON.stringify({ error: err.message }),
        { status: 500, headers: { "Content-Type": "application/json", ...CORS } }
      );
    }
  },
};
