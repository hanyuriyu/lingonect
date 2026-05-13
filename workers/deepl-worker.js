/**
 * Cloudflare Worker: DeepL Translation Proxy
 *
 * Environment secrets required:
 *   Settings > Variables and Secrets > Add:
 *     DEEPL_API_KEY (encrypt)
 *
 * The worker will be available at:
 *   https://deepl.hanyuriyu.workers.dev
 */

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "https://www.lingonect.com",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    const cors = {
      "Content-Type":                "application/json",
      "Access-Control-Allow-Origin": "https://www.lingonect.com",
    };

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: cors });
    }

    try {
      const body = await request.json();
      const res = await fetch("https://api-free.deepl.com/v2/translate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `DeepL-Auth-Key ${env.DEEPL_API_KEY}`,
        },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      return new Response(text, { status: res.status, headers: cors });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: err.message || "DeepL worker error" }),
        { status: 500, headers: cors }
      );
    }
  },
};
