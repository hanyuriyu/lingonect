/**
 * Cloudflare Worker: Jais Translation Proxy (via Hugging Face Inference Providers)
 *
 * Environment secrets required:
 *   Settings > Variables and Secrets > Add:
 *     HF_TOKEN (encrypt)
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
      const res = await fetch(
        "https://router.huggingface.co/hf-inference/models/inceptionai/Jais-2-8B-Chat/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.HF_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "inceptionai/Jais-2-8B-Chat",
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
