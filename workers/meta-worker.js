 /**
  * Cloudflare Worker: Meta NLLB-200 Translation Proxy
  *
- * Uses the community-hosted NLLB API on Hugging Face Spaces (v4).
- * No API key required.
+ * Uses Hugging Face Inference API.
+ *
+ * Environment secrets required:
+ *   Settings > Variables and Secrets > Add:
+ *     HUGGINGFACE_API_KEY (encrypt)
  *
  * The worker will be available at:
  *   https://meta.hanyuriyu.workers.dev
  */
 
 export default {
   async fetch(request, env) {
     const CORS = {
       "Access-Control-Allow-Origin": "https://www.lingonect.com",
       "Access-Control-Allow-Methods": "POST, OPTIONS",
       "Access-Control-Allow-Headers": "Content-Type",
       "Access-Control-Max-Age": "86400",
     };
 
     if (request.method === "OPTIONS") {
       return new Response(null, { headers: CORS });
     }
 
     if (request.method !== "POST") {
       return new Response("Method not allowed", { status: 405 });
     }
 
     try {
       const { text, source, target } = await request.json();
 
       if (!text || !target) {
         return new Response(
           JSON.stringify({ error: "Missing 'text' and/or 'target' fields" }),
           { status: 400, headers: { "Content-Type": "application/json", ...CORS } }
         );
       }
 
-      const url = `https://winstxnhdw-nllb-api.hf.space/api/v4/translator?text=${encodeURIComponent(text)}&source=${encodeURIComponent(source || "eng_Latn")}&target=${encodeURIComponent(target)}`;
+      if (!env.HUGGINGFACE_API_KEY) {
+        return new Response(
+          JSON.stringify({ error: "Missing HUGGINGFACE_API_KEY secret in worker environment." }),
+          { status: 500, headers: { "Content-Type": "application/json", ...CORS } }
+        );
+      }
 
-      // Retry up to 3 times if the HF Space is sleeping (503)
+      const url = "https://api-inference.huggingface.co/models/facebook/nllb-200-distilled-600M";
+      const payload = {
+        inputs: text,
+        parameters: {
+          src_lang: source || "eng_Latn",
+          tgt_lang: target,
+        },
+      };
+
+      // Retry up to 3 times if the model is cold-starting on Hugging Face (503)
       let res;
       for (let attempt = 0; attempt < 3; attempt++) {
-        res = await fetch(url);
+        res = await fetch(url, {
+          method: "POST",
+          headers: {
+            "Authorization": `Bearer ${env.HUGGINGFACE_API_KEY}`,
+            "Content-Type": "application/json",
+          },
+          body: JSON.stringify(payload),
+        });
         if (res.status !== 503) break;
-        // Wait before retrying (space is waking up)
+        // Wait before retrying while model/container wakes up
         await new Promise(r => setTimeout(r, (attempt + 1) * 5000));
       }
 
       const raw = await res.text();
 
       // Try to parse as JSON; if not, wrap the raw text
       let data;
       try {
         data = JSON.parse(raw);
       } catch {
         data = { result: raw };
       }
 
+      // Normalize Hugging Face output format to { result }
+      if (Array.isArray(data) && data[0]?.translation_text) {
+        data = { result: data[0].translation_text };
+      } else if (typeof data?.generated_text === "string") {
+        data = { result: data.generated_text };
+      }
+
       return new Response(JSON.stringify(data), {
         status: res.status,
         headers: { "Content-Type": "application/json", ...CORS },
       });
     } catch (err) {
       return new Response(
         JSON.stringify({ error: err.message }),
         { status: 500, headers: { "Content-Type": "application/json", ...CORS } }
       );
     }
   },
 };
 
EOF
)
