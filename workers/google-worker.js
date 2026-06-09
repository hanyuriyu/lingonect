/**
 * Cloudflare Worker: Google Translate (Cloud Translation v2) Proxy
 *
 * Environment secrets required:
 *   npx wrangler secret put GOOGLE_TRANSLATE_KEY
 *   (or Settings > Variables and Secrets > Add: GOOGLE_TRANSLATE_KEY, encrypt)
 *
 * The key must NOT use an "HTTP referrer" restriction (the worker sends no
 * referer). Restrict it instead to the "Cloud Translation API" under
 * Application restrictions > API restrictions.
 *
 * The worker will be available at:
 *   https://googletranslate.hanyuriyu.workers.dev
 */

export default {
  async fetch(request, env) {
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

    const cors = {
      "Content-Type":                "application/json",
      "Access-Control-Allow-Origin": "https://www.lingonect.com",
    };

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: cors });
    }

    try {
      const body = await request.json();
      const res = await fetch(
        `https://translation.googleapis.com/language/translate/v2?key=${env.GOOGLE_TRANSLATE_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );
      // Forward Google's body verbatim so upstream error messages reach the
      // client instead of being collapsed into a bare HTTP status.
      const text = await res.text();
      return new Response(text, { status: res.status, headers: cors });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: { message: err.message || "Google Translate worker error" } }),
        { status: 500, headers: cors }
      );
    }
  },
};
