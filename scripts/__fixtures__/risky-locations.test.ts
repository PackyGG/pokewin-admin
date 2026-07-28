import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

test("Risky Locations is a manager-only System page with bounded duration controls", () => {
  const sidebar = read(
    "src/app/(antifraud)/antifraud/_components/antifraud-sidebar.tsx",
  );
  const page = read(
    "src/app/(antifraud)/antifraud/risky-locations/page.tsx",
  );
  const actions = read(
    "src/app/(antifraud)/antifraud/risky-locations/actions.ts",
  );
  const hosts = read("src/lib/app-hosts.ts");

  assert.match(sidebar, /label: "Risky Locations"/);
  assert.match(sidebar, /href: "\/antifraud\/risky-locations"/);
  assert.match(
    hosts,
    /host:\s*`fraud\.\$\{ROOT_DOMAIN\}`[\s\S]*?segmentRoutes:\s*\[[\s\S]*?"risky-locations"/,
  );
  assert.match(page, /requireAntifraudManagerPage/);
  assert.match(page, /<Suspense/);
  assert.match(actions, /requireAntifraudManager/);
  assert.match(actions, /\.min\(1\)\.max\(60\)/);
});

test("risky countries start monitoring with their configured duration", () => {
  const monitor = read("services/antifraud-monitor/src/monitor.ts");
  const migration = read(
    "services/antifraud-monitor/migrations/018_risky_locations.sql",
  );

  assert.match(monitor, /riskyLocations\.forCountry/);
  assert.match(monitor, /locationPolicy \|\|/);
  assert.match(monitor, /locationPolicy\?\.monitorDurationSeconds/);
  assert.match(migration, /monitor_duration_seconds BETWEEN 60 AND 3600/);
});
