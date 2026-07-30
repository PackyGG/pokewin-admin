import assert from "node:assert/strict";
import test from "node:test";

import {
  assessProfile,
  detectSessionHopping,
  networkClusterKeys,
  normalizeSignupSignals,
  traceRestrictedFunds,
} from "../src/profile-risk.js";

const now = new Date("2026-07-30T12:00:00.000Z");
const providers = ["fingerprint", "proxycheck", "abstract_ip", "abstract_email", "opportify"].map(
  (provider) => ({ provider, outcome: "success" as const, required: true }),
);

test("signup assessment is capped at 100 while preserving raw explainability", () => {
  const assessment = assessProfile({
    signals: normalizeSignupSignals(
      [
        { key: "shared_device", title: "Shared", detail: "Many accounts", points: 200 },
        { key: "ip_velocity_30m", title: "Velocity", detail: "Burst", points: 120 },
        { key: "generated_username", title: "Generated", detail: "Pattern", points: 100 },
      ],
      now,
    ),
    providers,
    assessedAt: now,
    isCreator: false,
    oauthSignup: false,
    hasFingerprint: true,
  });
  assert.equal(assessment.score, 100);
  assert.equal(assessment.rawScore, 420);
  assert.equal(assessment.explanation.categoryTotals.network, 80);
  assert.match(assessment.explanation.notes.join(" "), /capped at 100/i);
});

test("hard policies force 100 even when category scoring is lower", () => {
  const assessment = assessProfile({
    signals: normalizeSignupSignals(
      [{ key: "abstract_email_catchall", title: "Catch-all", detail: "Confirmed", points: 20 }],
      now,
    ),
    providers,
    assessedAt: now,
    isCreator: false,
    oauthSignup: false,
    hasFingerprint: true,
  });
  assert.equal(assessment.score, 100);
  assert.deepEqual(assessment.policyMatches, ["email.catchall"]);
  assert.equal(assessment.outcome, "review_required");
});

test("required provider failures are incomplete, never clean", () => {
  const assessment = assessProfile({
    signals: [],
    providers: [
      ...providers.slice(0, 4),
      {
        provider: "opportify",
        outcome: "failed",
        required: true,
        failureKind: "timeout",
      },
    ],
    assessedAt: now,
    isCreator: false,
    oauthSignup: false,
    hasFingerprint: true,
  });
  assert.equal(assessment.score, 0);
  assert.equal(assessment.outcome, "incomplete");
  assert.equal(assessment.completeness, "partial");
  assert.equal(assessment.confidence, 80);
});

test("partial provider responses are incomplete, never clean", () => {
  const assessment = assessProfile({
    signals: [],
    providers: providers.map((provider) =>
      provider.provider === "opportify"
        ? { ...provider, completeness: "partial" as const }
        : { ...provider, completeness: "complete" as const }
    ),
    assessedAt: now,
    isCreator: false,
    oauthSignup: false,
    hasFingerprint: true,
  });
  assert.equal(assessment.score, 0);
  assert.equal(assessment.outcome, "incomplete");
  assert.equal(assessment.completeness, "unknown");
  assert.equal(assessment.confidence, 80);
});

test("missing OAuth fingerprint remains unknown and adds limited risk", () => {
  const assessment = assessProfile({
    signals: [],
    providers,
    assessedAt: now,
    isCreator: false,
    oauthSignup: true,
    hasFingerprint: false,
  });
  const signal = assessment.signals.find(
    (candidate) => candidate.key === "oauth_fingerprint_unknown",
  );
  assert.equal(signal?.effectivePoints, 10);
  assert.equal(assessment.score, 10);
});

test("score 21 starts the standard monitoring outcome band", () => {
  const assessment = assessProfile({
    signals: normalizeSignupSignals(
      [{ key: "vpn", title: "VPN", detail: "Contextual", points: 21 }],
      now,
    ),
    providers,
    assessedAt: now,
    isCreator: false,
    oauthSignup: false,
    hasFingerprint: true,
  });
  assert.equal(assessment.score, 21);
  assert.equal(assessment.outcome, "monitor");
  assert.equal(assessment.monitorDurationSeconds, 450);
});

test("creator exception suppresses expected funding but not identity hard policy", () => {
  const assessment = assessProfile({
    signals: normalizeSignupSignals(
      [
        { key: "creator_sponsored_funding", title: "Sponsor", detail: "Expected", points: 80 },
        { key: "fingerprint_event_replayed", title: "Replay", detail: "Confirmed", points: 20 },
      ],
      now,
    ),
    providers,
    assessedAt: now,
    isCreator: true,
    oauthSignup: false,
    hasFingerprint: true,
  });
  assert.equal(
    assessment.signals.find((signal) => signal.key === "creator_sponsored_funding")
      ?.suppressedReason,
    "expected_creator_activity",
  );
  assert.equal(assessment.score, 100);
  assert.deepEqual(assessment.policyMatches, ["fingerprint.replayed"]);
});

test("network clustering normalizes IPv4 and IPv6 without accepting malformed text", () => {
  assert.deepEqual(networkClusterKeys("192.0.2.44"), {
    exact: "192.0.2.44",
    subnet: "192.0.2.0/24",
    evidenceSubnet: null,
    baselineSubnet: null,
    family: 4,
  });
  assert.deepEqual(networkClusterKeys("2001:db8::1"), {
    exact: "2001:0db8:0000:0000:0000:0000:0000:0001",
    subnet: "2001:0db8:0000:0000::/64",
    evidenceSubnet: "2001:0db8:0000:0000:0000::/56",
    baselineSubnet: "2001:0db8:0000::/48",
    family: 6,
  });
  assert.deepEqual(networkClusterKeys("unknown, 192.0.2.1"), {
    exact: null,
    subnet: null,
    evidenceSubnet: null,
    baselineSubnet: null,
    family: null,
  });
});

test("overlapping anonymous-network providers contribute only the strongest fact", () => {
  const assessment = assessProfile({
    signals: normalizeSignupSignals(
      [
        { key: "fingerprint_vpn", title: "VPN", detail: "FP", points: 20 },
        { key: "abstract_ip_proxy", title: "Proxy", detail: "Abstract", points: 35 },
        { key: "proxycheck_anonymous_high_risk", title: "Proxy", detail: "ProxyCheck", points: 55 },
      ],
      now,
    ),
    providers,
    assessedAt: now,
    isCreator: false,
    oauthSignup: false,
    hasFingerprint: true,
  });
  assert.equal(assessment.score, 55);
  assert.equal(
    assessment.signals.filter((signal) => signal.effectivePoints > 0).length,
    1,
  );
});

test("score bands produce the owner-approved monitor and notification policy", () => {
  const low = assessProfile({
    signals: normalizeSignupSignals(
      [{ key: "generated_username", title: "Name", detail: "Pattern", points: 20 }],
      now,
    ),
    providers,
    assessedAt: now,
    isCreator: false,
    oauthSignup: false,
    hasFingerprint: true,
  });
  assert.equal(low.monitorDurationSeconds, 0);
  assert.deepEqual(low.recommendedActions, []);

  const priority = assessProfile({
    signals: normalizeSignupSignals(
      [
        { key: "behavior_cluster", title: "Cluster", detail: "Confirmed", points: 40 },
        { key: "generated_username", title: "Name", detail: "Confirmed", points: 40 },
      ],
      now,
    ),
    providers,
    assessedAt: now,
    isCreator: false,
    oauthSignup: false,
    hasFingerprint: true,
  });
  assert.equal(priority.monitorDurationSeconds, 900);
  assert.ok(priority.recommendedActions.includes("lock_withdrawals"));
  assert.ok(!priority.recommendedActions.includes("ban"));
});

test("risky country alone stays below the no-monitor ceiling", () => {
  const assessment = assessProfile({
    signals: normalizeSignupSignals(
      [{
        key: "risky_location_monitor",
        title: "Risky signup location",
        detail: "CZ",
        points: 15,
      }],
      now,
    ),
    providers,
    assessedAt: now,
    isCreator: false,
    oauthSignup: false,
    hasFingerprint: true,
  });
  assert.equal(assessment.score, 15);
  assert.equal(assessment.monitorDurationSeconds, 0);
  assert.deepEqual(assessment.recommendedActions, []);
});

test("only deterministic approved email rules recommend an automatic ban", () => {
  const catchall = assessProfile({
    signals: normalizeSignupSignals(
      [{ key: "abstract_email_catchall", title: "Catch-all", detail: "Confirmed", points: 100 }],
      now,
    ),
    providers,
    assessedAt: now,
    isCreator: false,
    oauthSignup: false,
    hasFingerprint: true,
  });
  assert.ok(catchall.recommendedActions.includes("ban"));
  assert.ok(catchall.recommendedActions.includes("block_ip"));

  const blockedDomain = assessProfile({
    signals: normalizeSignupSignals(
      [{ key: "active_email_domain_blocklist", title: "Blocked", detail: "Active", points: 100 }],
      now,
    ),
    providers,
    assessedAt: now,
    isCreator: false,
    oauthSignup: false,
    hasFingerprint: true,
  });
  assert.ok(blockedDomain.recommendedActions.includes("ban"));
  assert.ok(!blockedDomain.recommendedActions.includes("block_ip"));
  assert.ok(!blockedDomain.recommendedActions.includes("block_fingerprint"));

  const tor = assessProfile({
    signals: normalizeSignupSignals(
      [{ key: "fingerprint_tor", title: "Tor", detail: "Confirmed", points: 65 }],
      now,
    ),
    providers,
    assessedAt: now,
    isCreator: false,
    oauthSignup: false,
    hasFingerprint: true,
  });
  assert.ok(tor.recommendedActions.includes("lock_withdrawals"));
  assert.ok(!tor.recommendedActions.includes("ban"));
});

test("session hopping requires a bounded multi-dimensional jump", () => {
  const signal = detectSessionHopping([
    { occurredAt: new Date("2026-07-30T11:50:00Z"), deviceId: "a", ip: "192.0.2.1", countryCode: "DE" },
    { occurredAt: new Date("2026-07-30T11:55:00Z"), deviceId: "b", ip: "192.0.2.2", countryCode: "DE" },
    { occurredAt: now, deviceId: "c", ip: "198.51.100.3", countryCode: "GB" },
  ]);
  assert.equal(signal?.key, "session_hopping");
  assert.equal(signal?.payload?.deviceCount, 3);
});

test("restricted downstream tracing is bounded and exempts expected creator sponsorship", () => {
  const result = traceRestrictedFunds({
    rootUserId: "target",
    edges: [
      { id: "e1", fromUserId: "middle", toUserId: "target", amountUsd: "10.00", occurredAt: now, sourceType: "transfer" },
      { id: "e2", fromUserId: "restricted", toUserId: "middle", amountUsd: "10.00", occurredAt: now, sourceType: "creator_tip" },
      { id: "e3", fromUserId: "bad", toUserId: "middle", amountUsd: "5.00", occurredAt: now, sourceType: "transfer" },
    ],
    restrictedUserIds: new Set(["restricted", "bad"]),
    creatorUserIds: new Set(["restricted"]),
  });
  assert.equal(result.matched, true);
  assert.deepEqual(result.paths.map((path) => path.originUserId), ["bad"]);
  assert.equal(result.truncated, false);
});
