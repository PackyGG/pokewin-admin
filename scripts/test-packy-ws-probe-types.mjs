// Open one connection, probe a list of candidate message `type` values
// and log the server's error response for each — the Zod errors will
// tell us which field shape is next required once we find an accepted
// type.

import https from "node:https";
import crypto from "node:crypto";
import { Receiver, PerMessageDeflate, Sender } from "ws";

const TYPES = [
  // Outgoing type names echoed back — maybe the server accepts a pull
  // to request the history explicitly.
  "live.pull.history",
  "active.users.count",
  "chat.pull.history",
  // Dot-namespaced subscribe/get variants
  "live.pull.list",
  "live.pull.get",
  "live.pull.fetch",
  "live.pull.request",
  "chat.pull.request",
  "live.pull.subscribe",
  "chat.pull.subscribe",
  "active.users.subscribe",
  "subscribe.live.pull",
  "subscribe.chat.pull",
  "get.live.pull",
  "fetch.live.pull",
  // Other common patterns
  "client.ready",
  "client.hello",
  "pull.list",
  "pull.get",
  "pull.history",
];

const HOST = "api.packy.gg";
const PATH = "/v1/ws";
const WS_KEY = "LMUTEH207xvS5FA2bTrXCw==";
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

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
  console.log("UPGRADE", res.statusCode);

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
  const sender = new Sender(socket, extensions);

  let probeIdx = -1;
  const responses = [];

  receiver.on("message", (data) => {
    const text = Buffer.isBuffer(data) ? data.toString("utf8")
      : Array.isArray(data) ? Buffer.concat(data).toString("utf8")
      : String(data);
    let parsed;
    try { parsed = JSON.parse(text); } catch { return; }
    const t = parsed?.type ?? "(no-type)";
    if (probeIdx >= 0 && t === "error") {
      responses.push({ probed: TYPES[probeIdx], err: parsed.payload });
      console.log(`  [${TYPES[probeIdx]}] ->`, JSON.stringify(parsed.payload));
    } else if (probeIdx >= 0 && t !== "active.users.count") {
      console.log(`  [${TYPES[probeIdx]}] -> ACCEPTED? type=${t}`);
      responses.push({ probed: TYPES[probeIdx], accepted: parsed });
    }
    if (probeIdx + 1 < TYPES.length) {
      // Wait a bit between probes so responses don't interleave.
      setTimeout(nextProbe, 400);
    } else {
      setTimeout(() => {
        console.log("\n-- done --");
        socket.destroy();
      }, 2000);
    }
  });

  if (head && head.length) receiver.write(head);
  socket.on("data", (c) => receiver.write(c));
  socket.on("close", () => process.exit(0));

  function nextProbe() {
    probeIdx += 1;
    if (probeIdx >= TYPES.length) return;
    const body = JSON.stringify({ type: TYPES[probeIdx] });
    console.log(`-- probing: ${body}`);
    sender.send(body, { binary: false, mask: true, fin: true, compress: false });
  }

  // Kick off first probe
  setTimeout(nextProbe, 800);
});

req.on("error", (e) => { console.error("REQ ERR", e.message); process.exit(1); });
req.end();
