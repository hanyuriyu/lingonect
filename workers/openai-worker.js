/**
 * Cloudflare Worker: OpenAI Translation Proxy
 *
 * Environment secrets required:
 *   Settings > Variables and Secrets > Add:
 *     OPENAI_KEY (encrypt)
 *
 * The worker will be available at:
 *   https://openai.hanyuriyu.workers.dev
 */

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin":  "https://www.lingonect.com",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        }
      });
    }
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const corsHeaders = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "https://www.lingonect.com"
    };
    try {
      const body = await request.json();
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": `Bearer ${env.OPENAI_KEY}`
        },
        body: JSON.stringify(body)
      });
      const text = await res.text();
      return new Response(text, { status: res.status, headers: corsHeaders });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
    }
  }
};
