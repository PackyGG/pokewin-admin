import assert from "node:assert/strict";
import test from "node:test";

import {
  FIAT_WITHDRAWAL_HOLD_SIGNAL_KIND,
  isFiatWithdrawalHoldSignal,
  isNonActionableRewardEnrollmentSignal,
  isNonActionableRewardEnrollmentTrailEntry,
  reviewSignalLabel,
  withoutNonActionableRewardEnrollmentSignals,
} from "../../src/lib/antifraud/signal-display";
import {
  parseAntifraudEvent,
  shouldOpenReviewForSignal,
} from "../../src/lib/antifraud/ws";

test("fiat withdrawal holds are accepted as high-severity review signals", () => {
  const event = parseAntifraudEvent({
    type: "signal",
    id: "fiat-withdrawal-hold:user_123:123",
    kind: FIAT_WITHDRAWAL_HOLD_SIGNAL_KIND,
    severity: "high",
    userId: "user_123",
    summary: "Withdrawals were automatically locked.",
    payload: {
      thresholdUsd: 100,
      lockedWithdrawalsCrypto: ["all"],
      lockedWithdrawalsItems: true,
    },
    at: "2026-07-28T12:00:00.000Z",
  });

  assert.ok(event);
  assert.equal(shouldOpenReviewForSignal(event), true);
  assert.equal(
    reviewSignalLabel(event.kind),
    "Fiat-triggered withdrawal hold",
  );
  assert.equal(isFiatWithdrawalHoldSignal(event.kind), true);
});

test("unmapped review signals receive a readable label", () => {
  assert.equal(reviewSignalLabel("multi_account"), "Multi account");
  assert.equal(isFiatWithdrawalHoldSignal("multi_account"), false);
});

test("automatic reward enrollment never appears as Fraud activity", () => {
  const enrollmentKinds = [
    "welcome_reward_granted",
    "level_one_reward_granted",
    "daily_reward_granted",
    "other_reward_granted",
  ];

  for (const kind of enrollmentKinds) {
    assert.equal(isNonActionableRewardEnrollmentSignal(kind), true);
    assert.equal(
      shouldOpenReviewForSignal({
        kind,
        severity: "critical",
        riskScore: 100,
      }),
      false,
    );
  }
  assert.equal(isNonActionableRewardEnrollmentSignal("daily_reward_opened"), false);
  assert.deepEqual(
    withoutNonActionableRewardEnrollmentSignals([
      "daily_reward_granted",
      "daily_reward_opened",
      "fiat_deposit",
    ]),
    ["daily_reward_opened", "fiat_deposit"],
  );
  assert.equal(
    isNonActionableRewardEnrollmentTrailEntry(
      "Daily pack enrolled at signup (0 pts, case 100) — Level 100 granted",
    ),
    true,
  );
  assert.equal(
    isNonActionableRewardEnrollmentTrailEntry(
      "[critical] daily_reward_granted — Level 100 granted",
    ),
    true,
  );
  assert.equal(
    isNonActionableRewardEnrollmentTrailEntry(
      "Daily pack opened (+10 pts, case 60) — Level 10 opened",
    ),
    false,
  );
});
