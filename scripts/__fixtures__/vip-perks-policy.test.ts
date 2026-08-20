import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateVipPerksPolicy,
  VIP_PERKS_WINDOW_MS,
} from "../../src/lib/vip-perks-policy";

const start = new Date("2026-08-01T00:00:00.000Z");
const at = (milliseconds: number) => new Date(start.getTime() + milliseconds);
const base = {
  enabled: true,
  initialThresholdUsd: 10_000,
  recurringEnabled: true,
  recurringThresholdUsd: 5_000,
  initialWindowStartedAt: start,
  initialUnlockedAt: null,
  initialWagerUsd: 0,
  previousCycleWagerUsd: 0,
  currentCycleWagerUsd: 0,
};

test("initial qualification is fixed to the original 30-day window", () => {
  assert.equal(evaluateVipPerksPolicy({ ...base, now: at(1) }).status, "pending");
  assert.equal(
    evaluateVipPerksPolicy({ ...base, now: at(1), initialWagerUsd: 10_000 }).active,
    true,
  );
  assert.equal(
    evaluateVipPerksPolicy({ ...base, now: at(VIP_PERKS_WINDOW_MS) }).status,
    "expired",
  );
});

test("disabled or invalid global config fails closed", () => {
  assert.equal(evaluateVipPerksPolicy({ ...base, now: at(1), enabled: false }).status, "inactive");
  assert.equal(evaluateVipPerksPolicy({ ...base, now: at(1), initialThresholdUsd: 0 }).active, false);
});

test("unlock grants the first recurring cycle and fixed cycles do not slide", () => {
  const unlocked = at(1_000);
  const first = evaluateVipPerksPolicy({
    ...base,
    now: new Date(unlocked.getTime() + VIP_PERKS_WINDOW_MS - 1),
    initialUnlockedAt: unlocked,
  });
  assert.equal(first.active, true);
  assert.equal(first.currentCycleStartsAt?.toISOString(), unlocked.toISOString());
  assert.equal(first.currentCycleEndsAt?.getTime(), unlocked.getTime() + VIP_PERKS_WINDOW_MS);
});

test("a missed recurring cycle disables, and current-cycle wager reactivates", () => {
  const unlocked = at(1_000);
  const now = new Date(unlocked.getTime() + VIP_PERKS_WINDOW_MS + 1);
  const missed = evaluateVipPerksPolicy({ ...base, now, initialUnlockedAt: unlocked });
  assert.equal(missed.status, "recurring_due");
  assert.equal(missed.active, false);

  const reactivated = evaluateVipPerksPolicy({
    ...base,
    now,
    initialUnlockedAt: unlocked,
    currentCycleWagerUsd: 5_000,
  });
  assert.equal(reactivated.status, "active");
  assert.equal(reactivated.active, true);
});

test("meeting the previous recurring cycle carries access into the current cycle", () => {
  const unlocked = at(1_000);
  const result = evaluateVipPerksPolicy({
    ...base,
    now: new Date(unlocked.getTime() + VIP_PERKS_WINDOW_MS + 1),
    initialUnlockedAt: unlocked,
    previousCycleWagerUsd: 5_000,
  });
  assert.equal(result.active, true);
});
