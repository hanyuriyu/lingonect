/**
 * Cloudflare Worker: Meta NLLB-200 Translation Proxy
 *
 * Uses community-hosted NLLB API Spaces on Hugging Face that run
 * facebook/nllb-200-distilled-600M (or 1.3B) via CTranslate2.
 *
 * No API token required.
 *
 * The worker will be available at:
 *   https://meta.hanyuriyu.workers.dev
 */

// NLLB API endpoints to try in order (add your own HF Space duplicate first)
const NLLB_ENDPOINTS = [
  "https://winstxnhdw-nllb-api.hf.space/api/v4/translator",
];

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

      const srcLang = source || "eng_Latn";
      let lastError = "";

      for (const endpoint of NLLB_ENDPOINTS) {
        const url = `${endpoint}?text=${encodeURIComponent(text)}&source=${encodeURIComponent(srcLang)}&target=${encodeURIComponent(target)}`;

        // Retry up to 3 times if the Space is waking up (503)
        let res;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            res = await fetch(url);
          } catch {
            continue;
          }
          if (res.status !== 503) break;
          await new Promise(r => setTimeout(r, (attempt + 1) * 5000));
        }

        if (!res || !res.ok) {
          lastError = res ? await res.text() : "fetch failed";
          continue; // try next endpoint
        }

        const raw = await res.text();

        let data;
        try { data = JSON.parse(raw); } catch { data = null; }

        // Normalize response
        let result;
        if (typeof data === "string") {
          result = data;
        } else if (data?.result) {
          result = data.result;
        } else if (Array.isArray(data) && data[0]?.translation_text) {
          result = data[0].translation_text;
        } else {
          result = raw.trim();
        }

        return new Response(JSON.stringify({ result }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...CORS },
        });
      }

      // All endpoints failed
      let errorMsg;
      try {
        const parsed = JSON.parse(lastError);
        errorMsg = parsed?.error || parsed?.detail || lastError;
      } catch {
        errorMsg = lastError;
      }
      return new Response(
        JSON.stringify({ error: errorMsg || "All NLLB endpoints unavailable" }),
        { status: 200, headers: { "Content-Type": "application/json", ...CORS } }
      );
    } catch (err) {
      return new Response(
        JSON.stringify({ error: err.message }),
        { status: 500, headers: { "Content-Type": "application/json", ...CORS } }
      );
    }
  },
};
