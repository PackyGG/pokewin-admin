// Send the user-supplied subscribe message, check if live.pull.history
// arrives. Then try the analogous chat feed subscribe.

import https from "node:https";
import { Receiver, PerMessageDeflate, Sender } from "ws";

const HOST = "api.packy.gg";
const PATH = "/v1/ws";
const KEY = "************************";
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

const req = https.request({ host: HOST, port: 443, path: PATH, method: "GET", headers: HEADERS, timeout: 15000 });

req.on("upgrade", (res, socket, head) => {
  console.log("UPGRADE", res.statusCode);

  const extensions = {};
  const pmd = new PerMessageDeflate({}, false, 100 * 1024 * 1024);
  pmd.accept([{}]);
  extensions[PerMessageDeflate.extensionName] = pmd;

  const receiver = new Receiver({
    binaryType: "nodebuffer", extensions, isServer: false,
    maxPayload: 100 * 1024 * 1024, skipUTF8Validation: false,
  });
  const sender = new Sender(socket, extensions);

  receiver.on("message", (data) => {
    const text = Buffer.isBuffer(data) ? data.toString("utf8")
      : Array.isArray(data) ? Buffer.concat(data).toString("utf8")
      : String(data);
    let parsed;
    try { parsed = JSON.parse(text); } catch { return; }
    const t = parsed?.type;
    const p = parsed.payload ?? {};
    let summary = "";
    if (typeof p.count === "number") summary = `count=${p.count}`;
    else if (Array.isArray(p.pulls)) summary = `pulls=${p.pulls.length}`;
    else if (Array.isArray(p.messages)) summary = `messages=${p.messages.length}`;
    else if (p.message) summary = p.message;
    console.log(`${t}  ${summary}`);
  });

  if (head && head.length) receiver.write(head);
  socket.on("data", (c) => receiver.write(c));
  socket.on("close", () => process.exit(0));

  // Subscribe to the pull feed + chat feed (guess for chat).
  setTimeout(() => {
    const m1 = { type: "live.pull.feed.subscribe" };
    console.log("->", JSON.stringify(m1));
    sender.send(JSON.stringify(m1), { binary: false, mask: true, fin: true, compress: false });
  }, 500);

  setTimeout(() => {
    const m2 = { type: "chat.pull.feed.subscribe" };
    console.log("->", JSON.stringify(m2));
    sender.send(JSON.stringify(m2), { binary: false, mask: true, fin: true, compress: false });
  }, 1500);

  setTimeout(() => { socket.destroy(); }, 20000);
});

req.on("error", (e) => { console.error("ERR", e.message); process.exit(1); });
req.end();
