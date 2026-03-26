/**
 * Cloudflare Worker: Meta NLLB-200 Translation Proxy
 *
 * Uses Hugging Face Inference API with the NLLB-200 model.
 *
 * Environment secrets required:
 *   Settings > Variables and Secrets > Add:
 *     HF_TOKEN (encrypt) — Hugging Face access token (free, read-only)
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

      // Try the new HF Inference Providers endpoint first, fall back to legacy
      const endpoints = [
        "https://router.huggingface.co/hf-inference/models/facebook/nllb-200-distilled-600M",
        "https://api-inference.huggingface.co/models/facebook/nllb-200-distilled-600M",
      ];

      let res;
      let data;

      for (const endpoint of endpoints) {
        res = await fetch(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.HF_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            inputs: text,
            parameters: {
              src_lang: source || "eng_Latn",
              tgt_lang: target,
            },
          }),
        });

        data = await res.json();

        // If successful or a non-routing error, stop trying
        if (res.ok || (res.status !== 410 && res.status !== 404)) break;
      }

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
