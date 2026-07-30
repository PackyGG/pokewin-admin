import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

test("Risk locations is editable by verified Fraud users with audited reasons", () => {
  const sidebar = read(
    "src/app/(antifraud)/antifraud/_components/antifraud-sidebar.tsx",
  );
  const page = read("src/app/(antifraud)/antifraud/risky-locations/page.tsx");
  const actions = read(
    "src/app/(antifraud)/antifraud/risky-locations/actions.ts",
  );
  const hosts = read("src/lib/app-hosts.ts");

  assert.match(sidebar, /label: "Risk locations"/);
  assert.match(sidebar, /href: "\/antifraud\/risky-locations"/);
  assert.match(
    hosts,
    /host:\s*`fraud\.\$\{ROOT_DOMAIN\}`[\s\S]*?segmentRoutes:\s*\[[\s\S]*?"risky-locations"/,
  );
  assert.match(page, /requireAntifraudPageAccess/);
  assert.match(page, /<Suspense/);
  assert.match(actions, /requireAntifraudAccess/);
  assert.match(actions, /\.min\(1\)\.max\(60\)/);
  assert.match(
    actions,
    /reason: z\.string\(\)\.trim\(\)\.min\(4\)\.max\(500\)/,
  );
  const client = read(
    "src/app/(antifraud)/antifraud/risky-locations/risky-locations-client.tsx",
  );
  assert.match(client, /risky-location-reason/);
  assert.match(client, /window\.confirm/);
});

test("risky countries extend only an eligible score-based monitor", () => {
  const monitor = read("services/antifraud-monitor/src/monitor.ts");
  const migration = read(
    "services/antifraud-monitor/migrations/018_risky_locations.sql",
  );

  assert.match(monitor, /riskyLocations\.forCountry/);
  assert.match(monitor, /assessment\.monitorDurationSeconds > 0/);
  assert.match(monitor, /Math\.max\(/);
  assert.match(monitor, /locationPolicy\?\.monitorDurationSeconds/);
  assert.match(migration, /monitor_duration_seconds BETWEEN 60 AND 3600/);
});
