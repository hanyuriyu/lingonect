/**
 * Cloudflare Worker: Gemini Translation Proxy
 *
 * Environment secrets required:
 *   npx wrangler secret put GEMINI_API_KEY
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
      const model = body.model || "gemini-2.5-flash";

      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  {
                    text: `Translate the following text into ${body.targetLang}. Output ONLY the translated text, no explanation.\n\n${body.text}`,
                  },
                ],
              },
            ],
          }),
        }
      );

      const data = await res.json();

      if (!res.ok) {
        return new Response(JSON.stringify({ error: data.error || data }), {
          status: res.status,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "https://www.lingonect.com",
          },
        });
      }

      const translated =
        data.candidates?.[0]?.content?.parts?.[0]?.text || "";

      return new Response(JSON.stringify({ translated }), {
        status: 200,
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
