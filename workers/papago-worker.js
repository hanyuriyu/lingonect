/**
 * Cloudflare Worker: Naver Papago Translate Proxy
 *
 * Proxies a {text, source, target} payload to the Naver Cloud
 * Platform Papago NMT endpoint and returns the upstream JSON
 * untouched. The client reads data.message.result.translatedText.
 *
 * If `source` is "auto", we first call the language-detection
 * endpoint and fall back to "ko" if detection fails.
 *
 * Environment secrets required (Settings > Variables and Secrets):
 *   PAPAGO_CLIENT_ID      – NCP "X-NCP-APIGW-API-KEY-ID"
 *   PAPAGO_CLIENT_SECRET  – NCP "X-NCP-APIGW-API-KEY"   (stored as Secret)
 *
 * Deploy at:
 *   https://papago.hanyuriyu.workers.dev
 */

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin":  "https://www.lingonect.com",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age":       "86400",
        },
      });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const cors = {
      "Content-Type":                "application/json",
      "Access-Control-Allow-Origin": "https://www.lingonect.com",
    };

    try {
      const { text, source, target } = await request.json();

      const clientId     = (env.PAPAGO_CLIENT_ID     || "").trim();
      const clientSecret = (env.PAPAGO_CLIENT_SECRET || "").trim();
      const ncpHeaders = {
        "X-NCP-APIGW-API-KEY-ID": clientId,
        "X-NCP-APIGW-API-KEY":    clientSecret,
      };

      // Resolve source language. Papago does not accept "auto" on /nmt/v1.
      let src = (source || "").trim();
      if (!src || src === "auto") {
        try {
          const det = await fetch(
            "https://papago.apigw.ntruss.com/langs/v1/dect",
            {
              method: "POST",
              headers: {
                ...ncpHeaders,
                "Content-Type": "application/x-www-form-urlencoded",
              },
              body: new URLSearchParams({ query: text }).toString(),
            }
          );
          const detJson = await det.json();
          src = detJson.langCode || "ko";
        } catch {
          src = "ko";
        }
      }

      if (src === target) {
        return new Response(
          JSON.stringify({
            message: { result: { srcLangType: src, tarLangType: target, translatedText: text } },
          }),
          { status: 200, headers: cors }
        );
      }

      const upstream = await fetch(
        "https://papago.apigw.ntruss.com/nmt/v1/translation",
        {
          method: "POST",
          headers: {
            ...ncpHeaders,
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept":       "application/json",
          },
          body: new URLSearchParams({
            source: src,
            target: target,
            text:   text,
          }).toString(),
        }
      );

      const body = await upstream.text();
      return new Response(body, { status: upstream.status, headers: cors });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: { message: err.message } }),
        { status: 500, headers: cors }
      );
    }
  },
};
