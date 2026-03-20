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

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "https://www.lingonect.com",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
        },
      });
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
