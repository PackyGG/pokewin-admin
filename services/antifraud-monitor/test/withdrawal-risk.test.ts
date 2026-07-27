import assert from "node:assert/strict";
import test from "node:test";

import { scoreWithdrawal } from "../src/withdrawal-risk.js";

const safeInput = {
  amountUsd: 100,
  assetValueUsd: 100,
  tracedAssetUsd: 100,
  assetCount: 2,
  depositsUsd: 100,
  gameWinsUsd: 140,
  gameLossesUsd: 120,
  rewardsUsd: 0,
  gameEvents: 12,
  minutesSinceLastDeposit: 1_440,
  accountAgeDays: 200,
  otherUsersAtDestination: 0,
};

test("a reconciled, traceable withdrawal is good", () => {
  const result = scoreWithdrawal(safeInput);
  assert.equal(result.riskScore, 0);
  assert.equal(result.verdict, "good");
  assert.ok(result.signals.some((signal) => signal.key === "amount_reconciled"));
  assert.ok(result.signals.some((signal) => signal.key === "source_traced"));
  assert.ok(result.flowChecks.every((check) => check.status === "pass"));
  assert.deepEqual(result.scoreBreakdown, {
    integrity: 0,
    funding: 0,
    behavior: 0,
    account: 0,
    network: 0,
  });
});

test("shared payout destinations make the withdrawal bad", () => {
  const result = scoreWithdrawal({
    ...safeInput,
    otherUsersAtDestination: 2,
  });
  assert.equal(result.riskScore, 70);
  assert.equal(result.verdict, "bad");
  assert.match(result.summary, /same payout destination/i);
  assert.equal(result.scoreBreakdown.network, 70);
  assert.equal(
    result.flowChecks.find((check) => check.key === "network")?.status,
    "block",
  );
});

test("rapid no-play cash-out is escalated", () => {
  const result = scoreWithdrawal({
    ...safeInput,
    amountUsd: 250,
    assetValueUsd: 250,
    tracedAssetUsd: 250,
    gameWinsUsd: 0,
    gameLossesUsd: 0,
    gameEvents: 0,
    minutesSinceLastDeposit: 15,
  });
  assert.equal(result.verdict, "bad");
  assert.ok(result.riskScore >= 60);
  assert.ok(result.signals.some((signal) => signal.key === "rapid_cashout"));
  assert.ok(result.signals.some((signal) => signal.key === "no_gameplay"));
  assert.ok(result.scoreBreakdown.behavior >= 40);
});

test("untraceable and mismatched assets surface both evidence gaps", () => {
  const result = scoreWithdrawal({
    ...safeInput,
    amountUsd: 100,
    assetValueUsd: 50,
    tracedAssetUsd: 0,
  });
  assert.equal(result.verdict, "bad");
  assert.ok(result.signals.some((signal) => signal.key === "amount_mismatch"));
  assert.ok(result.signals.some((signal) => signal.key === "source_gap"));
  assert.equal(
    result.flowChecks.find((check) => check.key === "integrity")?.status,
    "block",
  );
});
