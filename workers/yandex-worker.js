/**
 * Cloudflare Worker: Yandex Translate Proxy
 *
 * Environment secrets required:
 *   YANDEX_API_KEY   – API key from Yandex Cloud
 *   YANDEX_FOLDER_ID – Folder ID from Yandex Cloud console
 *
 * The worker will be available at:
 *   https://yandex.hanyuriyu.workers.dev
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

      const res = await fetch(
        "https://translate.api.cloud.yandex.net/translate/v2/translate",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Api-Key ${(env.YANDEX_API_KEY || "").trim()}`,
          },
          body: JSON.stringify({
            folderId: (env.YANDEX_FOLDER_ID || "").trim(),
            texts: [text],
            sourceLanguageCode: source || "",
            targetLanguageCode: target,
          }),
        }
      );

      const data = await res.json();

      return new Response(JSON.stringify(data), {
        status: res.status,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "https://www.lingonect.com",
        },
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: { message: err.message } }),
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
