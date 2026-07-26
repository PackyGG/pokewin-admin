import { test } from "node:test";
import assert from "node:assert/strict";

import {
  getKenoHitProbability,
  getKenoHouseEdge,
  getKenoMultiplier,
  getKenoPayoutRow,
  getKenoRtp,
  KENO_MAX_PICKS,
  KENO_MIN_PICKS,
  KENO_RISK_MODES,
} from "@/lib/keno/payouts";

const REFERENCE_RTP = 0.925;
const RTP_TOLERANCE = 0.004;

test("Keno exposes one complete backend payout row for every risk and pick count", () => {
  for (const risk of KENO_RISK_MODES) {
    for (let picks = KENO_MIN_PICKS; picks <= KENO_MAX_PICKS; picks += 1) {
      const row = getKenoPayoutRow(risk, picks);
      assert.equal(row.length, picks + 1, `${risk}/${picks}`);
      assert.ok(row.every((multiplier) => multiplier >= 0));
    }
  }
});

test("Keno payout anchors match the backend engine", () => {
  assert.equal(getKenoMultiplier("low", 1, 0), 0.6);
  assert.equal(getKenoMultiplier("low", 10, 7), 15);
  assert.equal(getKenoMultiplier("medium", 6, 5), 180);
  assert.equal(getKenoMultiplier("high", 4, 4), 260);
  assert.equal(getKenoMultiplier("high", 10, 10), 1_000);
});

test("Keno exact-hit probabilities sum to one for every pick count", () => {
  for (let picks = KENO_MIN_PICKS; picks <= KENO_MAX_PICKS; picks += 1) {
    const total = Array.from(
      { length: picks + 1 },
      (_, hits) => getKenoHitProbability(picks, hits),
    ).reduce((sum, probability) => sum + probability, 0);
    assert.ok(Math.abs(total - 1) < 1e-12, `${picks} picks totaled ${total}`);
  }
});

test("Keno configured RTP and house edge match the backend reference profile", () => {
  for (const risk of KENO_RISK_MODES) {
    for (let picks = KENO_MIN_PICKS; picks <= KENO_MAX_PICKS; picks += 1) {
      const rtp = getKenoRtp(risk, picks);
      const edge = getKenoHouseEdge(risk, picks);
      assert.ok(
        Math.abs(rtp - REFERENCE_RTP) < RTP_TOLERANCE,
        `${risk}/${picks} RTP was ${(rtp * 100).toFixed(6)}%`,
      );
      assert.ok(Math.abs(rtp + edge - 1) < 1e-12);
    }
  }
});
