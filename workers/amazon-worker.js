/**
 * Cloudflare Worker: Amazon Translate Proxy
 *
 * Environment secrets required (Settings > Variables and Secrets > Add):
 *   AWS_ACCESS_KEY_ID     (encrypt)
 *   AWS_SECRET_ACCESS_KEY (encrypt)
 *
 * The worker will be available at:
 *   https://amazon.hanyuriyu.workers.dev
 */

const REGION = "us-east-1";
const SERVICE = "translate";
const HOST = `translate.${REGION}.amazonaws.com`;
const ENDPOINT = `https://${HOST}/`;
const TARGET = "AWSShineFrontendService_20170701.TranslateText";

const encoder = new TextEncoder();

async function hmac(key, msg) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    typeof key === "string" ? encoder.encode(key) : key,
    { name: "HMAC", hash: { name: "SHA-256" } },
    false,
    ["sign"]
  );
  return await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(msg));
}

async function sha256(data) {
  return await crypto.subtle.digest("SHA-256", encoder.encode(data));
}

function hex(buffer) {
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sign(secretKey, accessKeyId, payload) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);

  const payloadHash = hex(await sha256(payload));

  // Only sign the three required headers
  const signedHeaders = "content-type;host;x-amz-date";
  const canonicalHeaders =
    "content-type:application/x-amz-json-1.1\n" +
    `host:${HOST}\n` +
    `x-amz-date:${amzDate}\n`;

  const canonicalRequest =
    "POST\n" +
    "/\n" +
    "\n" +
    canonicalHeaders + "\n" +
    signedHeaders + "\n" +
    payloadHash;

  const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign =
    "AWS4-HMAC-SHA256\n" +
    amzDate + "\n" +
    credentialScope + "\n" +
    hex(await sha256(canonicalRequest));

  // Derive signing key
  const kDate = await hmac("AWS4" + secretKey, dateStamp);
  const kRegion = await hmac(kDate, REGION);
  const kService = await hmac(kRegion, SERVICE);
  const kSigning = await hmac(kService, "aws4_request");
  const signature = hex(await hmac(kSigning, stringToSign));

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { authorization, amzDate };
}

const CORS = {
  "Access-Control-Allow-Origin": "https://www.lingonect.com",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: { ...CORS, "Access-Control-Max-Age": "86400" } });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    try {
      const { text, from, to } = await request.json();

      const payload = JSON.stringify({
        SourceLanguageCode: from || "auto",
        TargetLanguageCode: to,
        Text: text,
      });

      const { authorization, amzDate } = await sign(
        env.AWS_SECRET_ACCESS_KEY,
        env.AWS_ACCESS_KEY_ID,
        payload
      );

      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-amz-json-1.1",
          "X-Amz-Date": amzDate,
          "X-Amz-Target": TARGET,
          Authorization: authorization,
        },
        body: payload,
      });

      const data = await res.json();

      return new Response(JSON.stringify(data), {
        status: res.status,
        headers: { "Content-Type": "application/json", ...CORS },
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: { message: err.message } }),
        { status: 500, headers: { "Content-Type": "application/json", ...CORS } }
      );
    }
  },
};
