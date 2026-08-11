import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { calculateFrameSitePnlUsd } from "../../src/lib/creator-pnl-settlement-math";

const read = (path: string) => readFileSync(path, "utf8");
const service = read("src/lib/creator-pnl-settlement.ts");
const affiliate = read("src/app/(creator-hub)/creator-hub/profitability/_queries/frame-affiliate-pnl-by-user.ts");
const cron = read("src/app/api/cron/creator-pnl-settlement/route.ts");

test("settlement applies the exact cost formula", () => {
  assert.equal(calculateFrameSitePnlUsd({
    affiliateContributionUsd: 1000,
    weightedCreatorGameplayPnlUsd: 50,
    leaderboardHouseCostUsd: 512.5,
    fillCashoutCostUsd: 0,
    tipCostUsd: 25,
    sponsorshipCostUsd: 10,
    rewardProgramCostUsd: 20,
  }), 482.5);
});

test("settlement reads immutable half-open and weighted legs", () => {
  assert.match(service, /getFrameAffiliatePnlByUserUncached/);
  assert.match(affiliate, /created_at < f\.end_ts/);
  assert.match(service, /created_at < \$4::timestamptz/);
  assert.match(service, /bet_amount \* real_bps \/ 10000/);
  assert.match(service, /payout \* real_bps \/ 10000/);
  assert.match(service, /COUNT\(\*\) FILTER \(WHERE real_bps > 0\)/);
  assert.match(service, /weightedWagerUsd.*weightedPayoutUsd/s);
  assert.match(service, /getWeightedCreatorGameplayForWindow/);
  assert.match(service, /getWeightedCreatorGameplayByDay/);
  assert.match(service, /AT TIME ZONE 'UTC'/);
  assert.match(service, /WEIGHTED_CREATOR_GAMEPLAY_CTES/);
  assert.match(service, /real_bps/);
  assert.match(service, /'rain_tip'/);
});

test("settlement fails closed and is idempotent from stored evidence", () => {
  assert.match(service, /waiting for in-frame reward claims/);
  assert.match(service, /waiting for the bundled leaderboard/);
  assert.match(service, /current\.settlement_breakdown/);
  assert.doesNotMatch(service, /computeSettledBreakdownPlaceholder/);
  assert.match(service, /settlement_breakdown: breakdown/);
  assert.match(service, /creator_fill_conversion/);
});

test("cron is authenticated, bounded, and version-idempotent", () => {
  assert.match(cron, /CRON_SECRET/);
  assert.match(cron, /constantTimeEqual/);
  assert.match(cron, /BATCH_LIMIT = 20/);
  assert.match(cron, /CONCURRENCY = 2/);
  assert.match(cron, /expectedVersion: deal\.version/);
});
