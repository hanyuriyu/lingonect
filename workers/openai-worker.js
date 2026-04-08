/**
 * Cloudflare Worker: OpenAI Proxy
 *
 * Routes:
 *   POST /       -> https://api.openai.com/v1/chat/completions  (JSON in, JSON out)
 *   POST /tts    -> https://api.openai.com/v1/audio/speech      (JSON in, audio/mpeg out)
 *
 * Environment secrets required:
 *   Settings > Variables and Secrets > Add:
 *     OPENAI_KEY (encrypt)
 *
 * The worker will be available at:
 *   https://openai.hanyuriyu.workers.dev
 */

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin":  "https://www.lingonect.com",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        }
      });
    }
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

    const baseCors = {
      "Access-Control-Allow-Origin": "https://www.lingonect.com"
    };
    const jsonHeaders = { ...baseCors, "Content-Type": "application/json" };

    const url = new URL(request.url);
    const isTTS = url.pathname === "/tts";

    try {
      const body = await request.json();

      if (isTTS) {
        const res = await fetch("https://api.openai.com/v1/audio/speech", {
          method: "POST",
          headers: {
            "Content-Type":  "application/json",
            "Authorization": `Bearer ${env.OPENAI_KEY}`
          },
          body: JSON.stringify(body)
        });
        if (!res.ok) {
          // Upstream returned an error — forward it as JSON so the client
          // can log a useful message instead of trying to decode audio.
          const errText = await res.text();
          return new Response(errText, { status: res.status, headers: jsonHeaders });
        }
        const audio = await res.arrayBuffer();
        return new Response(audio, {
          status: 200,
          headers: {
            ...baseCors,
            "Content-Type": "audio/mpeg",
            // Short browser cache so quickly replaying the same word stays free.
            "Cache-Control": "public, max-age=86400"
          }
        });
      }

      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": `Bearer ${env.OPENAI_KEY}`
        },
        body: JSON.stringify(body)
      });
      const text = await res.text();
      return new Response(text, { status: res.status, headers: jsonHeaders });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: jsonHeaders });
    }
  }
};
