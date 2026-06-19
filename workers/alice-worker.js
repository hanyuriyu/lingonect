/**
 * Cloudflare Worker: Alice AI LLM (Yandex) Translation Proxy
 *
 * Alice AI LLM is Yandex's text-generation foundation model, served through
 * Yandex AI Studio's OpenAI-compatible Completions API. This worker proxies
 * the same request/response shape used by the DeepSeek / Doubao workers
 * ({ messages } in, { choices: [{ message: { content } }] } out).
 *
 * Environment secrets required:
 *   Settings > Variables and Secrets > Add (encrypt):
 *     ALICE_API_KEY    — Yandex Cloud API key (service account needs the
 *                        ai.languageModels.user role)
 *     ALICE_FOLDER_ID  — Yandex Cloud folder ID (used to build the model URI)
 *
 * The worker will be available at:
 *   https://alice.hanyuriyu.workers.dev
 */

const ALICE_API_URL = "https://ai.api.cloud.yandex.net/v1/chat/completions";
const ALICE_MODEL = "aliceai-llm/latest"; // model name within the folder

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
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }
    try {
      const body = await request.json();
      // Yandex's OpenAI-compatible endpoint expects the model URI
      // gpt://<folder-id>/<model> — built here so the folder ID never
      // leaves the worker.
      const modelUri = `gpt://${(env.ALICE_FOLDER_ID || "").trim()}/${ALICE_MODEL}`;
      const res = await fetch(ALICE_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Api-Key ${(env.ALICE_API_KEY || "").trim()}`,
        },
        body: JSON.stringify({
          model: modelUri,
          messages: body.messages,
          temperature: body.temperature ?? 0.3,
          max_tokens: body.max_tokens ?? 1024,
        }),
      });
      // Forward the upstream body and status verbatim so real error
      // messages (auth failures, missing role, region blocks, or a
      // Cloudflare "error code: NNNN" page) reach the client instead of
      // being collapsed into a JSON-parse error.
      const body = await res.text();
      return new Response(body, {
        status: res.status,
        headers: {
          "Content-Type": res.headers.get("Content-Type") || "application/json",
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
