import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routePath = "src/app/api/antifraud/monitor/stream/route.ts";
const servicePath = "services/antifraud-monitor/src/live.ts";
const packyRoutePath = "src/app/api/packy-live/route.ts";

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

test("the Packy live bridge accepts the exact fraud host and pins the upstream origin", async () => {
  const route = await readFile(packyRoutePath, "utf8");

  assert.match(
    route,
    /PRODUCTION_FRAUD_ORIGIN\s*=\s*"https:\/\/fraud\.packydash\.com"/,
  );
  assert.match(
    route,
    /trustedOrigins\s*=\s*new Set\(\[\s*PRODUCTION_DASHBOARD_ORIGIN,\s*PRODUCTION_FRAUD_ORIGIN,/,
  );
  assert.match(route, /Origin:\s*PRODUCTION_DASHBOARD_ORIGIN/);
  assert.doesNotMatch(route, /Origin:\s*requestOrigin/);
});
