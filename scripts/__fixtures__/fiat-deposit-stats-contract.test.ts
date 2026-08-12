import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function source(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), "utf8");
}

test("dashboard and analytics deposit aggregates include fiat ledger rows", () => {
  for (const relativePath of [
    "src/lib/queries/dashboard.ts",
    "src/lib/queries/dashboard-trend-series.ts",
    "src/lib/queries/dashboard-cashflow-pg.ts",
    "src/lib/queries/pnl.ts",
  ]) {
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
  }
});

test("canonical financial aggregates subtract only finalized fiat refunds", () => {
  const files = [
    "src/lib/queries/dashboard.ts",
    "src/lib/queries/dashboard-trend-series.ts",
    "src/lib/queries/period-window-kpis.ts",
    "src/lib/queries/pnl.ts",
    "src/lib/queries/users-windowed-pnl.ts",
    "src/lib/queries/_realized-pnl.ts",
    "src/lib/queries/insights-analytics/overview.ts",
    "src/lib/queries/map.ts",
    "src/lib/queries/creators-pnl.ts",
    "src/app/(admin)/creators/_queries/all-creators-lifetime-pnl.ts",
    "src/lib/queries/users-export.ts",
    "src/lib/users-export/all-users-csv.ts",
    "src/lib/queries/users-wager-progress.ts",
    "src/lib/queries/users-list.ts",
    "src/lib/excluded-users/fetch.ts",
  ];
  for (const relativePath of files) {
    const query = source(relativePath);
    assert.match(
      query,
      /fiatRefundCreditUsdSql/,
      `${relativePath} must use the shared refund-credit contract`,
    );
    assert.match(
      query,
      /partially_refunded[\s\S]*refunded|refunded[\s\S]*partially_refunded/,
      `${relativePath} must recognize partial and full refunds`,
    );
  }

  const contract = source("src/lib/queries/fiat-refund-credits.ts");
  assert.doesNotMatch(contract, /status = 'completed'/);
  assert.doesNotMatch(contract, /status = 'pending'/);
});

test("windowed financial aggregates attribute refunds to the original deposit", () => {
  for (const relativePath of [
    "src/lib/queries/dashboard.ts",
    "src/lib/queries/dashboard-trend-series.ts",
    "src/lib/queries/dashboard-cashflow-pg.ts",
    "src/lib/queries/period-window-kpis.ts",
    "src/lib/queries/pnl.ts",
    "src/lib/queries/users-windowed-pnl.ts",
    "src/lib/queries/insights-analytics/overview.ts",
    "src/lib/queries/map.ts",
  ]) {
    assert.match(
      source(relativePath),
      /fiatRefundAttributionTimestampSql/,
      `${relativePath} must restate the original deposit window`,
    );
  }

  const operationalFiat = source("src/lib/queries/dashboard-fiat.ts");
  assert.match(operationalFiat, /i\.updated_at >= \$1/);
  assert.doesNotMatch(operationalFiat, /fiatRefundAttributionTimestampSql/);
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
  // tab-overview.tsx became overview-page.tsx in the 2026-08 one-page
  // redesign; the inclusive-aggregate wiring it guards moved with it.
  const analyticsOverview = source(
    "src/app/(admin)/analytics/overview-page.tsx",
  );
  const analyticsMap = source("src/app/(admin)/analytics/tab-map.tsx");
  const analyticsCosts = source(
    "src/app/(admin)/analytics/tab-cost-breakdown.tsx",
  );

  assert.match(dashboardWindow, /getDashboardCashflowFromPostgres\(window\)/);
  // The today tile must stay on the canonical windowed-delta path — either
  // form (parallel legs or the one-shot CTE variant the uncached tile uses),
  // since both build their SQL from `windowedPnlLegSql` and therefore carry
  // the refund-aware net-deposit contract.
  assert.match(dashboardToday, /calculateWindowedPnl(OneShot)?\(\{\s*since,?/);
  assert.match(analyticsOverview, /getAnalyticsData\(period\)/);
  assert.match(analyticsOverview, /getTopDepositors\(window\.key\)/);
  assert.match(analyticsMap, /getUsersByCountry\(period\)/);
  assert.match(analyticsCosts, /getRealizedPnlSnapshot\(\)/);
});

test("dashboard cash-flow copy describes fiat and crypto deposits", () => {
  const todayCard = source("src/app/(admin)/dashboard/today-pnl-stat-card.tsx");
  const charts = source("src/app/(admin)/dashboard/charts.tsx");

  assert.match(todayCard, /completed fiat \+ crypto deposits/);
  assert.match(charts, /completed fiat \+ crypto inflow/);
  assert.doesNotMatch(charts, /(?:actual|raw) crypto (?:inflow|cash flow)/);
});

test("dashboard cash-flow uses one consistent database statement", () => {
  const cashflow = source("src/lib/queries/dashboard-cashflow-pg.ts");
  const compute = cashflow.slice(
    cashflow.indexOf("async function computeCashflow"),
    cashflow.indexOf("const cachedCashflow"),
  );

  assert.equal(
    compute.match(/queryRows</g)?.length,
    1,
    "cash-flow must use one checkout instead of four independent statements",
  );
  assert.equal(
    compute.match(/FROM ledger_transactions/g)?.length,
    1,
    "deposits and manual withdrawals must share one bounded ledger scan",
  );
  assert.match(compute, /WITH ledger AS \(/);
  assert.match(compute, /FILTER \(WHERE lt\.type::text = 'deposit'\)/);
  assert.match(compute, /CROSS JOIN cards CROSS JOIN refunds/);
});

test("lifetime PnL starts from credited balances and reverses finalized refunds", () => {
  const realizedPnl = source("src/lib/queries/_realized-pnl.ts");

  assert.match(realizedPnl, /SUM\(total_deposited::numeric\)/);
  assert.match(realizedPnl, /fiat_deposit_intents/);
  assert.match(
    realizedPnl,
    /Number\(r\?\.deposited \?\? 0\) - Number\(r\?\.fiat_refunds \?\? 0\)/,
  );
});
