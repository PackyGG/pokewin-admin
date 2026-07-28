import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = process.cwd();

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("dashboard KPI and trend sections retain successful snapshots", () => {
  const kpiSource = read("src/app/(admin)/dashboard/kpi-window-data.ts");
  const trendSource = read("src/lib/queries/dashboard-trend-series.ts");

  assert.match(kpiSource, /cacheGetOrSetStale/);
  assert.match(kpiSource, /dashboard-kpi-v3/);
  assert.match(kpiSource, /24 \* 60 \* 60/);
  assert.match(kpiSource, /must never replace a complete last-known-good snapshot/);

  assert.match(trendSource, /cacheGetOrSetStale/);
  assert.match(trendSource, /dashboard-trends-v2/);
  assert.match(trendSource, /snapshot was incomplete/);
});

test("dashboard trends load only chart data with bounded query fan-out", () => {
  const pageSource = read("src/app/(admin)/dashboard/page.tsx");
  const trendSource = read("src/lib/queries/dashboard-trend-series.ts");

  assert.match(pageSource, /getScopedDashboardTrendSeries/);
  assert.doesNotMatch(pageSource, /getDashboardStats\(/);
  assert.doesNotMatch(pageSource, /label="Trends"/);
  assert.match(trendSource, /runWithConcurrency\(\[/);
  assert.match(trendSource, /\] as const, 2\)/);
});

test("cold failures stay isolated to individual dashboard tiles", () => {
  const pageSource = read("src/app/(admin)/dashboard/page.tsx");
  const kpiSource = read("src/app/(admin)/dashboard/kpi-window-data.ts");
  const kpiUiSource = read(
    "src/app/(admin)/dashboard/dashboard-kpi-section.tsx",
  );

  assert.match(pageSource, /emptyDashboardTrendSeries/);
  assert.match(pageSource, /TrendTileUnavailable/);
  assert.match(kpiSource, /wagerAvailable/);
  assert.match(kpiSource, /cashflowAvailable/);
  assert.match(kpiUiSource, /Live wager data is retrying automatically/);
  assert.match(kpiUiSource, /Live cash-flow data is retrying automatically/);
});
