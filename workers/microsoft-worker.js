/**
 * Cloudflare Worker: Microsoft Translator Proxy
 *
 * Environment secrets required:
 *   npx wrangler secret put AZURE_TRANSLATOR_KEY
 *
 * The worker will be available at:
 *   https://microsoft.hanyuriyu.workers.dev
 */

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
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
      const { text, from, to } = await request.json();

      const params = new URLSearchParams({
        "api-version": "3.0",
        to: to,
      });
      if (from) params.set("from", from);

      const res = await fetch(
        `https://api.cognitive.microsofttranslator.com/translate?${params}`,
        {
          method: "POST",
          headers: {
            "Ocp-Apim-Subscription-Key": env.AZURE_TRANSLATOR_KEY,
            "Ocp-Apim-Subscription-Region": "westeurope",
            "Content-Type": "application/json",
          },
          body: JSON.stringify([{ Text: text }]),
        }
      );

      const data = await res.json();

      return new Response(JSON.stringify(data), {
        status: res.status,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: { message: err.message } }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }
  },
};
