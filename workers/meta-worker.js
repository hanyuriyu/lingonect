/**
 * Cloudflare Worker: Meta NLLB-200 Translation Proxy
 *
 * Uses the MyMemory Translation API as the backend.
 * No API token required (free tier: 5,000 chars/day anonymous).
 *
 * The worker will be available at:
 *   https://meta.hanyuriyu.workers.dev
 */

// Map FLORES-200 codes (sent by frontend) to ISO-639 codes (used by MyMemory)
const FLORES_TO_ISO = {
  "eng_Latn": "en", "spa_Latn": "es", "fra_Latn": "fr", "deu_Latn": "de", "ita_Latn": "it",
  "por_Latn": "pt", "swe_Latn": "sv", "nob_Latn": "no", "dan_Latn": "da", "fin_Latn": "fi",
  "nld_Latn": "nl", "pol_Latn": "pl", "rus_Cyrl": "ru", "ukr_Cyrl": "uk", "tur_Latn": "tr",
  "ell_Grek": "el", "ron_Latn": "ro", "hun_Latn": "hu", "ces_Latn": "cs", "slk_Latn": "sk",
  "bul_Cyrl": "bg", "hrv_Latn": "hr", "srp_Cyrl": "sr", "lit_Latn": "lt",
  "lvs_Latn": "lv", "est_Latn": "et", "slv_Latn": "sl", "cat_Latn": "ca", "isl_Latn": "is",
  "arb_Arab": "ar", "heb_Hebr": "he", "pes_Arab": "fa", "hin_Deva": "hi", "urd_Arab": "ur", "ben_Beng": "bn",
  "jpn_Jpan": "ja", "zho_Hans": "zh-CN", "zho_Hant": "zh-TW", "kor_Hang": "ko",
  "tha_Thai": "th", "vie_Latn": "vi", "ind_Latn": "id", "zsm_Latn": "ms", "tgl_Latn": "tl",
};

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

      const srcISO = FLORES_TO_ISO[source || "eng_Latn"];
      const tgtISO = FLORES_TO_ISO[target];

      if (!tgtISO) {
        return new Response(
          JSON.stringify({ error: `Unsupported target language: ${target}` }),
          { status: 200, headers: { "Content-Type": "application/json", ...CORS } }
        );
      }

      const langpair = `${srcISO || "en"}|${tgtISO}`;
      const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(langpair)}`;

      const res = await fetch(url);
      const data = await res.json();

      if (!res.ok || !data.responseData) {
        const msg = data?.responseDetails || data?.error || `MyMemory API ${res.status}`;
        return new Response(
          JSON.stringify({ error: msg }),
          { status: 200, headers: { "Content-Type": "application/json", ...CORS } }
        );
      }

      // MyMemory returns { responseData: { translatedText: "..." }, responseStatus: 200 }
      const translated = data.responseData.translatedText || "";

      return new Response(JSON.stringify({ result: translated }), {
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
