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
    const data = await res.json();
    return new Response(JSON.stringify(data), {
      status: res.status,
      headers: {
        "Content-Type":                "application/json",
        "Access-Control-Allow-Origin": "https://www.lingonect.com",
      },
    });
  },
};
