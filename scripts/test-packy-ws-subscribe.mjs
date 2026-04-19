// Open the WS, send a candidate subscribe message, log every event
// received. Iterate through several plausible payload shapes to find
// the one that triggers live.pull.history + chat.pull.history.
//
// Usage:
//   node scripts/test-packy-ws-subscribe.mjs          # sends nothing
//   node scripts/test-packy-ws-subscribe.mjs SHAPE    # see SHAPES below

import https from "node:https";
import crypto from "node:crypto";
import { Receiver, PerMessageDeflate, Sender } from "ws";

const SHAPES = {
  none: null,
  subscribe_channel_pulls: { type: "subscribe", channel: "live.pull" },
  subscribe_channel_history: { type: "subscribe", channel: "live.pull.history" },
  subscribe_topic: { action: "subscribe", topic: "live.pull" },
  subscribe_channels_array: { type: "subscribe", channels: ["live.pull", "chat.pull", "active.users"] },
  subscribe_subscribe: { action: "subscribe", channels: ["live.pull.history", "chat.pull.history"] },
  ping: { type: "ping" },
  get_history: { type: "get", channel: "live.pull.history" },
  sub_pulls: "subscribe live.pull",
  hello: { type: "hello" },
};

const key = process.argv[2] ?? "none";
const payload = SHAPES[key];
console.log(`Probe shape: ${key}`);
if (payload !== undefined) console.log(`Will send:`, JSON.stringify(payload));

const HOST = "api.packy.gg";
const PATH = "/v1/ws";
const WS_KEY = "LMUTEH207xvS5FA2bTrXCw==";
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const EXPECTED_ACCEPT = crypto.createHash("sha1").update(WS_KEY + GUID).digest("base64");

const HEADERS = {
  Host: HOST,
  Upgrade: "websocket",
  Origin: "https://beta.packy.gg",
  "Cache-Control": "no-cache",
  "Accept-Language": "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7",
  Pragma: "no-cache",
  Connection: "Upgrade",
  "Sec-WebSocket-Key": WS_KEY,
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

  // Sender writes masked client-to-server text frames. Required
  // because WS spec mandates client frames be masked.
  const sender = new Sender(socket, extensions);

  const counts = new Map();
  receiver.on("message", (data) => {
    const text = Buffer.isBuffer(data) ? data.toString("utf8")
      : Array.isArray(data) ? Buffer.concat(data).toString("utf8")
      : String(data);
    let parsed;
    try { parsed = JSON.parse(text); } catch { console.log("BAD JSON", text.slice(0, 80)); return; }
    const t = parsed?.type ?? "(no-type)";
    counts.set(t, (counts.get(t) ?? 0) + 1);
    const p = parsed.payload;
    let summary = "";
    if (p && typeof p === "object") {
      if (typeof p.count === "number") summary = `count=${p.count}`;
      else if (Array.isArray(p.pulls)) summary = `pulls=${p.pulls.length}`;
      else if (Array.isArray(p.messages)) summary = `messages=${p.messages.length}`;
      else summary = Object.keys(p).join(",");
    }
    console.log(`[${new Date().toISOString()}] ${t} ${summary}`);
    if (t === "error" || !p || Object.keys(p).length < 3) {
      // Full dump for error / weird / small payloads so we can learn
      // the server's expected schema.
      console.log("   full:", JSON.stringify(parsed));
    }
  });

  if (head && head.length) receiver.write(head);
  socket.on("data", (c) => receiver.write(c));
  socket.on("close", () => {
    console.log("socket close");
    console.log("\nEVENT TYPES:");
    for (const [t, c] of counts.entries()) console.log(`  ${t}: ${c}`);
    process.exit(0);
  });

  // Send subscribe probe 500ms after upgrade so the server has a
  // moment to finish any welcome dance.
  if (payload !== null && payload !== undefined) {
    setTimeout(() => {
      const body = typeof payload === "string" ? payload : JSON.stringify(payload);
      console.log(`-- sending: ${body}`);
      sender.send(body, {
        binary: false,
        mask: true,
        fin: true,
        compress: false,
      });
    }, 500);
  }

  setTimeout(() => {
    console.log("\n-- 30s done, closing --");
    socket.destroy();
  }, 30000);
});

req.on("error", (e) => {
  console.error("REQUEST ERROR", e.message);
  process.exit(1);
});
req.end();
