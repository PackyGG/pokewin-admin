import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = readFileSync(
  path.join(root, "src/lib/queries/insights-games/overview.ts"),
  "utf8",
);

test("battle payout includes inventory and ledger cash/voucher legs", () => {
  assert.match(source, /SUM\(ui\.value_at_obtained::numeric\)/);
  assert.equal(
    source.match(/\$\{GAMING_PAYOUT_TYPES_SQL\}/g)?.length,
    2,
    "the KPI and time series must both include canonical ledger payout types",
  );
  assert.match(source, /ledger_payout_src AS \(/);
  assert.match(source, /UNION ALL SELECT \* FROM ledger_payout_src/);
});

test("battle payout legs retain scope, creator-session, and window filters", () => {
  const kpiLedgerStart = source.indexOf("SELECT SUM(ABS(lt.amount::numeric))");
  const kpiLedgerEnd = source.indexOf(")::text AS battle_payout", kpiLedgerStart);
  const kpiLedger = source.slice(kpiLedgerStart, kpiLedgerEnd);
  const ledgerSeries = source.slice(source.indexOf("ledger_payout_src AS ("));

  for (const ledgerLeg of [kpiLedger, ledgerSeries]) {
    assert.match(ledgerLeg, /lt\.status = 'completed'/);
    assert.match(ledgerLeg, /lt\.user_id IN \$\{scope\}/);
    assert.match(
      ledgerLeg,
      /NOT EXISTS \(\s*SELECT 1 FROM session_windows sw[\s\S]*?sw\.uid = lt\.user_id/,
    );
    assert.match(ledgerLeg, /\$\{ltCutoff\}/);
  }
});

test("overview uses the canonical borrow-inclusive gaming filters", () => {
  assert.match(source, /AND \$\{WAGER_LEG_FILTER\}/);
  assert.match(source, /AND \$\{PAYOUT_LEG_FILTER\}/);
  assert.doesNotMatch(source, /BORROW_FILTER_CTES/);
  assert.doesNotMatch(source, /non_borrow_(?:pack|battle)_sessions/);
});
