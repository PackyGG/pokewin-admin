import assert from "node:assert/strict";
import test from "node:test";

import { baseSignupSignals, severity } from "../src/scoring.js";
import { sequenceMatches } from "../src/monitor.js";
import type { Signup } from "../src/types.js";

const signup: Signup = {
  id: "user-1",
  username: "normal-player",
  email: "player@example.com",
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

test("reward-before-deposit does not match after a deposit", () => {
  const now = Date.now();
  assert.equal(sequenceMatches([
    { event_type: "deposit", occurred_at: new Date(now) },
    { event_type: "reward_opened", occurred_at: new Date(now + 1_000) },
  ], ["reward_opened"], 180, ["deposit"]), false);
});

test("sequence matching retries from a later valid first event", () => {
  const now = Date.now();
  assert.equal(sequenceMatches([
    { event_type: "reward_opened", occurred_at: new Date(now) },
    { event_type: "reward_opened", occurred_at: new Date(now + 200_000) },
    { event_type: "reward_opened", occurred_at: new Date(now + 210_000) },
  ], ["reward_opened", "reward_opened"], 180), true);
});
