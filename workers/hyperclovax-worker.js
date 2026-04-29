/**
 * Cloudflare Worker: Naver HyperCLOVA X Proxy
 *
 * Proxies a {system, prompt} payload to Naver Cloud Platform
 * CLOVA Studio chat-completions and returns the upstream JSON
 * untouched (the client reads data.result.message.content).
 *
 * Environment secrets required (Settings > Variables and Secrets):
 *   HYPERCLOVAX_API_KEY  – Bearer token issued in CLOVA Studio
 *                          (starts with "nv-..."), stored as a Secret
 *   HYPERCLOVAX_MODEL    – (optional) model id, defaults to HCX-005
 *
 * Deploy at:
 *   https://hyperclovax.hanyuriyu.workers.dev
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
      const { system, prompt } = await request.json();

      const model = (env.HYPERCLOVAX_MODEL || "HCX-005").trim();
      const key   = (env.HYPERCLOVAX_API_KEY || "").trim();

      const reqId = crypto.randomUUID().replace(/-/g, "");

      const upstream = await fetch(
        `https://clovastudio.stream.ntruss.com/v3/chat-completions/${model}`,
        {
          method: "POST",
          headers: {
            "Authorization":                  `Bearer ${key}`,
            "X-NCP-CLOVASTUDIO-REQUEST-ID":   reqId,
            "Content-Type":                   "application/json",
            "Accept":                         "application/json",
          },
          body: JSON.stringify({
            messages: [
              { role: "system", content: system || "" },
              { role: "user",   content: prompt || "" },
            ],
            topP:           0.8,
            topK:           0,
            maxTokens:      1024,
            temperature:    0.3,
            repeatPenalty:  1.1,
            stopBefore:     [],
            includeAiFilters: false,
          }),
        }
      );

      const text = await upstream.text();
      return new Response(text, { status: upstream.status, headers: cors });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: { message: err.message } }),
        { status: 500, headers: cors }
      );
    }
  },
};
