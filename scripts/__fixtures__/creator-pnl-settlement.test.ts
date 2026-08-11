import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { calculateFrameSitePnlUsd } from "../../src/lib/creator-pnl-settlement-math";

const read = (path: string) => readFileSync(path, "utf8");
const service = read("src/lib/creator-pnl-settlement.ts");
const affiliate = read("src/app/(creator-hub)/creator-hub/profitability/_queries/frame-affiliate-pnl-by-user.ts");
const action = read("src/app/(creator-hub)/creator-hub/creators/[id]/_components/pnl-settlement-actions.ts");
const balanceWriter = read("src/app/(admin)/users/[id]/actions.ts");
const button = read("src/app/(creator-hub)/creator-hub/creators/[id]/_components/pnl-settlement-button.tsx");

test("preview applies the exact house-cost formula", () => {
  assert.equal(calculateFrameSitePnlUsd({
    affiliateContributionUsd: 1000, weightedCreatorGameplayPnlUsd: 50,
    leaderboardHouseCostUsd: 512.5, fillCashoutCostUsd: 0,
    tipCostUsd: 25, sponsorshipCostUsd: 10, rewardProgramCostUsd: 20,
  }), 482.5);
});

test("preview uses uncached half-open reads and linked multiplier 1/X attribution", () => {
  assert.match(service, /getFrameAffiliatePnlByUserUncached/);
  assert.match(affiliate, /created_at < f\.end_ts/);
  assert.match(service, /created_at < \$3::timestamptz/);
  assert.match(service, /linked_multiplier_deal_id/);
  assert.match(service, /creator_multiplier_deals/);
  assert.match(service, /10_000 \/ n\(multiplier\.multiplier_bps\)/);
  assert.match(service, /Fill-funded creator play has 0% real-money attribution/);
  assert.match(service, /status: "ambiguous"/);
});

test("preview fails closed and freezes auditable evidence", () => {
  assert.match(service, /reward claims are still unresolved/);
  assert.match(service, /leaderboard has not ended/);
  assert.match(service, /does not exactly match the PnL frame/);
  assert.match(service, /leaderboard_gross_prize_usd/);
  assert.match(service, /leaderboard_refund_usd/);
  assert.match(service, /reward_program_id/);
  assert.match(service, /terms_snapshot/);
});

test("manual credit reserves Admin state and uses the canonical balance writer idempotently", () => {
  assert.match(action, /status='crediting'/);
  assert.match(action, /credit_status='crediting'/);
  assert.match(action, /adjustBalance\(\{/);
  assert.doesNotMatch(action, /INSERT INTO ledger_transactions/);
  assert.match(action, /const preview = deal\.settlement_breakdown/);
  assert.match(action, /creator_share_usd=\$5::numeric/);
  assert.match(action, /credited_amount_usd=\$2::numeric/);
  assert.match(action, /credit_status='credited'/);
  assert.match(balanceWriter, /creator-pnl:\$\{meta\.creatorPnlDealId\}/);
  assert.match(balanceWriter, /pg_advisory_xact_lock/);
  assert.match(balanceWriter, /external_tx_id/);
  assert.match(balanceWriter, /parsed\.category !== "creator_pnl_share"/);
  assert.match(balanceWriter, /immediately_withdrawable: true/);
});

test("manual UI requires explicit confirmation and 2FA; automatic cron is gone", () => {
  assert.match(button, /Type CREDIT to confirm/);
  assert.match(button, /StepUpField/);
  assert.match(button, /immediately increases the creator/);
  assert.equal(existsSync("src/app/api/cron/creator-pnl-settlement/route.ts"), false);
});
