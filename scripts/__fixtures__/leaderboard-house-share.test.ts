import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  computeDealCost,
  leaderboardHouseCost,
  normalizeLeaderboardHouseSharePct,
} from "../../src/lib/deal-economics.ts";

test("leaderboard cost honors the stored house-share percentage", () => {
  assert.equal(leaderboardHouseCost(2_000, 200, 25), 450);
  assert.equal(leaderboardHouseCost(2_000, 200, 75), 1_350);
  assert.equal(leaderboardHouseCost(2_000, 2_500, 75), 0);
});

test("house-share percentages clamp and missing annotations default to full funding", () => {
  assert.equal(normalizeLeaderboardHouseSharePct(undefined), 100);
  assert.equal(normalizeLeaderboardHouseSharePct(-5), 0);
  assert.equal(normalizeLeaderboardHouseSharePct(150), 100);
  assert.equal(normalizeLeaderboardHouseSharePct("37.5"), 37.5);
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
