/**
 * Cloudflare Worker: Meta NLLB-200 Translation Proxy
 *
 * Uses the community-hosted NLLB API on Hugging Face Spaces.
 * No API key required — the model runs on a free HF Space.
 *
 * The worker will be available at:
 *   https://meta.hanyuriyu.workers.dev
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
      const { text, source, target } = await request.json();

      if (!text || !target) {
        return new Response(
          JSON.stringify({ error: "Missing 'text' and/or 'target' fields" }),
          {
            status: 400,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "https://www.lingonect.com",
            },
          }
        );
      }

      const params = new URLSearchParams({
        text: text,
        source: source || "eng_Latn",
        target: target,
      });

      const res = await fetch(
        `https://winstxnhdw-nllb-api.hf.space/api/v4/translator?${params}`,
        { method: "GET" }
      );

      const data = await res.json();

      // The API returns { result: "translated text" }
      return new Response(JSON.stringify(data), {
        status: res.status,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "https://www.lingonect.com",
        },
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: err.message }),
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
