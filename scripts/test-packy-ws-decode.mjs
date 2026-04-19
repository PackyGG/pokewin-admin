// End-to-end smoke: handshake + decompress + parse frames. Mirrors
// exactly what src/app/api/packy-live/route.ts does after 'upgrade'.
// Expects to see decoded JSON text frames in the output.

import https from "node:https";
import crypto from "node:crypto";
// Named imports — in ESM, `import WsDefault from "ws"` returns ONLY
// the WebSocket class and has no Receiver/PerMessageDeflate attrs on
// it. Those are top-level ESM exports we need directly.
import { Receiver, PerMessageDeflate } from "ws";

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

req.on("response", (res) => {
  console.error("NO UPGRADE — got HTTP", res.statusCode);
  process.exit(1);
});

req.on("upgrade", (res, socket, head) => {
  console.log("UPGRADE OK — status:", res.statusCode);
  console.log("  accept ok:", res.headers["sec-websocket-accept"] === EXPECTED_ACCEPT);
  const extHeader = res.headers["sec-websocket-extensions"];
  console.log("  extensions:", extHeader ?? "(none)");

  const extensions = {};
  if (extHeader && String(extHeader).includes("permessage-deflate")) {
    const pmd = new PerMessageDeflate({}, false, 100 * 1024 * 1024);
    pmd.accept([{}]);
    extensions[PerMessageDeflate.extensionName] = pmd;
    console.log("  PerMessageDeflate wired; extensionName =", PerMessageDeflate.extensionName);
  }

  const receiver = new Receiver({
    binaryType: "nodebuffer",
    extensions,
    isServer: false,
    maxPayload: 100 * 1024 * 1024,
    skipUTF8Validation: false,
  });

  let messageCount = 0;
  receiver.on("message", (data, isBinary) => {
    messageCount += 1;
    const text = typeof data === "string"
      ? data
      : Buffer.isBuffer(data)
      ? data.toString("utf8")
      : Array.isArray(data)
      ? Buffer.concat(data).toString("utf8")
      : Buffer.from(new Uint8Array(data)).toString("utf8");
    const preview = text.length > 200 ? text.slice(0, 200) + "…" : text;
    console.log(`MSG #${messageCount} isBinary=${isBinary} len=${text.length} text=${preview}`);
  });

  receiver.on("error", (err) => {
    console.error("RECEIVER ERROR:", err.message);
  });

  receiver.on("conclude", (code, reason) => {
    console.log("CONCLUDE code=", code, "reason=", reason?.toString("utf8"));
  });

  if (head && head.length > 0) {
    receiver.write(head);
  }
  socket.on("data", (chunk) => {
    receiver.write(chunk);
  });
  socket.on("close", () => {
    console.log(`CLOSED — ${messageCount} messages decoded`);
    process.exit(messageCount > 0 ? 0 : 1);
  });
  socket.on("error", (err) => {
    console.error("SOCKET ERROR:", err.message);
  });

  // Listen for 20s then bail
  setTimeout(() => {
    console.log(`DONE — decoded ${messageCount} messages`);
    socket.destroy();
  }, 20000);
});

req.on("error", (err) => {
  console.error("REQUEST ERROR:", err.message);
  process.exit(1);
});

req.end();
