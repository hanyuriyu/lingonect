/**
 * Cloudflare Worker: Claude (Anthropic) Translation Proxy
 *
 * Environment secrets required:
 *   Settings > Variables and Secrets > Add:
 *     ANTHROPIC_KEY (encrypt)
 *
 * The worker will be available at:
 *   https://claudetranslate.hanyuriyu.workers.dev
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
      return new Response(JSON.stringify({ type: "error", error: { message: "Method not allowed" } }), { status: 405, headers: cors });
    }

    try {
      const body = await request.json();
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type":      "application/json",
          "x-api-key":         env.ANTHROPIC_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      return new Response(text, { status: res.status, headers: cors });
    } catch (err) {
      return new Response(
        JSON.stringify({ type: "error", error: { message: err.message || "Claude worker error" } }),
        { status: 500, headers: cors }
      );
    }
  },
};
