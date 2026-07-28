import assert from "node:assert/strict";
import test from "node:test";

import {
  FIAT_WITHDRAWAL_HOLD_SIGNAL_KIND,
  isFiatWithdrawalHoldSignal,
  reviewSignalLabel,
} from "../../src/lib/antifraud/signal-display";
import {
  parseAntifraudEvent,
  shouldEscalateSignal,
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
  assert.equal(shouldEscalateSignal(event), true);
  assert.equal(
    reviewSignalLabel(event.kind),
    "Fiat-triggered withdrawal hold",
  );
  assert.equal(isFiatWithdrawalHoldSignal(event.kind), true);
});

test("unmapped review signals keep their backend key", () => {
  assert.equal(reviewSignalLabel("multi_account"), "multi_account");
  assert.equal(isFiatWithdrawalHoldSignal("multi_account"), false);
});
