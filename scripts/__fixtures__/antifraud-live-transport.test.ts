import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routePath = "src/app/api/antifraud/monitor/stream/route.ts";
const servicePath = "services/antifraud-monitor/src/live.ts";
const packyRoutePath = "src/app/api/packy-live/route.ts";
const packyClientPath = "src/lib/packy-ws.ts";
const monitorClientPaths = [
  "src/app/(antifraud)/antifraud/monitor/monitor-console.tsx",
  "src/app/(antifraud)/antifraud/_components/live-feed.tsx",
  "src/app/(antifraud)/antifraud/_components/overview-live-sync.tsx",
];

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
  assert.match(service, /MAX_CONNECTIONS_PER_ACTOR = 8/);
  assert.match(service, /actorConnections >= MAX_CONNECTIONS_PER_ACTOR/);
  assert.match(service, /client\.on\("error"/);
  assert.match(route, /code === 1013/);
  assert.match(route, /CAPACITY_RETRY_MIN_MS/);
});

test("temporary terminal monitor frames keep every client eligible to reconnect", async () => {
  const clients = await Promise.all(
    monitorClientPaths.map((path) => readFile(path, "utf8")),
  );

  for (const client of clients) {
    assert.doesNotMatch(client, /setStreamEnabled\(false\)/);
    assert.doesNotMatch(client, /\{\s*enabled:\s*streamEnabled,/);
  }

  assert.match(clients[0], /Retrying automatically\./);
  assert.match(clients[1], /Retrying automatically\./);
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
  assert.match(route, /\.\.\.backend\.bypassHeaders/);
  assert.doesNotMatch(route, /Origin:\s*requestOrigin/);
});

test("the Packy live bridge reports upstream truth and closes dead streams", async () => {
  const [route, client] = await Promise.all([
    readFile(packyRoutePath, "utf8"),
    readFile(packyClientPath, "utf8"),
  ]);

  assert.match(route, /writeEvent\("upstream-error"/);
  assert.doesNotMatch(route, /writeEvent\(\s*"error"/);
  assert.match(route, /writeEvent\("upstream-open"/);
  assert.match(route, /setTimeout\(cleanup,\s*0\)/);
  assert.match(route, /cancelStream\?\.\(\)/);

  assert.match(client, /\|\s*"unavailable"/);
  assert.match(client, /addEventListener\("upstream-open"/);
  assert.match(client, /addEventListener\("upstream-error"/);
  assert.doesNotMatch(
    client,
    /es\.onopen\s*=\s*\(\)\s*=>\s*\{[^}]*setConnectionState\("live"\)/s,
  );
});
