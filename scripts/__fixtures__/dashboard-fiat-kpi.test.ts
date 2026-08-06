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
const card = fs.readFileSync(
  path.join(root, "src/app/(admin)/dashboard/fiat-today-card.tsx"),
  "utf8",
);
const kpis = fs.readFileSync(
  path.join(root, "src/app/(admin)/dashboard/dashboard-kpi-section.tsx"),
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
  assert.match(query, /fiatRefundCreditCentsSql\("i"\)/);
  assert.match(query, /unresolved_partial_refund_count/);
});

test("Whop paid volume uses provider lifecycle, timestamp, USD, and payment dedupe", () => {
  assert.match(query, /event_type = 'payment\.succeeded'/);
  assert.match(query, /payload #>> '\{data,status\}' = 'paid'/);
  assert.match(query, /provider_paid_at >= \$1/);
  assert.match(query, /provider_paid_at <= CURRENT_TIMESTAMP/);
  assert.match(query, /DISTINCT ON \(payment_id\)/);
  assert.match(query, /payload #>> '\{data,usd_total\}'/);
  assert.match(query, /amount_after_fees/);
  assert.match(query, /gross_paid_usd \* amount_after_fees \/ charged_total/);
});

test("credited fiat remains an authoritative distinct completed ledger metric", () => {
  assert.match(query, /credited_ledgers AS/);
  assert.match(query, /SELECT DISTINCT ON \(lt\.id\)/);
  assert.match(query, /lt\.type = 'deposit'/);
  assert.match(query, /lt\.status = 'completed'/);
  assert.match(query, /lt\.created_at >= \$1/);
  assert.match(query, /u\.role NOT IN \('admin', 'support'\)/);
  assert.doesNotMatch(query, /getExcludedUserIds|BlacklistedSqlFromIds/);
  assert.doesNotMatch(query, /role NOT IN \('admin', 'support', 'creator'\)/);
});

test("paid-but-uncredited alert applies grace, lifecycle, staff, and alternate joins", () => {
  assert.match(query, /FIAT_SETTLEMENT_GRACE_MINUTES = 15/);
  assert.match(query, /provider_payment_id = paid\.payment_id/);
  assert.match(query, /provider_payment_id = paid\.provider_resource_id/);
  assert.match(query, /i\.id::text = paid\.metadata_intent_id/);
  assert.match(query, /lt\.id = paid\.completed_ledger_id/);
  assert.match(
    query,
    /'canceled', 'partially_refunded', 'refunded', 'disputed'/,
  );
  assert.match(query, /u\.role NOT IN \('admin', 'support'\)/);
  assert.match(card, /Read-only alert/);
  assert.match(card, /transactions\/card-payments/);
});

test("dashboard labels keep combined ledger credits separate from Whop paid", () => {
  assert.match(card, /Provider net paid/);
  assert.match(card, /Gross paid/);
  assert.match(card, /Balance credited/);
  assert.match(card, /paid_at since 00:00 UTC/);
  assert.match(kpis, /Balance credits \/ Withdrawals/);
  assert.match(kpis, /Completed credits/);
  assert.match(kpis, /Fiat \+ crypto ledger credits, not Whop provider volume/);
  assert.doesNotMatch(kpis, /Net deposits/);
});

test("refund credits restate their original deposit window exactly once", () => {
  assert.match(
    cashflow,
    /deposits: cashflow\.deposits - cashflow\.attributedRefunds/,
  );
  assert.match(cashflow, /fiatRefundAttributionTimestampSql/);
  assert.match(payload, /fiatRefunds: cashflow\?\.fiatRefunds/);
  assert.match(canonicalPnl, /fiatRefundCreditUsdSql/);
  assert.match(canonicalPnl, /fiatRefundAttributionTimestampSql/);
  // Net deposits are computed once, in `combineWindowedPnlLegs` — the single
  // combining step both windowed-P&L paths (parallel legs and one-shot CTE)
  // feed their raw leg sums into.
  assert.match(canonicalPnl, /toNumber\(row\?\.deposits\) - toNumber\(row\?\.refunds\)/);
  assert.match(
    refundContract,
    /COALESCE\(\$\{alias\}\.completed_at, \$\{alias\}\.paid_at, \$\{alias\}\.created_at\)/,
  );
  assert.match(todayPnl, /calculateWindowedPnl owns the shared refund-aware/);
  assert.doesNotMatch(todayPnl, /refundCreditsUsd/);
});
