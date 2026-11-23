/**
 * Cloudflare Worker: admin account actions (approval emails, user deletion)
 *
 * Called only from admin.html, with the admin's Firebase ID token
 * (Authorization: Bearer <idToken>):
 *
 *   POST /              { uid, resend? }
 *     Emails the approved person from contact@lingonect.com. The recipient is
 *     never taken from the request: the worker reads accessRequests/{uid}
 *     (with the admin's own token, so the Firestore rules still apply) and only
 *     mails a request that is "approved". It records approvalEmailSentAt and
 *     refuses a second send unless the page asks for a resend explicitly.
 *
 *   POST /delete-user   { uid, reason, note? }
 *     Deletes the account and all its data (Firebase Auth account, profile and
 *     its private info, username, flashcards, search history, chat messages,
 *     chat presence/invites, access request), then emails the person the
 *     reason, as the Terms of Use ("Removing Accounts") promise. reason is one
 *     of: abuse, terms, inactivity (only after 12 months without a sign-in),
 *     request. Admin accounts and the caller's own account are refused.
 *
 * Sending goes through the Gmail API as contact@lingonect.com, using a Google
 * service account with Workspace domain-wide delegation limited to the
 * gmail.send scope, so emails appear in that mailbox's Sent folder.
 *
 * Environment secrets required (Settings > Variables and Secrets):
 *   GMAIL_SA_KEY           service-account JSON key for sending email
 *   FIREBASE_ADMIN_SA_KEY  service-account JSON key with the roles
 *                          Firebase Authentication Admin, Cloud Datastore User
 *                          and Firebase Realtime Database Admin (deletion only)
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
// Shared helpers
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
const DOCS_PATH = "projects/" + FIREBASE_PROJECT_ID + "/databases/(default)/documents";
const FIRESTORE = "https://firestore.googleapis.com/v1/" + DOCS_PATH;
const ACCESS_BASE = FIRESTORE + "/accessRequests/";
const RTDB_URL = "https://lingonect-4db51-default-rtdb.firebaseio.com";
const IDENTITY = "https://identitytoolkit.googleapis.com/v1/projects/" + FIREBASE_PROJECT_ID;
const EMAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;
const INACTIVE_MS = 365 * 24 * 60 * 60 * 1000;

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
const __firstName = (name) =>
  String(name || "").trim().split(/\s+/)[0].replace(/[^\p{L}\p{M}'-]/gu, "").slice(0, 40);

// Google access token for a service account (RFC 7523 JWT bearer grant).
// With `sub`, the token acts as that Workspace user (domain-wide delegation).
async function __saAccessToken(saJson, scope, sub) {
  const sa = JSON.parse(saJson);
  const pem = String(sa.private_key || "")
    .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
  );
  const now = Math.floor(Date.now() / 1000);
  const claimSet = {
    iss: sa.client_email,
    scope,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  if (sub) claimSet.sub = sub;
  const header = __b64url(__utf8B64(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claims = __b64url(__utf8B64(JSON.stringify(claimSet)));
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
    throw new Error("Google sign-in for the service account failed: " +
      (data.error_description || data.error || res.status));
  }
  return data.access_token;
}

// Send a plain-text email from SENDER through the Gmail API.
async function __sendMail(env, to, subject, text) {
  const token = await __saAccessToken(env.GMAIL_SA_KEY, "https://www.googleapis.com/auth/gmail.send", SENDER);
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
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: __b64url(__utf8B64(mime)) }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error("Gmail refused the email: " + ((err.error && err.error.message) || res.status));
  }
}

// ---------------------------------------------------------------------------
// POST /  — approval email
// ---------------------------------------------------------------------------
function __approvalText(to, firstName) {
  return "Hi " + (firstName || "there") + ",\n\n" +
    "Good news: your Lingonect account has been approved.\n\n" +
    "Sign in at " + SITE_URL + " with the same account you registered with (" + to + ").\n\n" +
    "Lingonect\n" + SENDER + "\n";
}

async function handleApproval(request, env, authHeader, caller, body) {
  if (!env.GMAIL_SA_KEY) {
    return json(request, 503, { error: "Email sending is not set up yet (GMAIL_SA_KEY is missing).", code: "not_configured" });
  }
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
  if (!EMAIL_RE.test(to)) {
    return json(request, 422, { error: "This request has no usable email address", code: "no_email" });
  }
  if (f.approvalEmailSentAt && body.resend !== true) {
    return json(request, 409, { error: "The approval email was already sent", code: "already_sent" });
  }

  try {
    await __sendMail(env, to, "Your Lingonect access has been approved", __approvalText(to, __firstName(name)));
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
}

// ---------------------------------------------------------------------------
// POST /delete-user  — remove an account and everything linked to it
// ---------------------------------------------------------------------------
const DELETE_REASONS = {
  abuse: "because it was used to abuse the service",
  terms: "because it did not comply with our Terms of Use",
  inactivity: "because it had not been used for more than 12 months",
  request: "at your request",
};

function __deletionText(email, firstName, reason, note) {
  return "Hi " + (firstName || "there") + ",\n\n" +
    "Your Lingonect account (" + email + ") has been deleted " + DELETE_REASONS[reason] + ".\n\n" +
    (note ? "Note: " + note + "\n\n" : "") +
    "All personal data linked to the account has been deleted, as described in our Privacy Policy (" +
    SITE_URL + "/privacy.html).\n\n" +
    (reason === "request"
      ? "If you have any questions, just reply to this email.\n\n"
      : "If you think this decision is wrong, reply to this email and we will review it.\n\n") +
    "Lingonect\n" + SENDER + "\n";
}

async function __fsGet(token, path) {
  const res = await fetch(FIRESTORE + path, { headers: { Authorization: "Bearer " + token } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("Firestore read failed (" + res.status + ") for " + path);
  return res.json();
}

// Names of every document in a collection (paginated).
async function __fsListNames(token, collectionPath) {
  const names = [];
  let pageToken = "";
  do {
    const data = await __fsGet(token, collectionPath + "?pageSize=300&mask.fieldPaths=__none__" +
      (pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : ""));
    for (const d of (data && data.documents) || []) names.push(d.name);
    pageToken = (data && data.nextPageToken) || "";
  } while (pageToken);
  return names;
}

// Chat messages in any room this uid is part of. Rooms are "<uidA>_<uidB>",
// and the TTL policy keeps only ~24h of messages, so one collection-group
// scan is small and costs a single request.
async function __chatMessageNames(token, uid) {
  const res = await fetch(FIRESTORE + ":runQuery", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "messages", allDescendants: true }],
        select: { fields: [{ fieldPath: "__name__" }] },
      },
    }),
  });
  if (!res.ok) throw new Error("Chat lookup failed (" + res.status + ")");
  const rows = await res.json();
  const names = [];
  for (const r of rows) {
    const name = r.document && r.document.name;
    const m = name && name.match(/\/chats\/([^/]+)\/messages\//);
    if (m && m[1].split("_").includes(uid)) names.push(name);
  }
  return names;
}

async function __fsDeleteAll(token, names) {
  for (let i = 0; i < names.length; i += 400) {
    const res = await fetch(FIRESTORE + ":commit", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ writes: names.slice(i, i + 400).map((n) => ({ delete: n })) }),
    });
    if (!res.ok) throw new Error("Firestore delete failed (" + res.status + ")");
  }
}

async function handleDelete(request, env, caller, body) {
  if (!env.FIREBASE_ADMIN_SA_KEY) {
    return json(request, 503, { error: "User deletion is not set up yet (FIREBASE_ADMIN_SA_KEY is missing).", code: "not_configured" });
  }
  const uid = String(body.uid || "");
  const reason = String(body.reason || "");
  const note = String(body.note || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 500);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid)) return json(request, 400, { error: "Bad uid" });
  if (!DELETE_REASONS[reason]) return json(request, 400, { error: "Pick a reason", code: "bad_reason" });
  if (uid === caller.sub) return json(request, 400, { error: "You cannot delete your own account here", code: "self" });

  let token;
  try {
    token = await __saAccessToken(env.FIREBASE_ADMIN_SA_KEY, [
      "https://www.googleapis.com/auth/cloud-platform",
      "https://www.googleapis.com/auth/firebase.database",
      "https://www.googleapis.com/auth/userinfo.email",
    ].join(" "));
  } catch (e) {
    return json(request, 502, { error: String(e.message || e), code: "admin_auth_failed" });
  }

  // Who is it? (email, name, last sign-in) from Firebase Auth.
  const lookRes = await fetch(IDENTITY + "/accounts:lookup", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ localId: [uid] }),
  });
  if (!lookRes.ok) return json(request, 502, { error: "Could not look the account up (" + lookRes.status + ")", code: "lookup_failed" });
  const user = (((await lookRes.json()) || {}).users || [])[0] || null;
  if (user && ADMIN_EMAILS.includes(user.email)) {
    return json(request, 403, { error: "Admin accounts cannot be deleted here", code: "is_admin" });
  }
  if (reason === "inactivity") {
    const last = Number((user && (user.lastLoginAt || user.createdAt)) || 0);
    if (last && Date.now() - last < INACTIVE_MS) {
      return json(request, 409, { error: "This account signed in within the last 12 months, so inactivity does not apply", code: "not_inactive" });
    }
  }

  try {
    // Fallback recipient for an account whose Auth record is already gone.
    const access = await __fsGet(token, "/accessRequests/" + uid);
    const af = (access && access.fields) || {};
    const email = (user && user.email) || (af.email && af.email.stringValue) || "";
    const name = (user && user.displayName) || (af.name && af.name.stringValue) || "";

    // Everything stored under this uid.
    const profile = await __fsGet(token, "/profiles/" + uid);
    const username = profile && profile.fields && profile.fields.username && profile.fields.username.stringValue;
    const names = [
      ...(await __fsListNames(token, "/flashcards/" + uid + "/stacks")),
      ...(await __fsListNames(token, "/history/" + uid + "/entries")),
      ...(await __chatMessageNames(token, uid)),
      DOCS_PATH + "/profiles/" + uid + "/private/info",
      DOCS_PATH + "/profiles/" + uid,
      DOCS_PATH + "/accessRequests/" + uid,
    ];
    if (username) {
      const nameDoc = await __fsGet(token, "/usernames/" + encodeURIComponent(username.toLowerCase()));
      const owner = nameDoc && nameDoc.fields && nameDoc.fields.uid && nameDoc.fields.uid.stringValue;
      if (owner === uid) names.push(DOCS_PATH + "/usernames/" + username.toLowerCase());
    }
    await __fsDeleteAll(token, names);

    // Chat presence, open chats and invites (Realtime Database).
    for (const path of ["presence", "activeChats", "invites"]) {
      const r = await fetch(RTDB_URL + "/" + path + "/" + uid + ".json?access_token=" + encodeURIComponent(token), {
        method: "DELETE",
      });
      if (!r.ok) throw new Error("Realtime Database delete failed (" + r.status + ") for " + path);
    }

    // Finally the sign-in account itself.
    if (user) {
      const delRes = await fetch(IDENTITY + "/accounts:delete", {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ localId: uid }),
      });
      if (!delRes.ok) throw new Error("Deleting the sign-in account failed (" + delRes.status + ")");
    }

    // Tell the person why (Terms of Use, "Removing Accounts").
    let emailed = false, emailError = "";
    if (EMAIL_RE.test(email) && env.GMAIL_SA_KEY) {
      try {
        await __sendMail(env, email, "Your Lingonect account has been deleted",
          __deletionText(email, __firstName(name), reason, note));
        emailed = true;
      } catch (e) {
        emailError = String(e.message || e);
      }
    } else {
      emailError = email ? "Email sending is not set up" : "No email address on file";
    }

    console.log(JSON.stringify({ lingonect: "user_deleted", uid, reason, admin: caller.email, emailed, deletedDocs: names.length }));
    return json(request, 200, { ok: true, emailed, emailError, email });
  } catch (e) {
    console.log(JSON.stringify({ lingonect: "user_delete_failed", uid, error: String(e.message || e) }));
    return json(request, 502, { error: String(e.message || e) + ". Nothing was emailed; running the deletion again is safe.", code: "delete_failed" });
  }
}

// ---------------------------------------------------------------------------
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

    let body;
    try { body = await request.json(); } catch (_) { body = {}; }

    const path = new URL(request.url).pathname;
    if (path === "/delete-user") return handleDelete(request, env, caller, body);
    return handleApproval(request, env, authHeader, caller, body);
  },
};
