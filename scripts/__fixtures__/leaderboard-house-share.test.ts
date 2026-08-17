import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  HOUSE_EDGE,
  computeCreatorDealConversion,
  computeDealCost,
  leaderboardHouseCost,
  normalizeLeaderboardHouseSharePct,
  weeklyDealsInFrame,
} from "../../src/lib/deal-economics.ts";
import type { CreatorDealResponse } from "../../src/lib/backend-api/contracts.ts";

test("leaderboard cost honors the stored house-share percentage", () => {
  assert.equal(leaderboardHouseCost(2_000, 200, 25), 450);
  assert.equal(leaderboardHouseCost(2_000, 200, 75), 1_350);
  assert.equal(leaderboardHouseCost(2_000, 2_500, 75), 0);
  assert.equal(leaderboardHouseCost(2_000), 2_000);
});

test("house-share percentages clamp and missing annotations default to full funding", () => {
  assert.equal(normalizeLeaderboardHouseSharePct(undefined), 100);
  assert.equal(normalizeLeaderboardHouseSharePct(-5), 0);
  assert.equal(normalizeLeaderboardHouseSharePct(150), 100);
  assert.equal(normalizeLeaderboardHouseSharePct("37.5"), 37.5);
});

test("approval-linked frames exclude overlapping periods from another contract", () => {
  const row = (id: string, requestId: string): CreatorDealResponse => ({
    id,
    user_id: "creator",
    status: "terminated",
    week_start_utc: "2026-08-06T00:00:00.000Z",
    week_end_utc: "2026-08-13T00:00:00.000Z",
    fills_allowed: 7,
    fills_used: 0,
    per_fill_amount_usd: "100",
    conversion_rate_bps: 5000,
    total_withdraw_cap_usd: "500",
    withdraw_cap_used_usd: "0",
    cooldown_minutes: 300,
    max_tip_per_stream_usd: "100",
    max_tip_per_user_usd: "20",
    max_sponsored_battle_usd: "50",
    max_sponsorship_per_stream_usd: "200",
    allow_site_leaderboards: false,
    allow_code_leaderboards: false,
    terms: { creator_approval_request_id: requestId },
    created_by: null,
    version: 1,
    created_at: "2026-08-06T00:00:00.000Z",
    updated_at: "2026-08-06T00:00:00.000Z",
  });
  const old = row("old", "old-request");
  const current = row("current", "current-request");
  assert.deepEqual(
    weeklyDealsInFrame(
      Date.parse("2026-08-12T00:00:00.000Z"),
      Date.parse("2026-08-26T00:00:00.000Z"),
      [old, current],
      "current-request",
    ).map((deal) => deal.id),
    ["current"],
  );
});

test("deal profitability uses the same stored leaderboard percentage", () => {
  const cost = computeDealCost({
    weeklyDeals: [],
    lbPrizeUsd: 1_000,
    lbRefundUsd: 0,
    lbHouseSharePct: 30,
  });
  assert.equal(cost.leaderboardUsd, 300);
  assert.equal(cost.dealCost, 300);
  assert.equal(cost.expectedWager, 4_000);
});

test("creator conversion uses unrounded canonical 7.5% economics", () => {
  assert.equal(HOUSE_EDGE, 0.075);
  assert.deepEqual(computeCreatorDealConversion(2_000, 100), {
    generatedValue: 150,
    expectedWager: 100 / 0.075,
    conversionRatio: 1.5,
  });
  assert.deepEqual(computeCreatorDealConversion(2_000, 0), {
    generatedValue: 150,
    expectedWager: 0,
    conversionRatio: null,
  });
});

test("all canonical leaderboard reporting surfaces pass stored percentages", () => {
  const root = new URL("../../src/", import.meta.url);
  const files: Array<[string, RegExp]> = [
    ["app/(admin)/creators/_queries/leaderboard-cost.ts", /sponsorship\.get\(lb\.id\)/],
    ["app/(admin)/creators/[userId]/_queries/leaderboard-cost-by-creator.ts", /sponsorship\.get\(lb\.id\)/],
    ["app/(creator-hub)/creator-hub/profitability/_queries/deal-profitability.ts", /lbHouseSharePct: fr\.board\?\.sponsoredPct/],
    ["app/(creator-hub)/creator-hub/profitability/_queries/past-deals.ts", /lbHouseSharePct: sponsorship\.get\(lb\.id\)/],
    ["app/(creator-hub)/creator-hub/_queries/four-week-summary.ts", /lbHouseSharePct: sponsorship\.get\(lb\.id\)/],
  ];
  for (const [file, expected] of files) {
    const source = readFileSync(new URL(file, root), "utf8");
    assert.match(source, expected, `${file} must pass stored terms`);
  }
});
