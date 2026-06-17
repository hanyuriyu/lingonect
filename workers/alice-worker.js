/**
 * Cloudflare Worker: Alice (AliceAI) Translation Proxy
 *
 * Alice is proxied as an OpenAI-compatible chat-completions service — the same
 * request/response shape used by the DeepSeek, Alibaba and Grok workers
 * ({ model, messages } in, { choices: [{ message: { content } }] } out).
 *
 * Environment secrets required:
 *   Settings > Variables and Secrets > Add:
 *     ALICE_API_KEY (encrypt)   — your AliceAI API key
 *
 * IMPORTANT — set the upstream endpoint:
 *   Replace ALICE_API_URL below with AliceAI's real OpenAI-compatible
 *   /chat/completions endpoint. (Left as a placeholder because the provider's
 *   base URL wasn't specified.) If Alice's API differs from the OpenAI shape,
 *   adjust the request body / response parsing to match.
 *
 * The worker will be available at:
 *   https://alice.hanyuriyu.workers.dev
 */

const ALICE_API_URL = "https://api.aliceai.example/v1/chat/completions"; // TODO: set real endpoint

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
      const res = await fetch(ALICE_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${env.ALICE_API_KEY}`,
        },
        body: JSON.stringify({
          model: body.model || "alice",
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
