/**
 * Cloudflare Worker: Tencent Translate Proxy
 *
 * Environment secrets required:
 *   npx wrangler secret put TENCENT_SECRET_ID
 *   npx wrangler secret put TENCENT_SECRET_KEY
 *
 * The worker will be available at:
 *   https://tencenttranslate.hanyuriyu.workers.dev
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

    // Per-user daily quota: 1000 requests per UTC calendar day. The admin
    // account is exempt. Fails open (allows the request) if the KV store is
    // missing or unavailable, so a storage hiccup never blocks translation.
    if (env.QUOTA_KV && __authPayload.email !== "linguisticsconsulting@gmail.com") {
      try {
        const __day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
        const __qKey = "q:" + __authPayload.sub + ":" + __day;
        const __used = parseInt((await env.QUOTA_KV.get(__qKey)) || "0", 10) || 0;
        if (__used >= 1000) {
          return new Response(
            JSON.stringify({ error: "Daily request limit reached. Please try again tomorrow." }),
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
      } catch (_) {
        // KV unavailable — allow the request rather than blocking the user.
      }
    }


    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    try {
      const body = await request.json();
      const { text, source, target } = body;

      // Build Tencent Cloud API v3 request
      const service = "tmt";
      const host = "tmt.tencentcloudapi.com";
      const action = "TextTranslate";
      const version = "2018-03-21";
      const region = "ap-singapore";

      const payload = JSON.stringify({
        SourceText: text,
        Source: source || "auto",
        Target: target,
        ProjectId: 0,
      });

      const timestamp = Math.floor(Date.now() / 1000);
      const dateStr = new Date(timestamp * 1000).toISOString().slice(0, 10);

      // TC3-HMAC-SHA256 signing
      const hashedPayload = await sha256Hex(payload);

      const canonicalRequest = [
        "POST",
        "/",
        "",
        `content-type:application/json\nhost:${host}\n`,
        "content-type;host",
        hashedPayload,
      ].join("\n");

      const credentialScope = `${dateStr}/${service}/tc3_request`;
      const stringToSign = [
        "TC3-HMAC-SHA256",
        timestamp,
        credentialScope,
        await sha256Hex(canonicalRequest),
      ].join("\n");

      const secretDate = await hmacSha256(
        new TextEncoder().encode("TC3" + env.TENCENT_SECRET_KEY),
        dateStr
      );
      const secretService = await hmacSha256(secretDate, service);
      const secretSigning = await hmacSha256(secretService, "tc3_request");
      const signature = await hmacSha256Hex(secretSigning, stringToSign);

      const authorization =
        `TC3-HMAC-SHA256 Credential=${env.TENCENT_SECRET_ID}/${credentialScope}, ` +
        `SignedHeaders=content-type;host, Signature=${signature}`;

      const res = await fetch(`https://${host}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Host: host,
          "X-TC-Action": action,
          "X-TC-Version": version,
          "X-TC-Region": region,
          "X-TC-Timestamp": String(timestamp),
          Authorization: authorization,
        },
        body: payload,
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
      return new Response(
        JSON.stringify({ error: { message: err.message } }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "https://www.lingonect.com",
          },
        }
      );
    }
  },
};

// ── Crypto helpers using Web Crypto API ──

async function sha256Hex(message) {
  const data = new TextEncoder().encode(message);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return bufToHex(hash);
}

async function hmacSha256(key, message) {
  const keyData = typeof key === "string" ? new TextEncoder().encode(key) : key;
  const msgData =
    typeof message === "string" ? new TextEncoder().encode(message) : message;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, msgData));
}

async function hmacSha256Hex(key, message) {
  const result = await hmacSha256(key, message);
  return bufToHex(result.buffer);
}

function bufToHex(buffer) {
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
