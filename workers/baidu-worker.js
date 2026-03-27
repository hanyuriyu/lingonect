/**
 * Cloudflare Worker: Baidu Translate Proxy
 *
 * Environment secrets required:
 *   BAIDU_APP_ID     – numeric App ID from 开发者信息
 *   BAIDU_SECRET_KEY – secret key (密钥) from 开发者信息
 *
 * The worker will be available at:
 *   https://baidu.hanyuriyu.workers.dev
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

    // Temporary debug endpoint — visit the worker URL in browser to check env vars
    if (request.method === "GET") {
      const appid = (env.BAIDU_APP_ID || "").trim();
      const key = (env.BAIDU_SECRET_KEY || "").trim();
      return new Response(JSON.stringify({
        appid_set: !!appid,
        appid_length: appid.length,
        appid_first3: appid.slice(0, 3),
        key_set: !!key,
        key_length: key.length,
        key_first3: key.slice(0, 3),
        test_md5: md5("hello"),
        expected_md5: "5d41402abc4b2a76b9719d911017c592",
      }), { headers: { "Content-Type": "application/json" } });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    try {
      const { text, from, to } = await request.json();

      const appid = (env.BAIDU_APP_ID || "").trim();
      const key = (env.BAIDU_SECRET_KEY || "").trim();
      const salt = String(Math.floor(Math.random() * 1e10));
      const signStr = appid + text + salt + key;
      const sign = md5(signStr);

      const res = await fetch("https://fanyi-api.baidu.com/api/trans/vip/translate", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          q: text,
          from: from || "auto",
          to: to,
          appid: appid,
          salt: salt,
          sign: sign,
        }).toString(),
      });

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

// ── MD5 (RFC 1321) pure-JS implementation ──

function md5(string) {
  const bytes = new TextEncoder().encode(string);

  // Convert to array of 32-bit words (little-endian)
  let len = bytes.length;
  // Pad: append 0x80, then zeros, then 64-bit length
  let paddedLen = ((len + 8) >>> 6 << 4) + 16;
  let words = new Uint32Array(paddedLen);
  for (let i = 0; i < len; i++) {
    words[i >>> 2] |= bytes[i] << ((i & 3) << 3);
  }
  words[len >>> 2] |= 0x80 << ((len & 3) << 3);
  words[paddedLen - 2] = (len * 8) & 0xFFFFFFFF;
  words[paddedLen - 1] = Math.floor(len * 8 / 0x100000000);

  // Constants
  const S = [
    7,12,17,22, 7,12,17,22, 7,12,17,22, 7,12,17,22,
    5, 9,14,20, 5, 9,14,20, 5, 9,14,20, 5, 9,14,20,
    4,11,16,23, 4,11,16,23, 4,11,16,23, 4,11,16,23,
    6,10,15,21, 6,10,15,21, 6,10,15,21, 6,10,15,21
  ];
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) {
    K[i] = Math.floor(0x100000000 * Math.abs(Math.sin(i + 1)));
  }

  let a0 = 0x67452301;
  let b0 = 0xEFCDAB89;
  let c0 = 0x98BADCFE;
  let d0 = 0x10325476;

  for (let offset = 0; offset < paddedLen; offset += 16) {
    let A = a0, B = b0, C = c0, D = d0;

    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }

      let temp = D;
      D = C;
      C = B;
      let sum = (A + F + K[i] + words[offset + g]) | 0;
      B = (B + ((sum << S[i]) | (sum >>> (32 - S[i])))) | 0;
      A = temp;
    }

    a0 = (a0 + A) | 0;
    b0 = (b0 + B) | 0;
    c0 = (c0 + C) | 0;
    d0 = (d0 + D) | 0;
  }

  function toHex(n) {
    let s = "";
    for (let i = 0; i < 4; i++) {
      s += ((n >> (i * 8 + 4)) & 0xF).toString(16);
      s += ((n >> (i * 8)) & 0xF).toString(16);
    }
    return s;
  }

  return toHex(a0) + toHex(b0) + toHex(c0) + toHex(d0);
}
