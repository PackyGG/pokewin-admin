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
  assert.match(page, /listPaidFiatDeposits\(\{ page, limit: perPage \}\)/);
  assert.match(page, /listFiatAssessments\(\{ page, limit: perPage \}\)/);
  assert.match(page, /<DepositCard/);
  assert.match(page, /<DataTablePagination/);
  assert.doesNotMatch(page, /FiatDepositReviewQueue|FiatDepositReviewDecision/);
  assert.match(hosts, /"deposits"/);
});

test("Fiat deposit visibility is driven by paid MAIN intents, not assessments", () => {
  const query = read("src/lib/antifraud/fiat-deposits-overview.ts");

  assert.match(query, /i\.paid_at IS NOT NULL/);
  assert.match(query, /FROM fiat_deposit_intents i/);
  assert.match(query, /assessments are enrichment/);
  assert.match(query, /payment_webhook_events/);
  assert.match(query, /audit_events/);
  assert.doesNotMatch(query, /fiat_deposit_assessments/);
});
