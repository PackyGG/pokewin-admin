// Listens to the packy.gg WS for 30s and logs every event type it
// sees plus a sample of the payload. Goal: confirm whether live pulls
// arrive as `live.pull.history`, a different type, or both.

import https from "node:https";
import crypto from "node:crypto";
import { Receiver, PerMessageDeflate } from "ws";

const HOST = "api.packy.gg";
const PATH = "/v1/ws";
const KEY = "LMUTEH207xvS5FA2bTrXCw==";
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const EXPECTED_ACCEPT = crypto.createHash("sha1").update(KEY + GUID).digest("base64");

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

const req = https.request({
  host: HOST, port: 443, path: PATH, method: "GET",
  headers: HEADERS, timeout: 15000,
});

req.on("upgrade", (res, socket, head) => {
  console.log("UPGRADE", res.statusCode, "accept ok:", res.headers["sec-websocket-accept"] === EXPECTED_ACCEPT);

  const extensions = {};
  const pmd = new PerMessageDeflate({}, false, 100 * 1024 * 1024);
  pmd.accept([{}]);
  extensions[PerMessageDeflate.extensionName] = pmd;

  const receiver = new Receiver({
    binaryType: "nodebuffer",
    extensions,
    isServer: false,
    maxPayload: 100 * 1024 * 1024,
    skipUTF8Validation: false,
  });

  const counts = new Map();
  let lastByType = new Map();
  let totalMessages = 0;

  receiver.on("message", (data) => {
    totalMessages += 1;
    const text = Buffer.isBuffer(data)
      ? data.toString("utf8")
      : Array.isArray(data)
      ? Buffer.concat(data).toString("utf8")
      : String(data);
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      console.log("BAD JSON", text.slice(0, 80));
      return;
    }
    const t = parsed?.type ?? "(no-type)";
    counts.set(t, (counts.get(t) ?? 0) + 1);
    lastByType.set(t, parsed);
    // Print each event's type + a tiny summary so we see the cadence
    // live, not just at the end.
    const summary = summarize(parsed);
    console.log(`[${new Date().toISOString()}] ${t} ${summary}`);
  });

  if (head && head.length) receiver.write(head);
  socket.on("data", (c) => receiver.write(c));
  socket.on("close", () => {
    console.log("socket close");
    console.log("\nEVENT TYPE COUNTS:");
    for (const [t, c] of counts.entries()) {
      console.log(`  ${t}: ${c}`);
    }
    console.log(`\nTotal messages: ${totalMessages}`);
    process.exit(0);
  });

  setTimeout(() => {
    console.log("\n-- 120s done, closing --");
    socket.destroy();
  }, 120000);
});

req.on("error", (e) => {
  console.error("REQUEST ERROR", e.message);
  process.exit(1);
});

req.end();

function summarize(evt) {
  if (!evt || typeof evt !== "object") return "";
  const p = evt.payload;
  if (!p) return "";
  if (typeof p.count === "number") return `count=${p.count}`;
  if (Array.isArray(p.pulls)) return `pulls=${p.pulls.length}`;
  if (Array.isArray(p.messages)) return `messages=${p.messages.length}`;
  return Object.keys(p).join(",");
}
