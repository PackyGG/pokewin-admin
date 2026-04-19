// Standalone smoke test for the packy.gg WS handshake.
// Mirrors what src/app/api/packy-live/route.ts does so we can verify
// the handshake + receive a real message before shipping the proxy.
//
// Run: node scripts/test-packy-ws.mjs

import https from "node:https";
import crypto from "node:crypto";

const HOST = "api.packy.gg";
const PATH = "/v1/ws";
const KEY = "LMUTEH207xvS5FA2bTrXCw==";
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const HEADERS = {
  Host: HOST,
  Upgrade: "websocket",
  Origin: "https://beta.packy.gg",
  "Cache-Control": "no-cache",
  "Accept-Language": "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7",
  Pragma: "no-cache",
  Connection: "Upgrade",
  "Sec-WebSocket-Key": KEY,
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
  "Sec-WebSocket-Version": "13",
  "Sec-WebSocket-Extensions": "permessage-deflate; client_max_window_bits",
};

const EXPECTED_ACCEPT = crypto
  .createHash("sha1")
  .update(KEY + GUID)
  .digest("base64");

console.log("Expected Accept:", EXPECTED_ACCEPT);

const req = https.request({
  host: HOST,
  port: 443,
  path: PATH,
  method: "GET",
  headers: HEADERS,
  timeout: 15000,
});

let resolved = false;
const timer = setTimeout(() => {
  if (!resolved) {
    console.error("TIMEOUT after 15s — no response or upgrade");
    process.exit(2);
  }
}, 15000);

req.on("response", (res) => {
  resolved = true;
  clearTimeout(timer);
  console.error("NO UPGRADE — got HTTP response:");
  console.error("  status:", res.statusCode);
  console.error("  headers:", res.headers);
  let body = "";
  res.on("data", (c) => (body += c));
  res.on("end", () => {
    console.error("  body:", body || "(empty)");
    process.exit(1);
  });
});

req.on("upgrade", (res, socket, head) => {
  resolved = true;
  clearTimeout(timer);
  console.log("UPGRADE OK");
  console.log("  status:", res.statusCode);
  console.log("  sec-websocket-accept:", res.headers["sec-websocket-accept"]);
  console.log("  accept matches:", res.headers["sec-websocket-accept"] === EXPECTED_ACCEPT);
  console.log("  sec-websocket-extensions:", res.headers["sec-websocket-extensions"] ?? "(none)");

  let bytes = 0;
  let frames = 0;
  socket.on("data", (chunk) => {
    bytes += chunk.length;
    frames += 1;
    // Print first few bytes of each frame as hex so we see the WS header
    const preview = chunk.slice(0, Math.min(16, chunk.length)).toString("hex");
    console.log(`  frame #${frames} bytes=${chunk.length} preview=${preview}`);
  });
  if (head && head.length > 0) {
    console.log("  initial head bytes:", head.length, "hex:", head.slice(0, 16).toString("hex"));
  }

  // Listen for 20s then bail
  setTimeout(() => {
    console.log(`DONE — received ${frames} frames / ${bytes} bytes`);
    socket.destroy();
    process.exit(0);
  }, 20000);

  socket.on("error", (err) => {
    console.error("SOCKET ERROR:", err.message);
    process.exit(1);
  });
  socket.on("close", () => {
    console.log("Socket closed");
  });
});

req.on("error", (err) => {
  resolved = true;
  clearTimeout(timer);
  console.error("REQUEST ERROR:", err.message);
  process.exit(1);
});

req.end();
