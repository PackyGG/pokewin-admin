import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const query = fs.readFileSync(
  path.join(root, "src/lib/queries/dashboard-fiat.ts"),
  "utf8",
);
const page = fs.readFileSync(
  path.join(root, "src/app/(admin)/dashboard/page.tsx"),
  "utf8",
);
const payload = fs.readFileSync(
  path.join(root, "src/app/(admin)/dashboard/kpi-window-data.ts"),
  "utf8",
);
const cashflow = fs.readFileSync(
  path.join(root, "src/lib/queries/dashboard-cashflow-pg.ts"),
  "utf8",
);
const todayPnl = fs.readFileSync(
  path.join(root, "src/lib/queries/dashboard-today-pnl.ts"),
  "utf8",
);
const refundContract = fs.readFileSync(
  path.join(root, "src/lib/queries/fiat-refund-credits.ts"),
  "utf8",
);
const canonicalPnl = fs.readFileSync(
  path.join(root, "src/lib/queries/pnl.ts"),
  "utf8",
);

test("dashboard top row includes a fourth streamed Fiat payments card", () => {
  assert.match(page, /xl:grid-cols-4/);
  assert.match(page, /<DashboardFiatToday \/>/);
  assert.match(page, /getDashboardFiatMetrics\("today"\)/);
  assert.match(page, /<FiatTodayCard data=\{data\} \/>/);
});

test("fiat refund math handles full and proportional partial reversals", () => {
  assert.match(refundContract, /WHEN \$\{alias\}\.status = 'refunded'/);
  assert.match(refundContract, /WHEN \$\{alias\}\.status = 'partially_refunded'/);
  assert.match(refundContract, /refunded_credit_cents/);
  assert.match(refundContract, /refunded_amount_cents/);
  assert.match(refundContract, /refunded_amount/);
  assert.match(refundContract, /actual_customer_total_cents::numeric/);
  assert.match(query, /fiatRefundCreditCentsSql\(\)/);
  assert.match(query, /unresolved_partial_refund_count/);
});

test("refund credits reduce canonical deposit and P&L numbers exactly once", () => {
  assert.match(
    cashflow,
    /deposits: cashflow\.deposits - fiat\.refundCreditsUsd/,
  );
  assert.match(payload, /fiatRefunds: cashflow\?\.fiatRefunds/);
  assert.match(canonicalPnl, /fiatRefundCreditUsdSql/);
  assert.match(canonicalPnl, /toNumber\(ledger\[0\]\?\.deposits\) - toNumber\(refunds\[0\]\?\.refunds\)/);
  assert.match(todayPnl, /calculateWindowedPnl owns the shared refund-aware/);
  assert.doesNotMatch(todayPnl, /refundCreditsUsd/);
});
