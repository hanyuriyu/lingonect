/**
 * Cloudflare Worker: approval emails
 *
 * When the admin approves an access request on admin.html, the page calls
 *   POST /   { uid, resend? }   (Authorization: Bearer <admin's Firebase ID token>)
 * and this worker emails the approved person from contact@lingonect.com.
 *
 * - Only the admin accounts may call it (verified Firebase token + email).
 * - The recipient is never taken from the request: the worker reads
 *   accessRequests/{uid} from Firestore (with the admin's own token, so the
 *   Firestore rules still apply) and only mails a request that is "approved".
 * - It records approvalEmailSentAt on that request and refuses a second send
 *   unless the page asks for a resend explicitly.
 *
 * Sending goes through the Gmail API as contact@lingonect.com, using a Google
 * service account with Workspace domain-wide delegation limited to the
 * gmail.send scope. Emails therefore appear in that mailbox's Sent folder.
 *
 * Environment secret required (Settings > Variables and Secrets):
 *   GMAIL_SA_KEY   the whole service-account JSON key file, pasted as-is
 *
 * The worker will be available at:
 *   https://approval-mail.hanyuriyu.workers.dev
 */

// ---------------------------------------------------------------------------
// Firebase ID-token verification (same as the engine workers)
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

// ---------------------------------------------------------------------------
// Approval email
// ---------------------------------------------------------------------------
const ADMIN_EMAILS = ["linguisticsconsulting@gmail.com", "contact@lingonect.com"];
const SENDER = "contact@lingonect.com";
const SENDER_NAME = "Lingonect";
const SITE_URL = "https://www.lingonect.com";
const ALLOWED_ORIGINS = [
  "https://www.lingonect.com",
  "https://lingonect.com",
  "https://hanyuriyu.github.io",
  "http://localhost",
];
const ACCESS_BASE =
  "https://firestore.googleapis.com/v1/projects/" + FIREBASE_PROJECT_ID +
  "/databases/(default)/documents/accessRequests/";

function corsOrigin(request) {
  const o = request.headers.get("Origin");
  return ALLOWED_ORIGINS.includes(o) ? o : "https://www.lingonect.com";
}

function json(request, status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": corsOrigin(request) },
  });
}

function __bytesToB64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
const __b64url = (b64) => b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const __utf8B64 = (s) => __bytesToB64(new TextEncoder().encode(s));

// Exchange the service account for a Gmail access token that acts as SENDER
// (RFC 7523 JWT bearer grant; the Workspace delegation allows only gmail.send).
async function __gmailAccessToken(saJson) {
  const sa = JSON.parse(saJson);
  const pem = String(sa.private_key || "")
    .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
  );
  const now = Math.floor(Date.now() / 1000);
  const header = __b64url(__utf8B64(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claims = __b64url(__utf8B64(JSON.stringify({
    iss: sa.client_email,
    sub: SENDER,
    scope: "https://www.googleapis.com/auth/gmail.send",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })));
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(header + "." + claims)
  );
  const assertion = header + "." + claims + "." + __b64url(__bytesToB64(new Uint8Array(sig)));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") +
      "&assertion=" + encodeURIComponent(assertion),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error("Google sign-in for the mail account failed: " +
      (data.error_description || data.error || res.status));
  }
  return data.access_token;
}

// The raw RFC 5322 message, base64url-encoded as the Gmail API expects.
function __buildMessage(to, firstName) {
  const subject = "Your Lingonect access has been approved";
  const text =
    "Hi " + (firstName || "there") + ",\n\n" +
    "Good news: your Lingonect account has been approved.\n\n" +
    "Sign in at " + SITE_URL + " with the same account you registered with (" + to + ").\n\n" +
    "Lingonect\n" + SENDER + "\n";
  const mime = [
    "From: " + SENDER_NAME + " <" + SENDER + ">",
    "To: " + to,
    "Subject: =?UTF-8?B?" + __utf8B64(subject) + "?=",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    __utf8B64(text).replace(/.{76}/g, "$&\r\n"),
  ].join("\r\n");
  return __b64url(__utf8B64(mime));
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": corsOrigin(request),
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }
    if (request.method !== "POST") return json(request, 405, { error: "Method not allowed" });

    const authHeader = request.headers.get("Authorization");
    const caller = await verifyFirebaseToken(authHeader);
    if (!caller) return json(request, 401, { error: "Unauthorized" });
    if (!ADMIN_EMAILS.includes(caller.email)) return json(request, 403, { error: "Admins only" });

    if (!env.GMAIL_SA_KEY) {
      return json(request, 503, { error: "Email sending is not set up yet (GMAIL_SA_KEY is missing).", code: "not_configured" });
    }

    let body;
    try { body = await request.json(); } catch (_) { body = {}; }
    const uid = String(body.uid || "");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid)) return json(request, 400, { error: "Bad uid" });

    // The approved request, read with the admin's own token.
    const docRes = await fetch(ACCESS_BASE + uid, { headers: { Authorization: authHeader } });
    if (!docRes.ok) return json(request, 404, { error: "Access request not found" });
    const f = ((await docRes.json()) || {}).fields || {};
    const status = f.status && f.status.stringValue;
    const to = (f.email && f.email.stringValue || "").trim();
    const name = (f.name && f.name.stringValue || "").trim();
    if (status !== "approved") return json(request, 409, { error: "This request is not approved", code: "not_approved" });
    if (!/^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/.test(to)) {
      return json(request, 422, { error: "This request has no usable email address", code: "no_email" });
    }
    if (f.approvalEmailSentAt && body.resend !== true) {
      return json(request, 409, { error: "The approval email was already sent", code: "already_sent" });
    }
    const firstName = name.split(/\s+/)[0].replace(/[^\p{L}\p{M}'-]/gu, "").slice(0, 40);

    try {
      const token = await __gmailAccessToken(env.GMAIL_SA_KEY);
      const sendRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ raw: __buildMessage(to, firstName) }),
      });
      if (!sendRes.ok) {
        const err = await sendRes.json().catch(() => ({}));
        throw new Error("Gmail refused the email: " + ((err.error && err.error.message) || sendRes.status));
      }
    } catch (e) {
      console.log(JSON.stringify({ lingonect: "approval_mail", uid, outcome: "failed", error: String(e.message || e) }));
      return json(request, 502, { error: String(e.message || e), code: "send_failed" });
    }

    // Record the send so the Admin page shows it and a repeat click is caught.
    const sentAt = new Date().toISOString();
    await fetch(ACCESS_BASE + uid + "?updateMask.fieldPaths=approvalEmailSentAt", {
      method: "PATCH",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ fields: { approvalEmailSentAt: { timestampValue: sentAt } } }),
    }).catch(() => {});

    console.log(JSON.stringify({ lingonect: "approval_mail", uid, admin: caller.email, outcome: "sent" }));
    return json(request, 200, { ok: true, sentAt });
  },
};
