import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function read(relative: string): string {
  return readFileSync(path.join(root, relative), "utf8");
}

test("daily gaming wager uses the canonical leg filter", () => {
  const source = read("src/lib/metrics/queries.ts");
  const daily = source.slice(source.indexOf("export async function getDailyGamingMetrics"));

  assert.match(
    daily,
    /type::text IN \$\{WAGER_TYPES_SQL\}\s+AND \$\{WAGER_LEG_FILTER\}/,
  );
});

test("analytics lifetime reads use the canonical bounded lookback", () => {
  const source = read("src/lib/queries/analytics.ts");

  assert.match(source, /GGR_LIFETIME_LOOKBACK_DAYS/);
  assert.doesNotMatch(source, /if \(period === "all"\) return \{ since: null \}/);
  assert.equal(
    (
      source.match(
        /INTERVAL '\$\{GGR_LIFETIME_LOOKBACK_DAYS\} days'/g,
      ) ?? []
    ).length,
    2,
  );
});

test("cached realized PnL is explicitly pinned to production", () => {
  const source = read("src/lib/queries/_realized-pnl.ts");

  assert.match(source, /queryRows<[\s\S]*?>\(getProdDrizzleDb\(\), `/);
  assert.doesNotMatch(source, /queryMainRows/);
});

test("cost-breakdown lifetime defaults to the bounded lookback", () => {
  const source = read("src/lib/queries/insights-analytics/cost-breakdown.ts");

  assert.match(
    source,
    /lifetimeLookbackDays = INSIGHTS_HUB_WAGER_LOOKBACK_DAYS/,
  );
  assert.match(source, /const window: MetricWindow = \{ since: cutoff \};/);
});

test("dashboard GGR contributors use the headline customer roles", () => {
  const source = read("src/lib/queries/dashboard.ts");
  const contributors = source.slice(
    source.indexOf("async function ggrTopContributorsForCutoff"),
  );

  assert.match(
    contributors,
    /WHERE u\.role NOT IN \('admin', 'support', 'creator'\)/,
  );
});
