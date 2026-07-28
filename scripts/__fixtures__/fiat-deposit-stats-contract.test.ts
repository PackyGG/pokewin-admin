import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function source(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), "utf8");
}

const depositAggregateFiles = [
  "src/lib/queries/dashboard.ts",
  "src/lib/queries/dashboard-trend-series.ts",
  "src/lib/queries/dashboard-cashflow-pg.ts",
  "src/lib/queries/analytics.ts",
  "src/lib/queries/analytics-top.ts",
  "src/lib/queries/map.ts",
  "src/lib/queries/pnl.ts",
];

test("dashboard and analytics deposit aggregates include fiat ledger rows", () => {
  for (const relativePath of depositAggregateFiles) {
    const query = source(relativePath);

    assert.match(
      query,
      /type(?:::text)?\s*=\s*'deposit'/,
      `${relativePath} must aggregate completed deposit ledger rows`,
    );
    assert.doesNotMatch(
      query,
      /crypto_asset\s+IS\s+NOT\s+NULL/i,
      `${relativePath} must not restrict deposit totals to crypto deposits`,
    );
    assert.doesNotMatch(
      query,
      /fiat_deposit_intents/,
      `${relativePath} must not count paid-but-uncredited fiat intents`,
    );
  }
});

test("completed fiat intents are linked to the ledger source used by stats", () => {
  const schema = source("src/lib/db-schema/main/schema.ts");
  const fiatIntent = schema.slice(
    schema.indexOf("export const fiat_deposit_intents = pgTable"),
    schema.indexOf("export const payment_webhook_events = pgTable"),
  );

  assert.match(fiatIntent, /completed_ledger_id: uuid\(\)/);
  assert.match(fiatIntent, /foreignColumns: \[ledger_transactions\.id\]/);
  assert.match(
    fiatIntent,
    /name: "fiat_deposit_intents_completed_ledger_id_fkey"/,
  );
});

test("dashboard and analytics surfaces stay wired to inclusive aggregates", () => {
  const dashboardWindow = source(
    "src/app/(admin)/dashboard/kpi-window-data.ts",
  );
  const dashboardToday = source("src/lib/queries/dashboard-today-pnl.ts");
  const analyticsOverview = source(
    "src/app/(admin)/analytics/tab-overview.tsx",
  );
  const analyticsMap = source("src/app/(admin)/analytics/tab-map.tsx");
  const analyticsCosts = source(
    "src/app/(admin)/analytics/tab-cost-breakdown.tsx",
  );

  assert.match(
    dashboardWindow,
    /getDashboardCashflowFromPostgres\(window\)/,
  );
  assert.match(
    dashboardToday,
    /calculateWindowedPnl\(\{\s*since: new Date\(sinceIso\)/,
  );
  assert.match(analyticsOverview, /getAnalyticsData\(period\)/);
  assert.match(analyticsOverview, /getTopDepositors\(window\.key\)/);
  assert.match(analyticsMap, /getUsersByCountry\(period\)/);
  assert.match(analyticsCosts, /getRealizedPnlSnapshot\(\)/);
});

test("dashboard cash-flow copy describes fiat and crypto deposits", () => {
  const todayCard = source(
    "src/app/(admin)/dashboard/today-pnl-stat-card.tsx",
  );
  const charts = source("src/app/(admin)/dashboard/charts.tsx");

  assert.match(todayCard, /completed fiat \+ crypto deposits/);
  assert.match(charts, /completed fiat \+ crypto inflow/);
  assert.doesNotMatch(charts, /(?:actual|raw) crypto (?:inflow|cash flow)/);
});

test("lifetime PnL reads credited deposit balances, not payment attempts", () => {
  const realizedPnl = source("src/lib/queries/_realized-pnl.ts");

  assert.match(realizedPnl, /SUM\(total_deposited::numeric\)/);
  assert.doesNotMatch(realizedPnl, /fiat_deposit_intents/);
});
