import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { deriveKenoWindowMetrics } from "../../src/lib/keno/window-metrics";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

test("Keno dashboard metrics derive profit and realized edge from settlement", () => {
  assert.deepEqual(
    deriveKenoWindowMetrics({
      games: 100,
      players: 25,
      wager: 1_000,
      payout: 925,
    }),
    {
      games: 100,
      players: 25,
      wager: 1_000,
      payout: 925,
      profit: 75,
      edgePct: 7.5,
    },
  );
});

test("Keno dashboard metrics preserve a negative realized edge", () => {
  const result = deriveKenoWindowMetrics({
    games: 2,
    players: 1,
    wager: 100,
    payout: 150,
  });

  assert.equal(result.profit, -50);
  assert.equal(result.edgePct, -50);
});

test("Keno dashboard metrics report a zero edge when there is no wager", () => {
  const result = deriveKenoWindowMetrics({
    games: 0,
    players: 0,
    wager: 0,
    payout: 0,
  });

  assert.equal(result.profit, 0);
  assert.equal(result.edgePct, 0);
});

test("dashboard renders Keno as an independent lifetime KPI", () => {
  const section = readFileSync(
    `${repoRoot}/src/app/(admin)/dashboard/dashboard-kpi-section.tsx`,
    "utf8",
  );
  const page = readFileSync(
    `${repoRoot}/src/app/(admin)/dashboard/page.tsx`,
    "utf8",
  );
  const payload = readFileSync(
    `${repoRoot}/src/app/(admin)/dashboard/kpi-window-data.ts`,
    "utf8",
  );

  assert.match(section, /title="Keno"/);
  assert.match(section, /label="Realized edge"/);
  assert.match(section, /label="Wager"/);
  assert.match(section, /label="Payouts"/);
  assert.match(section, /xl:grid-cols-4/);
  assert.match(section, /StaticWindowLabel label="Lifetime"/);
  assert.doesNotMatch(section, /pick\("keno"/);
  assert.match(page, /getDashboardKenoLifetimeMetrics\(\)/);
  assert.doesNotMatch(payload, /dashboard-keno/);
});

test("dashboard Keno lifetime read stays exact, scoped, and cached", () => {
  const query = readFileSync(
    `${repoRoot}/src/lib/queries/dashboard-keno.ts`,
    "utf8",
  );

  assert.match(query, /getDashboardKenoLifetimeMetrics/);
  assert.match(query, /FROM keno_games kg\s+WHERE \$\{customerScope\}/);
  assert.doesNotMatch(query, /kg\.created_at/);
  assert.match(query, /excludeStaffCreatorsAndBlacklistedSqlFromIds/);
  assert.match(query, /revalidate: 300/);
  assert.match(query, /"dashboard-activity", "keno-dashboard"/);
});

test("dashboard hero omits the live-refresh space filler", () => {
  const page = readFileSync(
    `${repoRoot}/src/app/(admin)/dashboard/page.tsx`,
    "utf8",
  );

  assert.doesNotMatch(page, /LiveIndicator/);
  assert.doesNotMatch(page, /live-indicator/);
});
