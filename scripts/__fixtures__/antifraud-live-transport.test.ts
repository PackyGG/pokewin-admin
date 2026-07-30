import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const routePath = "src/app/api/antifraud/monitor/stream/route.ts";
const servicePath = "services/antifraud-monitor/src/live.ts";
const packyRoutePath = "src/app/api/packy-live/route.ts";
const packyClientPath = "src/lib/packy-ws.ts";
const overviewPath = "src/app/(antifraud)/antifraud/page.tsx";
const overviewPanelsPath =
  "src/app/(antifraud)/antifraud/_components/overview-panels.tsx";
const monitorRoutePath = "src/app/api/antifraud/monitor/route.ts";
const accessGatePath = "src/lib/require-antifraud-access.ts";
const monitorParserPath =
  "src/app/(antifraud)/antifraud/_components/monitor-stream.ts";
const retiredOverviewActivityPath =
  "src/app/(antifraud)/antifraud/_components/live-activity.tsx";
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

test("read-only antifraud streams do not use the Server Action origin gate", async () => {
  const [streamRoute, snapshotRoute, accessGate] = await Promise.all([
    readFile(routePath, "utf8"),
    readFile(monitorRoutePath, "utf8"),
    readFile(accessGatePath, "utf8"),
  ]);

  for (const route of [streamRoute, snapshotRoute]) {
    assert.match(route, /requireAntifraudReadAccess\(\)/);
    assert.doesNotMatch(route, /requireAntifraudAccess\(\)/);
    assert.match(route, /sec-fetch-site/);
  }
  assert.match(accessGate, /export async function requireAntifraudReadAccess/);
  assert.match(
    accessGate,
    /requireAntifraudReadAccess[\s\S]*?isAntifraudAllowed/,
  );
});

test("overview action feed stays compact beside the thirty-day charts", async () => {
  const [overview, panels] = await Promise.all([
    readFile(overviewPath, "utf8"),
    readFile(overviewPanelsPath, "utf8"),
  ]);

  assert.match(overview, /grid items-start gap-4/);
  assert.match(panels, /h-\[336px\] min-h-0/);
  assert.doesNotMatch(panels, /h-full min-h-\[390px\]/);
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

test("the Packy live bridge uses lossless SSE data-line framing", async () => {
  const [route, client] = await Promise.all([
    readFile(packyRoutePath, "utf8"),
    readFile(packyClientPath, "utf8"),
  ]);

  assert.match(route, /\.split\(\/\\r\\n\|\\r\|\\n\/\)/);
  assert.doesNotMatch(route, /payload\.replace\(\/\\n\/g/);
  assert.match(client, /JSON\.parse\(raw\)/);
  assert.doesNotMatch(client, /raw\.replace\(\/\\\\n\/g/);

  const payload = JSON.stringify(
    {
      type: "chat.pull.history",
      payload: { messages: [{ content: "first line\nsecond line" }] },
    },
    null,
    2,
  );
  const framed = payload
    .split(/\r\n|\r|\n/)
    .map((line) => `data: ${line}`)
    .join("\n");
  const eventSourceData = framed
    .split("\n")
    .map((line) => line.slice("data: ".length))
    .join("\n");

  assert.deepEqual(JSON.parse(eventSourceData), JSON.parse(payload));
});

test("player gaming activity is shown only in the live monitor", async () => {
  const [overview, monitor] = await Promise.all([
    readFile(overviewPath, "utf8"),
    readFile(monitorClientPaths[0], "utf8"),
  ]);

  assert.doesNotMatch(overview, /LiveActivity|live-activity/);
  assert.match(overview, /OverviewActionFeed/);
  assert.match(monitor, /subscribePackyWs<AdminActivityEvent>/);
  assert.match(monitor, /"admin\.activity"/);
  assert.match(monitor, /topics\.includes\("gaming"\)/);
  assert.match(monitor, /type: "player\.activity"/);
  assert.match(monitor, /Signups, pack openings, player actions and matched flows/);
  await assert.rejects(access(retiredOverviewActivityPath));
});

test("live events preserve the typed envelope and degrade snapshot legs independently", async () => {
  const [client, parser, route] = await Promise.all([
    readFile(monitorClientPaths[0], "utf8"),
    readFile(monitorParserPath, "utf8"),
    readFile(monitorRoutePath, "utf8"),
  ]);

  assert.match(client, /parseMonitorFrame\(raw\)/);
  assert.doesNotMatch(client, /JSON\.parse\(raw\)/);
  assert.match(parser, /frame\.schemaVersion !== 1/);
  assert.match(parser, /correlationId/);
  assert.match(parser, /id: frame\.id/);
  assert.match(route, /Promise\.allSettled/);
  assert.match(route, /recentSessions/);
  assert.match(route, /liveMetrics/);
  assert.match(client, /WebSocket status/);
  assert.match(client, /24h signups/);
  assert.match(client, /24h locked/);
  assert.match(client, /24h legitimate fiat/);
  assert.match(client, /24h fraudulent fiat/);
  assert.match(client, /Domains \/ IP catches/);
  assert.match(client, /Recent monitor sessions/);
  assert.match(client, /PanelErrorBoundary/);
});

test("monitor case snapshot and rendered limits stay aligned", async () => {
  const [route, client] = await Promise.all([
    readFile("src/app/api/antifraud/monitor/route.ts", "utf8"),
    readFile(monitorClientPaths[0], "utf8"),
  ]);
  assert.match(route, /\/v1\/cases\?limit=40/);
  assert.match(client, /const MAX_CASES = 40/);
  assert.match(client, /cases\.slice\(0, MAX_CASES\)/);
});
