/**
 * Cloudflare Worker: Meta NLLB-200 Translation Proxy
 *
 * Uses the community-hosted NLLB API on Hugging Face Spaces
 * (winstxnhdw/nllb-api) which runs facebook/nllb-200-distilled-600M
 * via CTranslate2.
 *
 * No API token required.
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

      const srcLang = source || "eng_Latn";
      const url = `https://winstxnhdw-nllb-api.hf.space/api/v4/translator?text=${encodeURIComponent(text)}&source=${encodeURIComponent(srcLang)}&target=${encodeURIComponent(target)}`;

      // Retry up to 3 times if the Space is waking up (503)
      let res;
      for (let attempt = 0; attempt < 3; attempt++) {
        res = await fetch(url);
        if (res.status !== 503) break;
        await new Promise(r => setTimeout(r, (attempt + 1) * 5000));
      }

      const raw = await res.text();

      let data;
      try { data = JSON.parse(raw); } catch { data = { error: raw }; }

      // If the API returned an error, surface it
      if (!res.ok) {
        const msg = data?.error || data?.detail || raw || `NLLB API ${res.status}`;
        return new Response(
          JSON.stringify({ error: msg }),
          { status: 200, headers: { "Content-Type": "application/json", ...CORS } }
        );
      }

      // Normalize response: the API returns { result: "..." } or plain text
      let result;
      if (typeof data === "string") {
        result = { result: data };
      } else if (data?.result) {
        result = { result: data.result };
      } else if (Array.isArray(data) && data[0]?.translation_text) {
        result = { result: data[0].translation_text };
      } else {
        result = { result: raw.trim() };
      }

      return new Response(JSON.stringify(result), {
        status: 200,
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
