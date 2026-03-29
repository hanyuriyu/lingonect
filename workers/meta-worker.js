/**
 * Cloudflare Worker: Meta NLLB-200 Translation Proxy
 *
 * Uses the Hugging Face Inference API with the
 * facebook/nllb-200-distilled-600M model.
 *
 * Environment secrets required:
 *   HF_API_TOKEN – Hugging Face API token (free tier works)
 *
 * The worker will be available at:
 *   https://meta.hanyuriyu.workers.dev
 */

export default {
  async fetch(request, env) {
    const CORS = {
      "Access-Control-Allow-Origin": "https://www.lingonect.com",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    try {
      const { text, source, target } = await request.json();

      if (!text || !target) {
        return new Response(
          JSON.stringify({ error: "Missing 'text' and/or 'target' fields" }),
          { status: 400, headers: { "Content-Type": "application/json", ...CORS } }
        );
      }

      const hfToken = (env.HF_API_TOKEN || "").trim();

      // Retry up to 3 times if the model is loading (503)
      let res;
      for (let attempt = 0; attempt < 3; attempt++) {
        res = await fetch(
          "https://router.huggingface.co/hf-inference/models/facebook/nllb-200-distilled-600M",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(hfToken ? { "Authorization": `Bearer ${hfToken}` } : {}),
            },
            body: JSON.stringify({
              inputs: text,
              parameters: {
                src_lang: source || "eng_Latn",
                tgt_lang: target,
              },
            }),
          }
        );
        if (res.status !== 503) break;
        await new Promise(r => setTimeout(r, (attempt + 1) * 5000));
      }

      const data = await res.json();

      // Normalize response: HF returns [{ translation_text: "..." }]
      let result;
      if (Array.isArray(data) && data[0]?.translation_text) {
        result = { result: data[0].translation_text };
      } else {
        result = data;
      }

      return new Response(JSON.stringify(result), {
        status: res.status,
        headers: { "Content-Type": "application/json", ...CORS },
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: err.message }),
        { status: 500, headers: { "Content-Type": "application/json", ...CORS } }
      );
    }
  },
};
