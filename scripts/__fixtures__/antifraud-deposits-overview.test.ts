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
  assert.match(page, /listFiatAssessments\(\{ page, limit: perPage \}\)/);
  assert.match(page, /<DepositCard/);
  assert.match(page, /<DataTablePagination/);
  assert.doesNotMatch(page, /FiatDepositReviewQueue|FiatDepositReviewDecision/);
  assert.match(hosts, /"deposits"/);
});
