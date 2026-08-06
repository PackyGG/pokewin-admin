import assert from "node:assert/strict";
import test from "node:test";

import { isExactRewardBoundary, rewardProgramsCanContinue } from "./continuity";

const base = {
  codes: ["PACKY", "RIPZ"],
  thresholdUsd: "1000.00",
  rewardUsd: "5.00",
  vipRewardUsd: null,
  lossbackPct: "5.00",
  minDepositUsd: "50.00",
  maxRewardPerUserUsd: "100.00",
};

test("identical reward economics and code set continue across a deal boundary", () => {
  assert.equal(rewardProgramsCanContinue(base, { ...base, codes: ["ripz", "packy", "PACKY"] }), true);
  assert.equal(isExactRewardBoundary("2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z"), true);
});

test("code or economic changes start a new reward accounting program", () => {
  assert.equal(rewardProgramsCanContinue(base, { ...base, codes: ["PACKY"] }), false);
  assert.equal(rewardProgramsCanContinue(base, { ...base, thresholdUsd: 500 }), false);
  assert.equal(rewardProgramsCanContinue(base, { ...base, maxRewardPerUserUsd: null }), false);
  assert.equal(isExactRewardBoundary("2026-09-01T00:00:00.000Z", "2026-09-02T00:00:00.000Z"), false);
});
