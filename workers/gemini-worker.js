/**
 * Cloudflare Worker: Gemini Translation Proxy
 *
 * Environment secrets required:
 *   Settings > Variables and Secrets > Add:
 *     GEMINI_API_KEY (encrypt)
 *
 * The worker will be available at:
 *   https://geminitranslate.hanyuriyu.workers.dev
 */

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "https://www.lingonect.com",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        }
      });
    }

    const cors = {
      "Content-Type":                "application/json",
      "Access-Control-Allow-Origin": "https://www.lingonect.com",
    };

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: { message: "Method not allowed" } }), { status: 405, headers: cors });
    }

    try {
      const body = await request.json();
      const { targetLang, text, model, instruction } = body;
      const modelId = model || "gemini-2.5-flash";
      // The client sends a methodology-aware system prompt as `instruction`
      // (translate / transcreate / culturalize, plus any localization length
      // constraint). Fall back to a plain translation instruction.
      const promptInstruction = instruction
        || `Translate into ${targetLang}. Output ONLY translated text.`;
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1/models/${modelId}:generateContent?key=${env.GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{
              parts: [{
                text: `${promptInstruction}\n\n<text>${text}</text>`
              }]
            }]
          })
        }
      );
      const raw = await response.text();
      let data;
      try { data = JSON.parse(raw); } catch { data = null; }
      if (!response.ok) {
        const msg = data?.error?.message || raw.slice(0, 200) || `HTTP ${response.status}`;
        return new Response(JSON.stringify({ error: { message: msg } }), { status: response.status, headers: cors });
      }
      const translated = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      return new Response(JSON.stringify({ translated }), { headers: cors });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: { message: err.message || "Gemini worker error" } }),
        { status: 500, headers: cors }
      );
    }
  }
};
