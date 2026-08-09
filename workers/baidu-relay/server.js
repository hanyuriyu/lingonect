/**
 * Lingonect Baidu relay
 *
 * Baidu's translate API bans an IP (error 58003) when its risk system sees
 * several App IDs translating from that address on the same day. Cloudflare
 * Workers egress from a large shared pool of addresses that many other people
 * also proxy Baidu through, so the ban lands on us for someone else's traffic.
 * Nothing is wrong with the account, the credits or the App ID.
 *
 * This relay is the fixed egress IP that fixes it. It runs on a host with a
 * stable outbound address, accepts the already-signed request from
 * baidu-worker.js, and forwards it to Baidu. Because it refuses any request
 * carrying an App ID other than ours, exactly one App ID can ever leave this
 * IP — so it cannot earn a 58003 ban, and Baidu can whitelist it for good.
 *
 * Environment:
 *   RELAY_TOKEN   – shared secret; must match the worker's BAIDU_RELAY_TOKEN
 *   BAIDU_APP_ID  – our numeric App ID; requests for any other ID are refused
 *   PORT          – listen port (default 8080)
 *
 * No dependencies — Node 18+ (built-in fetch), `node server.js`.
 */
import http from "node:http";
import { timingSafeEqual } from "node:crypto";

const PORT = Number(process.env.PORT || 8080);
const RELAY_TOKEN = (process.env.RELAY_TOKEN || "").trim();
const BAIDU_APP_ID = (process.env.BAIDU_APP_ID || "").trim();

const BAIDU_API_URL = "https://fanyi-api.baidu.com/api/trans/vip/translate";
const MAX_BODY_BYTES = 64 * 1024;
const UPSTREAM_TIMEOUT_MS = 20000;

if (!RELAY_TOKEN || !BAIDU_APP_ID) {
  console.error("RELAY_TOKEN and BAIDU_APP_ID must both be set.");
  process.exit(1);
}

// Constant-time compare so the token can't be recovered a byte at a time.
function tokenMatches(given) {
  const a = Buffer.from(String(given || ""));
  const b = Buffer.from(RELAY_TOKEN);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Errors go back in Baidu's own shape, so the worker and the front end keep a
// single response contract whether the failure came from here or from Baidu.
function sendError(res, status, code, message) {
  const body = JSON.stringify({ error_code: code, error_msg: message });
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

// Rejects an over-long body without tearing the socket down: the connection has
// to stay up long enough for the 413 to be written, so the request is only
// paused here and destroyed by the caller once the reply is out.
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on("data", (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        done = true;
        req.pause();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (err) => {
      if (done) return;
      done = true;
      reject(err);
    });
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && (req.url === "/healthz" || req.url === "/")) {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok\n");
    return;
  }

  if (req.method !== "POST") {
    sendError(res, 405, "relay_method", "Method not allowed");
    return;
  }

  if (!tokenMatches(req.headers["x-relay-token"])) {
    sendError(res, 403, "relay_forbidden", "Bad relay token");
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    sendError(res, 413, "relay_body", err.message);
    res.on("finish", () => req.destroy());
    return;
  }

  // The whole point of this host is that only our App ID is ever seen coming
  // from its IP. Anything else would put the ban we are escaping right back.
  const form = new URLSearchParams(body);
  if (form.get("appid") !== BAIDU_APP_ID) {
    sendError(res, 403, "relay_appid", "App ID not allowed on this relay");
    return;
  }

  try {
    const upstream = await fetch(BAIDU_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    const text = await upstream.text();
    res.writeHead(upstream.status, {
      // Baidu always answers JSON; pass its own type through rather than
      // asserting one, so a proxy or gateway page in the way stays recognisable.
      "Content-Type": upstream.headers.get("content-type") || "application/json",
      "Content-Length": Buffer.byteLength(text),
    });
    res.end(text);
  } catch (err) {
    console.error("Upstream call failed:", err.message);
    sendError(res, 502, "relay_upstream", err.message);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("Baidu relay listening on " + PORT + " for App ID " + BAIDU_APP_ID);
});
