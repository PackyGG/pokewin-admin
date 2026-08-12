import assert from "node:assert/strict";
import test from "node:test";

import {
  baseSignupSignals,
  disposableEmailDomain,
  severity,
  type SignupContext,
} from "../src/scoring.js";
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

const normalContext: SignupContext = {
  sameIp10m: 1,
  sameIp30m: 1,
  sameExactIp30d: 1,
  sameIpv6Subnet30m: 0,
  sameDeviceAllTime: 1,
  sameDevice30d: 1,
  sameDeviceDistinctIps30d: 1,
  sameAffiliate30m: 0,
  sameAffiliateIp30m: 0,
  sameCountry15m: 1,
  sameCountry2m: 1,
  sameCountryNetwork2m: 1,
  generatedSameCountry2m: 0,
};

function discordSnowflake(createdAt: Date): string {
  return (
    (BigInt(createdAt.getTime()) - 1_420_070_400_000n) << 22n
  ).toString();
}

test("a second account on one device is reviewed without critical containment", () => {
  const signals = baseSignupSignals(signup, {
    ...normalContext,
    sameDeviceAllTime: 2,
  });
  assert.equal(signals.find((signal) => signal.key === "shared_device")?.points, 50);
  assert.equal(severity(50), "high");
});

test("normal signup has no baseline risk", () => {
  const signals = baseSignupSignals(signup, normalContext);
  assert.equal(signals.length, 0);
  assert.equal(severity(0), "low");
});

test("Discord snowflake age adds bounded identity evidence", () => {
  const signupAt = new Date("2026-08-12T12:00:00.000Z");
  const cases = [
    { days: 2, points: 40 },
    { days: 14, points: 25 },
    { days: 60, points: 10 },
  ];
  for (const candidate of cases) {
    const createdAt = new Date(
      signupAt.getTime() - candidate.days * 86_400_000,
    );
    const signal = baseSignupSignals(
      {
        ...signup,
        created_at: signupAt,
        auth_provider: "discord",
        auth_account_id: discordSnowflake(createdAt),
      },
      normalContext,
    ).find((entry) => entry.key === "discord_account_age");
    assert.equal(signal?.points, candidate.points);
    assert.equal(signal?.payload?.ageDays, candidate.days);
  }
});

test("established or malformed Discord identities add no age score", () => {
  const signupAt = new Date("2026-08-12T12:00:00.000Z");
  for (const accountId of [
    discordSnowflake(new Date(signupAt.getTime() - 180 * 86_400_000)),
    "not-a-snowflake",
  ]) {
    const signals = baseSignupSignals(
      {
        ...signup,
        created_at: signupAt,
        auth_provider: "discord",
        auth_account_id: accountId,
      },
      normalContext,
    );
    assert.equal(signals.some((entry) => entry.key === "discord_account_age"), false);
  }
});

test("campaign correlation is one bounded non-containment signal", () => {
  const signals = baseSignupSignals(
    { ...signup, username: "botuser123456" },
    {
      ...normalContext,
      sameCountry2m: 3,
      sameCountryNetwork2m: 3,
      generatedSameCountry2m: 2,
    },
  );
  const campaign = signals.filter(
    (entry) => entry.key === "signup_campaign_burst",
  );
  assert.equal(campaign.length, 1);
  assert.equal(campaign[0]?.points, 35);
  assert.equal(campaign[0]?.payload?.containmentRequired, undefined);
});

test("three ordinary same-country signups do not imply a campaign", () => {
  const signals = baseSignupSignals(signup, {
    ...normalContext,
    sameCountry2m: 3,
  });
  assert.equal(
    signals.some((entry) => entry.key === "signup_campaign_burst"),
    false,
  );
});

test("the third exact IP or fingerprint account in 30 days is a hard policy", () => {
  const signals = baseSignupSignals(signup, {
    ...normalContext,
    sameExactIp30d: 3,
    sameDeviceAllTime: 3,
    sameDevice30d: 3,
    sameDeviceDistinctIps30d: 2,
  });
  for (const key of [
    "exact_ip_third_account_30d",
    "fingerprint_third_account_30d",
  ]) {
    const signal = signals.find((candidate) => candidate.key === key);
    assert.equal(signal?.points, 100);
    assert.equal(signal?.payload?.containmentRequired, true);
    assert.equal(signal?.payload?.windowDays, 30);
  }
});

test("one fingerprint across changing IPs is elevated without hard containment", () => {
  const signal = baseSignupSignals(signup, {
    ...normalContext,
    sameDeviceAllTime: 2,
    sameDevice30d: 2,
    sameDeviceDistinctIps30d: 4,
  }).find((candidate) => candidate.key === "fingerprint_changing_ip_30d");
  assert.equal(signal?.points, 50);
  assert.equal(signal?.payload?.containmentRequired, undefined);
});

test("custom signup and activity weights drive new scores", () => {
  const weights = defaultScoreWeights();
  weights.generated_username = 37;
  weights.fiat_deposit = 61;
  const signals = baseSignupSignals(
    { ...signup, username: "botuser123456" },
    normalContext,
    weights,
  );
  assert.equal(
    signals.find((signal) => signal.key === "generated_username")?.points,
    37,
  );
  assert.equal(activityScoreFor("fiat_deposit", weights), 61);
});

test("requested signup and provider defaults use the live point values", () => {
  const weights = defaultScoreWeights();
  assert.equal(weights.ip_velocity_10m, 60);
  assert.equal(weights.generated_username, 25);
  assert.equal(weights.country_cluster_ten_plus, 25);
  assert.equal(weights.country_cluster_twenty_five_plus, 50);
  assert.equal(weights.risky_location, 15);
  assert.equal(weights.proxycheck_risk_medium, 40);
  assert.equal(weights.proxycheck_risk_high, 80);
});

test("a signup without stored email is not scored", () => {
  const signals = baseSignupSignals(
    { ...signup, email: null },
    normalContext,
  );
  assert.equal(signals.some((signal) => signal.key === "missing_email"), false);
});

test("large signup bot clusters escalate beyond small shared groups", () => {
  const signals = baseSignupSignals(
    { ...signup, affiliate_code: "BOTCHAIN" },
    {
      ...normalContext,
      sameIp10m: 50,
      sameIp30m: 50,
      sameDeviceAllTime: 50,
      sameAffiliate30m: 50,
      sameAffiliateIp30m: 50,
      sameCountry15m: 50,
    },
  );
  assert.equal(
    signals.find((signal) => signal.key === "shared_device")?.points,
    200,
  );
  assert.equal(
    signals.find((signal) => signal.key === "ip_velocity_30m")?.points,
    200,
  );
  assert.equal(
    signals.find((signal) => signal.key === "affiliate_ip_chain")?.points,
    100,
  );
  assert.equal(
    signals.find((signal) => signal.key === "affiliate_cluster")?.points,
    25,
  );
  assert.equal(
    signals.find((signal) => signal.key === "country_cluster")?.points,
    50,
  );
});

test("disposable email domains are detected without flagging normal providers", () => {
  assert.equal(disposableEmailDomain("bot@mailinator.com"), "mailinator.com");
  assert.equal(disposableEmailDomain("player@gmail.com"), null);
  const signals = baseSignupSignals(
    { ...signup, email: "bot@mailinator.com" },
    normalContext,
  );
  assert.equal(
    signals.find((signal) => signal.key === "disposable_email")?.points,
    60,
  );
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

test("welcome reward rush does not match after a fiat deposit", () => {
  const now = Date.now();
  assert.equal(sequenceMatches([
    { event_type: "fiat_deposit", occurred_at: new Date(now) },
    { event_type: "welcome_reward_opened", occurred_at: new Date(now + 1_000) },
    { event_type: "ledger_upgrader_bet", occurred_at: new Date(now + 2_000) },
  ], ["welcome_reward_opened", "ledger_upgrader_bet"], 180, [
    "fiat_deposit",
    "crypto_deposit",
  ]), false);
});

test("live behavior uses bounded trust credits and strong crypto evidence", () => {
  assert.equal(activityScoreFor("fiat_deposit"), -5);
  assert.equal(activityScoreFor("crypto_deposit"), -20);
  assert.equal(activityScoreFor("paid_pack_opened"), -3);
  assert.equal(activityScoreFor("ledger_battle_bet"), -3);
  assert.equal(activityScoreFor("ledger_battle_sponsorship"), -3);
  assert.equal(activityScoreFor("ledger_upgrader_bet"), -3);
  assert.equal(activityScoreFor("session_hopping"), 50);
  assert.equal(activityScoreFor("dormant_device_switch"), 60);
  assert.equal(activityScoreFor("daily_reward_opened"), -10);
  assert.equal(activityScoreFor("ledger_deposit_bonus"), -10);
  assert.equal(activityScoreFor("ledger_rakeback_claim"), -10);
  assert.equal(activityScoreFor("ledger_rain_win"), 0);
  assert.equal(activityScoreFor("deposit_unclassified"), 0);
  assert.equal(activityScoreFor("reward_opened"), 0);
  assert.equal(activityScoreFor("bonus_received"), 0);
  assert.equal(activityScoreFor("rain_joined"), 0);
});

test("sequence matching retries from a later valid first event", () => {
  const now = Date.now();
  assert.equal(sequenceMatches([
    { event_type: "welcome_reward_opened", occurred_at: new Date(now) },
    { event_type: "ledger_battle_bet", occurred_at: new Date(now + 200_000) },
    { event_type: "welcome_reward_opened", occurred_at: new Date(now + 210_000) },
    { event_type: "ledger_battle_bet", occurred_at: new Date(now + 220_000) },
  ], ["welcome_reward_opened", "ledger_battle_bet"], 180), true);
});
