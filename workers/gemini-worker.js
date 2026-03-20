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
          "Access-Control-Allow-Methods": "POST",
          "Access-Control-Allow-Headers": "Content-Type"
        }
      });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }
    const { targetLang, text } = await request.json();
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `Translate into ${targetLang}. Output ONLY translated text.\n\n<text>${text}</text>`
            }]
          }]
        })
      }
    );
    const data = await response.json();
    if (!response.ok) {
      return new Response(JSON.stringify({ type: "error", error: { message: data.error?.message ?? "Gemini error" } }), {
        status: response.status,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://www.lingonect.com" }
      });
    }
    const translated = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    return new Response(JSON.stringify({ translated }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "https://www.lingonect.com"
      }
    });
  }
};
