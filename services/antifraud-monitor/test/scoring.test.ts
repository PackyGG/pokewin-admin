import assert from "node:assert/strict";
import test from "node:test";

import { baseSignupSignals, severity } from "../src/scoring.js";
import {
  ACTIVITY_SCORE_DEFINITIONS,
  activityScoreFor,
  defaultScoreWeights,
  PROVIDER_SCORE_DEFINITIONS,
  SEVERITY_BANDS,
  SIGNUP_SCORE_DEFINITIONS,
} from "../src/score-catalog.js";
import { sequenceMatches } from "../src/monitor.js";
import type { Signup } from "../src/types.js";

const signup: Signup = {
  id: "user-1",
  username: "normal-player",
  email: "player@example.com",
  image: null,
  signup_ip: "203.0.113.1",
  country: "Germany",
  country_code: "DE",
  continent_code: "EU",
  state: null,
  city: "Berlin",
  affiliate_code: null,
  referred_by: null,
  is_suspected_alt: false,
  created_at: new Date(),
  fingerprint_request_id: "request",
  visitor_id: "visitor",
  fingerprint_confidence: 0.99,
  fingerprint_ip: "203.0.113.1",
  user_agent: "test",
};

test("shared devices immediately start a monitor", () => {
  const signals = baseSignupSignals(signup, {
    sameIp10m: 1,
    sameIp30m: 1,
    sameIpv6Subnet30m: 0,
    sameDeviceAllTime: 2,
  });
  assert.equal(signals.find((signal) => signal.key === "shared_device")?.points, 70);
});

test("normal signup has no baseline risk", () => {
  const signals = baseSignupSignals(signup, {
    sameIp10m: 1,
    sameIp30m: 1,
    sameIpv6Subnet30m: 0,
    sameDeviceAllTime: 1,
  });
  assert.equal(signals.length, 0);
  assert.equal(severity(0), "low");
});

test("custom signup and activity weights drive new scores", () => {
  const weights = defaultScoreWeights();
  weights.missing_email = 37;
  weights.fiat_deposit = 61;
  const signals = baseSignupSignals({ ...signup, email: null }, {
    sameIp10m: 1,
    sameIp30m: 1,
    sameIpv6Subnet30m: 0,
    sameDeviceAllTime: 1,
  }, weights);
  assert.equal(signals.find((signal) => signal.key === "missing_email")?.points, 37);
  assert.equal(activityScoreFor("fiat_deposit", weights), 61);
});

test("the public score catalog has unique keys and contiguous severity bands", () => {
  const definitions = [
    ...SIGNUP_SCORE_DEFINITIONS,
    ...PROVIDER_SCORE_DEFINITIONS,
    ...ACTIVITY_SCORE_DEFINITIONS,
  ];
  assert.equal(new Set(definitions.map((definition) => definition.key)).size, definitions.length);
  assert.equal(
    new Set(
      definitions.flatMap((definition) =>
        definition.options.map((option) => option.key)
      ),
    ).size,
    definitions.flatMap((definition) => definition.options).length,
  );
  for (let index = 1; index < SEVERITY_BANDS.length; index += 1) {
    const previous = SEVERITY_BANDS[index - 1];
    const current = SEVERITY_BANDS[index];
    assert.ok(previous);
    assert.ok(current);
    assert.equal(previous.maximum, current.minimum - 1);
  }
});

test("activity scoring and the public catalog use the same values", () => {
  for (const definition of ACTIVITY_SCORE_DEFINITIONS) {
    assert.equal(definition.options.length, 1);
    assert.equal(
      activityScoreFor(definition.key),
      definition.options[0]?.points,
    );
  }
  assert.equal(activityScoreFor("unknown"), 0);
});

test("reward-before-deposit does not match after a fiat deposit", () => {
  const now = Date.now();
  assert.equal(sequenceMatches([
    { event_type: "fiat_deposit", occurred_at: new Date(now) },
    { event_type: "reward_opened", occurred_at: new Date(now + 1_000) },
  ], ["reward_opened"], 180, [
    "fiat_deposit",
    "crypto_deposit",
    "deposit_unclassified",
  ]), false);
});

test("fiat and crypto deposits have separate risk treatment", () => {
  assert.equal(activityScoreFor("fiat_deposit"), 20);
  assert.equal(activityScoreFor("crypto_deposit"), -20);
  assert.equal(activityScoreFor("deposit_unclassified"), 20);
  assert.equal(activityScoreFor("rain_joined"), 0);
});

test("sequence matching retries from a later valid first event", () => {
  const now = Date.now();
  assert.equal(sequenceMatches([
    { event_type: "reward_opened", occurred_at: new Date(now) },
    { event_type: "reward_opened", occurred_at: new Date(now + 200_000) },
    { event_type: "reward_opened", occurred_at: new Date(now + 210_000) },
  ], ["reward_opened", "reward_opened"], 180), true);
});
