import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const read = (relativePath: string) =>
  readFileSync(path.join(process.cwd(), relativePath), "utf8");

const pnl = read("src/lib/queries/pnl.ts");
const cashflow = read("src/lib/queries/dashboard-cashflow-pg.ts");
const userWindows = read("src/lib/queries/users-windowed-pnl.ts");
const manualWithdrawalAction = read(
  "src/app/(admin)/users/[id]/actions.ts",
);
const payload = read("src/app/(admin)/dashboard/kpi-window-data.ts");
const card = read("src/app/(admin)/dashboard/today-pnl-stat-card.tsx");
const holdings = read(
  "src/app/(admin)/dashboard/today-net-holdings-holders.tsx",
);

test("manual withdrawals are positive gross cash out in every daily P&L path", () => {
  for (const source of [pnl, cashflow, userWindows]) {
    assert.match(source, /withdrawal_amount_usd/);
    assert.match(source, /ABS\(lt\.amount::numeric\)/);
  }
  assert.match(pnl, /const withdrawalsGross = manualWd \+ cardWd/);
  assert.match(pnl, /deposits\s*-\s*withdrawalsGross\s*-/);
  assert.doesNotMatch(pnl, /const withdrawalsGross = Math\.abs\(manualWd\)/);
});

test("manual off-platform payouts remain auditable even with no balance debit", () => {
  assert.match(manualWithdrawalAction, /'withdrawal_amount_usd'/);
  assert.match(manualWithdrawalAction, /'phantom_portion_usd'/);
  assert.doesNotMatch(
    manualWithdrawalAction,
    /if \(balanceDeducted > 0\) \{[\s\S]{0,500}INSERT INTO ledger_transactions/,
  );
});

test("dashboard labels cash flow honestly and uses canonical GGR", () => {
  assert.doesNotMatch(payload, /getDepositFundedGgrForWindow/);
  assert.match(payload, /ggr: stats\?\.ggr \?\? 0/);
  assert.match(card, /Balance-sheet P&amp;L Today/);
  assert.match(card, /Net cash flow/);
  assert.match(card, /wagers − gaming payouts today/);
  assert.match(holdings, /\{sign\}[\s\S]{0,100}<AnimatedNumber/);
});
