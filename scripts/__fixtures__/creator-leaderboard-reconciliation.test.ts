import assert from "node:assert/strict";
import test from "node:test";

import { matchingApprovedLeaderboards } from "../../src/lib/creator-leaderboard-reconciliation";

const row = {
  id: "board-1",
  creator_user_id: "creator-1",
  co_creator_user_ids: [],
  title: "Weekly race",
  affiliate_codes: ["HEADED"],
  creator_prize_usd: "0.00",
  site_bonus_usd: "100.00",
  total_prize_usd: "100.00",
  is_sponsored: true,
  start_date: "2026-08-12T00:00:00.000Z",
  end_date: "2026-08-19T00:00:00.000Z",
  created_at: "2026-08-12T00:00:00.000Z",
  approval_status: "approved" as const,
  approved_at: "2026-08-12T00:00:00.000Z",
  approved_by: "admin-1",
  rejection_reason: null,
  cancelled_at: null,
  cancelled_by: null,
  refunded_at: null,
  refund_amount_usd: null,
  creation_ledger_tx_id: null,
  refund_ledger_tx_id: null,
  paid_manually: false,
  payout_note: null,
  time_status: "active" as const,
  prize_tiers: [
    { position: 1, prize_amount_usd: "60.00" },
    { position: 2, prize_amount_usd: "40.00" },
  ],
};
const terms = {
  creatorUserId: "creator-1",
  approvedBy: "admin-1",
  title: "Weekly race",
  codes: ["HEADED"],
  siteBonusUsd: 100,
  startsAt: row.start_date,
  endsAt: row.end_date,
  prizeTiers: [
    { position: 1, prizeAmountUsd: 60 },
    { position: 2, prizeAmountUsd: 40 },
  ],
};

test("leaderboard recovery accepts only an exact immutable commercial match", () => {
  assert.deepEqual(matchingApprovedLeaderboards([row], terms).map((item) => item.id), ["board-1"]);
  assert.equal(matchingApprovedLeaderboards([{ ...row, site_bonus_usd: "101.00" }], terms).length, 0);
  assert.equal(matchingApprovedLeaderboards([{ ...row, cancelled_at: row.end_date }], terms).length, 0);
  assert.equal(matchingApprovedLeaderboards([{ ...row, approved_by: "other-admin" }], terms).length, 0);
  assert.equal(matchingApprovedLeaderboards([{ ...row, prize_tiers: [{ position: 1, prize_amount_usd: "100.00" }] }], terms).length, 0);
});
