/**
 * Cloudflare Worker: Doubao (ByteDance) Translation Proxy
 *
 * Doubao is served through Volcengine Ark, which exposes an
 * OpenAI-compatible /chat/completions endpoint.
 *
 * Environment secrets required:
 *   Settings > Variables and Secrets > Add:
 *     ARK_API_KEY (encrypt)   — your Volcengine Ark API key
 *
 * Notes:
 *   - `model` is sent by the client as "doubao-pro-32k". On Volcengine Ark you
 *     may instead need to pass your own inference Endpoint ID (e.g. "ep-2024...")
 *     depending on how your account is set up. If so, change the default below
 *     or the model name in engines.html accordingly.
 *
 * The worker will be available at:
 *   https://doubao.hanyuriyu.workers.dev
 */

export default {
  async fetch(request, env) {
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
      const res = await fetch("https://ark.cn-beijing.volces.com/api/v3/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${env.ARK_API_KEY}`,
        },
        body: JSON.stringify({
          model: body.model || "doubao-pro-32k",
          messages: body.messages,
          temperature: body.temperature ?? 0.3,
          max_tokens: body.max_tokens ?? 1024,
        }),
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
      return new Response(JSON.stringify({ error: { message: err.message } }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "https://www.lingonect.com",
        },
      });
    }
  },
};
