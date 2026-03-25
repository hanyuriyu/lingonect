/**
 * Cloudflare Worker: Jais Translation Proxy (via Azure AI Foundry)
 *
 * Environment secrets required:
 *   Settings > Variables and Secrets > Add:
 *     JAIS_ENDPOINT  (e.g. https://<resource>.services.ai.azure.com)
 *     JAIS_API_KEY   (encrypt)
 *
 * Deploy jais-30b-chat as a serverless API in Azure AI Foundry,
 * then set the endpoint URL and API key above.
 *
 * The worker will be available at:
 *   https://jais.hanyuriyu.workers.dev
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
      const endpoint = env.JAIS_ENDPOINT.replace(/\/$/, "");
      const res = await fetch(
        `${endpoint}/models/chat/completions?api-version=2024-05-01-preview`,
        {
          method: "POST",
          headers: {
            "api-key": env.JAIS_API_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "jais-30b-chat",
            messages: body.messages,
            max_tokens: body.max_tokens || 1024,
            temperature: body.temperature || 0.3,
          }),
        }
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
