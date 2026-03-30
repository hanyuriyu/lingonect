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

// AWS Signature V4 helpers

async function hmacSha256(key, message) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    typeof key === "string" ? new TextEncoder().encode(key) : key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message))
  );
}

async function sha256Hex(data) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function getSignatureKey(secretKey, dateStamp, region, service) {
  let key = await hmacSha256("AWS4" + secretKey, dateStamp);
  key = await hmacSha256(key, region);
  key = await hmacSha256(key, service);
  key = await hmacSha256(key, "aws4_request");
  return key;
}

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
      const { text, from, to } = await request.json();
      const region = "eu-west-1";
      const service = "translate";
      const host = `translate.${region}.amazonaws.com`;
      const endpoint = `https://${host}/`;

      const payload = JSON.stringify({
        SourceLanguageCode: from || "auto",
        TargetLanguageCode: to,
        Text: text,
      });

      const now = new Date();
      const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
      const dateStamp = amzDate.slice(0, 8);

      const payloadHash = await sha256Hex(payload);
      const canonicalHeaders = `content-type:application/x-amz-json-1.1\nhost:${host}\nx-amz-date:${amzDate}\nx-amz-target:AWSShineFrontendService_20170701.TranslateText\n`;
      const signedHeaders = "content-type;host;x-amz-date;x-amz-target";

      const canonicalRequest = [
        "POST",
        "/",
        "",
        canonicalHeaders,
        signedHeaders,
        payloadHash,
      ].join("\n");

      const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
      const stringToSign = [
        "AWS4-HMAC-SHA256",
        amzDate,
        credentialScope,
        await sha256Hex(canonicalRequest),
      ].join("\n");

      const signingKey = await getSignatureKey(
        env.AWS_SECRET_ACCESS_KEY,
        dateStamp,
        region,
        service
      );
      const signature = toHex(await hmacSha256(signingKey, stringToSign));

      const authHeader = `AWS4-HMAC-SHA256 Credential=${env.AWS_ACCESS_KEY_ID}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-amz-json-1.1",
          "X-Amz-Date": amzDate,
          "X-Amz-Target": "AWSShineFrontendService_20170701.TranslateText",
          Authorization: authHeader,
          Host: host,
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
