/**
 * Cloudflare Worker: Z.ai (Zhipu GLM) Translation Proxy
 *
 * Z.ai exposes an OpenAI-compatible /chat/completions endpoint, so this
 * worker mirrors the request/response shape of the DeepSeek / Doubao workers.
 *
 * Environment secrets required:
 *   Settings > Variables and Secrets > Add:
 *     ZAI_API_KEY (encrypt)   — your Z.ai (api.z.ai) API key
 *
 * Notes:
 *   - `model` is sent by the client (e.g. "glm-4.6"); the default below is
 *     used as a fallback. Swap it if you prefer a different GLM model.
 *
 * The worker will be available at:
 *   https://zai.hanyuriyu.workers.dev
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
      const res = await fetch("https://api.z.ai/api/paas/v4/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${env.ZAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: body.model || "glm-4.6",
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
