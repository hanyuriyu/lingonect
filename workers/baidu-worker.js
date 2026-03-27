/**
 * Cloudflare Worker: Baidu Translate Proxy
 *
 * Environment secrets required:
 *   npx wrangler secret put BAIDU_APP_ID
 *   npx wrangler secret put BAIDU_SECRET_KEY
 *
 * The worker will be available at:
 *   https://baidu.hanyuriyu.workers.dev
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
      const { text, from, to } = await request.json();

      const appid = env.BAIDU_APP_ID;
      const key = env.BAIDU_SECRET_KEY;
      const salt = String(Date.now());
      const sign = await md5(appid + text + salt + key);

      const params = new URLSearchParams({
        q: text,
        from: from || "auto",
        to: to,
        appid: appid,
        salt: salt,
        sign: sign,
      });

      const res = await fetch(
        `https://fanyi-api.baidu.com/api/trans/vip/translate?${params}`,
        { method: "GET" }
      );

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

// ── MD5 helper using Web Crypto API ──

async function md5(message) {
  const data = new TextEncoder().encode(message);
  const hash = await crypto.subtle.digest("MD5", data);
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
