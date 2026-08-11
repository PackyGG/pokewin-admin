import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

test("Fraud Overview exposes a read-only Fiat deposits page", () => {
  const sidebar = read(
    "src/app/(antifraud)/antifraud/_components/antifraud-sidebar.tsx",
  );
  const page = read(
    "src/app/(antifraud)/antifraud/deposits/page.tsx",
  );
  const hosts = read("src/lib/app-hosts.ts");

  assert.match(
    sidebar,
    /const OVERVIEW_NAV[\s\S]*?label: "Deposits", href: "\/antifraud\/deposits"[\s\S]*?const ANTIFRAUD_NAV_ALERT_KEYS/,
  );
  assert.match(page, /requireAntifraudPageAccess\(\)/);
  assert.match(page, /listFiatDeposits\(\{ page, limit: perPage \}\)/);
  assert.match(page, /listFiatAssessments\(\{ page, limit: perPage \}\)/);
  assert.match(page, /<DepositCard/);
  assert.match(page, /<DataTablePagination/);
  assert.doesNotMatch(page, /FiatDepositReviewQueue|FiatDepositReviewDecision/);
  assert.match(page, /lg:grid-cols-\[minmax\(14rem,1fr\)_auto_auto\]/);
  assert.match(page, /h-36 w-full rounded-xl/);
  assert.match(page, /providerPaymentStatus/);
  assert.match(page, /failureReason/);
  assert.match(page, /aria-label={`\$\{label\} matches`}/);
  assert.match(page, /aria-label={`\$\{label\} does not match`}/);
  assert.match(hosts, /"deposits"/);
});

test("Fiat deposit visibility includes paid and terminal failed Whop intents", () => {
  const query = read("src/lib/antifraud/fiat-deposits-overview.ts");

  assert.match(
    query,
    /i\.paid_at IS NOT NULL[\s\S]*i\.status IN \('failed', 'canceled'\)/,
  );
  assert.match(query, /provider_payment_status[\s\S]*failed\|declined\|denied/);
  assert.match(query, /FROM fiat_deposit_intents i/);
  assert.match(query, /assessments[\s\S]{0,20}are enrichment/i);
  assert.match(query, /payment_webhook_events/);
  assert.match(query, /audit_events/);
  assert.match(query, /deposits\.provider_payment_status/);
  assert.match(query, /deposits\.failure_reason/);
  assert.match(query, /COALESCE\(deposits\.paid_at, deposits\.updated_at\)/);
  assert.doesNotMatch(query, /i\.status IN \('created', 'checkout_ready'/);
  assert.doesNotMatch(query, /fiat_deposit_assessments/);
});
