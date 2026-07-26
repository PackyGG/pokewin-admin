import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routePath = "src/app/api/antifraud/monitor/stream/route.ts";
const servicePath = "services/antifraud-monitor/src/live.ts";

test("the monitor service owns connection capacity and the SSE bridge reconnects", async () => {
  const [route, service] = await Promise.all([
    readFile(routePath, "utf8"),
    readFile(servicePath, "utf8"),
  ]);

  assert.doesNotMatch(
    route,
    /MAX_CONCURRENT_PER_USER|openStreams|Too many live monitor tabs/,
  );
  assert.match(route, /scheduleReconnect\("Live stream interrupted, reconnecting"\)/);
  assert.match(service, /actorConnections >= 3/);
  assert.match(service, /client\.on\("error"/);
});
