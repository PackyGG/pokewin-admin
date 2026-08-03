import assert from "node:assert/strict";
import test from "node:test";

import type { EnrichmentResult } from "../src/enrichment.js";
import {
  DEFAULT_MIN_ACCOUNT_AGE_DAYS,
  evaluateFiatPerkCandidate,
  evaluatePerkProviderChecks,
  type FiatPerkCheck,
  type FiatPerkPolicyInput,
} from "../src/fiat-perk-policy.js";
import { evaluateFiatEligibility } from "../src/fiat-eligibility-policy.js";

const NOW = new Date("2026-07-30T12:00:00.000Z");

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 86_400_000);
}

/** A clean, boring, 90-day-old account that plays with its own money. */
function baseInput(): FiatPerkPolicyInput {
  return {
    now: NOW,
    minAccountAgeDays: DEFAULT_MIN_ACCOUNT_AGE_DAYS,
    subject: {
      id: "user-1",
      username: "clean",
      email: "clean@example.com",
      countryCode: "DE",
      createdAt: daysAgo(90),
      isBanned: false,
      isLocked: false,
      isSelfExcluded: false,
      isSuspectedAlt: false,
      fiatLocked: false,
      withdrawalsLocked: false,
      lockReason: null,
      countryBlocked: false,
      countryFiatLocked: false,
      kycRequired: false,
      kycStatus: "none",
      kycAdminDecision: "pending",
    },
    behaviour: {
      cryptoDeposits: 3,
      cryptoDepositUsd: 240,
      fiatDeposits: 0,
      fiatDepositUsd: 0,
      disputedFiat: 0,
      refundedFiat: 0,
      wagerUsd: 900,
      gameEvents: 120,
      rewardUsd: 12,
      rainWins: 2,
      withdrawalRequests: 1,
      withdrawalUsd: 60,
    },
    network: {
      sharedDeviceUsers: 0,
      sharedSignupIpUsers: 0,
      signupIp: "203.0.113.10",
      visitorId: "visitor-1",
    },
    blocklistHits: [],
    history: { signupRiskScore: 4, openCaseSeverity: null },
    providers: [],
    providersChecked: false,
  };
}

function provider(
  name: string,
  overrides: Partial<EnrichmentResult> = {},
): EnrichmentResult {
  return {
    provider: name,
    status: "success",
    lookupKey: `key-${name}`,
    completeness: "complete",
    providerModel: name,
    providerVersion: "test-v1",
    provenance: {
      endpoint: "test",
      method: "GET",
      source: "live",
      independent: true,
    },
    signals: [],
    ...overrides,
  } as EnrichmentResult;
}

function cleanProviders(): EnrichmentResult[] {
  return [
    provider("fingerprint"),
    provider("proxycheck"),
    provider("abstract_ip"),
    provider("abstract_email"),
    provider("opportify"),
    provider("maxmind", {
      nativeScore: 2.4,
      response: { risk_score: 2.4, ip_address: { risk: 1.2 } },
    }),
  ];
}

function checkFor(checks: FiatPerkCheck[], key: string): FiatPerkCheck {
  const found = checks.find((check) => check.key === key);
  assert.ok(found, `expected a ${key} check`);
  return found;
}

test("a clean established account passes on data alone", () => {
  const result = evaluateFiatPerkCandidate(baseInput());
  assert.equal(result.verdict, "pass");
  assert.equal(result.blockingReasons.length, 0);
  assert.equal(result.riskScore, 0);
});

test("an account younger than the scope minimum fails", () => {
  const input = baseInput();
  input.subject.createdAt = daysAgo(6);
  const result = evaluateFiatPerkCandidate(input);
  assert.equal(result.verdict, "fail");
  assert.ok(result.blockingReasons.includes("account_age"));
});

test("14 days is the default entry bar, not 15", () => {
  const input = baseInput();
  input.subject.createdAt = daysAgo(14);
  assert.equal(evaluateFiatPerkCandidate(input).verdict, "pass");
  input.subject.createdAt = daysAgo(13.9);
  assert.ok(
    evaluateFiatPerkCandidate(input).blockingReasons.includes("account_age"),
  );
});

test("a rain farmer that never funded is rejected", () => {
  const input = baseInput();
  input.behaviour = {
    ...input.behaviour,
    cryptoDeposits: 0,
    cryptoDepositUsd: 0,
    fiatDeposits: 0,
    fiatDepositUsd: 0,
    rewardUsd: 140,
    rainWins: 26,
    wagerUsd: 30,
  };
  const result = evaluateFiatPerkCandidate(input);
  assert.equal(result.verdict, "fail");
  assert.ok(result.blockingReasons.includes("reward_farming"));
  assert.ok(result.blockingReasons.includes("rain_extraction"));
});

test("a small unfunded reward balance is held for review, not failed", () => {
  const input = baseInput();
  input.behaviour = {
    ...input.behaviour,
    cryptoDeposits: 0,
    cryptoDepositUsd: 0,
    fiatDeposits: 0,
    fiatDepositUsd: 0,
    rewardUsd: 5,
    rainWins: 1,
    withdrawalRequests: 0,
    withdrawalUsd: 0,
  };
  const result = evaluateFiatPerkCandidate(input);
  assert.equal(result.verdict, "review");
  assert.equal(result.blockingReasons.length, 0);
});

test("withdrawing without ever funding is rejected", () => {
  const input = baseInput();
  input.behaviour = {
    ...input.behaviour,
    cryptoDeposits: 0,
    cryptoDepositUsd: 0,
    fiatDeposits: 0,
    fiatDepositUsd: 0,
    rewardUsd: 0,
    withdrawalRequests: 2,
    withdrawalUsd: 180,
  };
  const result = evaluateFiatPerkCandidate(input);
  assert.equal(result.verdict, "fail");
  assert.ok(result.blockingReasons.includes("cashout_without_funding"));
});

test("a never-funded account with no reward extraction can still pass", () => {
  const input = baseInput();
  input.behaviour = {
    ...input.behaviour,
    cryptoDeposits: 0,
    cryptoDepositUsd: 0,
    fiatDeposits: 0,
    fiatDepositUsd: 0,
    rewardUsd: 0,
    rainWins: 0,
    withdrawalRequests: 0,
    withdrawalUsd: 0,
  };
  const result = evaluateFiatPerkCandidate(input);
  assert.equal(result.verdict, "pass");
});

test("each blacklist kind is its own blocking reason", () => {
  for (
    const [kind, key] of [
      ["email_domain", "blacklist_email_domain"],
      ["ip", "blacklist_ip"],
      ["fingerprint", "blacklist_fingerprint"],
    ] as const
  ) {
    const input = baseInput();
    input.blocklistHits = [{ kind, value: "bad", reason: "known abuse" }];
    const result = evaluateFiatPerkCandidate(input);
    assert.equal(result.verdict, "fail", kind);
    assert.ok(result.blockingReasons.includes(key), kind);
  }
});

test("a shared device rejects the account", () => {
  const input = baseInput();
  input.network.sharedDeviceUsers = 1;
  const result = evaluateFiatPerkCandidate(input);
  assert.equal(result.verdict, "fail");
  assert.ok(result.blockingReasons.includes("shared_device"));
});

test("shared signup IPs escalate from review to reject", () => {
  const input = baseInput();
  input.network.sharedSignupIpUsers = 3;
  assert.equal(evaluateFiatPerkCandidate(input).verdict, "review");
  input.network.sharedSignupIpUsers = 10;
  assert.ok(
    evaluateFiatPerkCandidate(input).blockingReasons
      .includes("shared_signup_ip"),
  );
});

test("prior disputes and refunds reject the account", () => {
  const input = baseInput();
  input.behaviour.disputedFiat = 1;
  const result = evaluateFiatPerkCandidate(input);
  assert.equal(result.verdict, "fail");
  assert.ok(result.blockingReasons.includes("payment_history"));
});

test("restricted, alt-flagged and fraud-locked accounts are rejected", () => {
  for (
    const [mutate, key] of [
      [
        (input: FiatPerkPolicyInput) => {
          input.subject.isBanned = true;
        },
        "account_standing",
      ],
      [
        (input: FiatPerkPolicyInput) => {
          input.subject.isSuspectedAlt = true;
        },
        "suspected_alt",
      ],
      [
        (input: FiatPerkPolicyInput) => {
          input.subject.fiatLocked = true;
        },
        "existing_fraud_lock",
      ],
      [
        (input: FiatPerkPolicyInput) => {
          input.subject.countryFiatLocked = true;
        },
        "country_policy",
      ],
      [
        (input: FiatPerkPolicyInput) => {
          input.subject.kycRequired = true;
          input.subject.kycStatus = "pending";
        },
        "kyc",
      ],
    ] as const
  ) {
    const input = baseInput();
    mutate(input);
    const result = evaluateFiatPerkCandidate(input);
    assert.equal(result.verdict, "fail", key);
    assert.ok(result.blockingReasons.includes(key), key);
  }
});

test("an open high-severity case rejects, a low one only warns", () => {
  const input = baseInput();
  input.history.openCaseSeverity = "high";
  assert.equal(evaluateFiatPerkCandidate(input).verdict, "fail");
  input.history.openCaseSeverity = "low";
  assert.equal(evaluateFiatPerkCandidate(input).verdict, "review");
});

test("a bad IP or device reputation rejects the account", () => {
  const badIp = evaluatePerkProviderChecks([
    provider("fingerprint"),
    provider("proxycheck", {
      score: 95,
      signals: [{
        key: "proxycheck_vpn",
        title: "VPN",
        detail: "VPN detected",
        points: 20,
      }],
    }),
  ]);
  assert.equal(checkFor(badIp, "provider_proxycheck").status, "fail");

  const badDevice = evaluatePerkProviderChecks([
    provider("fingerprint", {
      signals: [{
        key: "fingerprint_tampering",
        title: "Tampering",
        detail: "Browser tampering detected",
        points: 30,
      }],
    }),
    provider("proxycheck"),
  ]);
  assert.equal(
    checkFor(badDevice, "provider_fingerprint").status,
    "fail",
  );
});

test("an unanswered provider holds the account instead of clearing it", () => {
  const input = baseInput();
  input.providersChecked = true;
  input.providers = cleanProviders().map((entry) => entry.provider === "fingerprint"
    ? provider("fingerprint", {
      status: "failed",
      completeness: "unknown",
      errorCode: "http_500",
    })
    : entry);
  const result = evaluateFiatPerkCandidate(input);
  assert.equal(result.verdict, "review");
  assert.equal(result.blockingReasons.length, 0);
});

test("MaxMind Factors is a first-class screening decision with reasons", () => {
  const input = baseInput();
  input.providersChecked = true;
  input.providers = [
    ...cleanProviders().filter((entry) => entry.provider !== "maxmind"),
    provider("maxmind", {
      nativeScore: 82.5,
      response: {
        risk_score: 82.5,
        ip_address: { risk: 76 },
        disposition: { action: "reject" },
        subscores: { email_address: 71, device: 88 },
        risk_score_reasons: [{
          multiplier: 3.4,
          reasons: [{ code: "HIGH_RISK_DEVICE", reason: "Device risk" }],
        }],
      },
    }),
  ];
  const result = evaluateFiatPerkCandidate(input);
  assert.equal(result.verdict, "fail");
  assert.ok(result.blockingReasons.includes("maxmind_risk"));
  assert.ok(result.blockingReasons.includes("maxmind_ip_risk"));
  assert.ok(result.blockingReasons.includes("maxmind_disposition"));
});

test("a low MaxMind score clears while missing MaxMind evidence holds review", () => {
  const clean = baseInput();
  clean.providersChecked = true;
  clean.providers = cleanProviders();
  assert.equal(evaluateFiatPerkCandidate(clean).verdict, "pass");

  const missing = baseInput();
  missing.providersChecked = true;
  missing.providers = [provider("fingerprint"), provider("proxycheck")];
  assert.equal(evaluateFiatPerkCandidate(missing).verdict, "review");
});

test("Abstract Email is required and hard reputation evidence blocks access", () => {
  const input = baseInput();
  input.providersChecked = true;
  input.providers = cleanProviders().map((entry) => entry.provider === "abstract_email"
    ? provider("abstract_email", {
      score: 60,
      signals: [{
        key: "abstract_email_disposable",
        title: "Disposable email",
        detail: "Disposable mailbox provider detected",
        points: 35,
      }],
    })
    : entry);
  const result = evaluateFiatPerkCandidate(input);
  assert.equal(result.verdict, "fail");
  assert.ok(result.blockingReasons.includes("provider_abstract_email"));
});

test("the checkout gate refuses an account without a live perk", () => {
  const subject = {
    id: "user-1",
    username: null,
    email: null,
    image: null,
    signup_ip: "203.0.113.10",
    country: "Germany",
    country_code: "DE",
    continent_code: "EU",
    state: null,
    city: null,
    affiliate_code: null,
    referred_by: null,
    is_suspected_alt: false,
    created_at: daysAgo(400),
    fingerprint_request_id: "req-1",
    visitor_id: "visitor-1",
    fingerprint_confidence: 1,
    fingerprint_ip: "203.0.113.10",
    user_agent: null,
    is_banned: false,
    is_locked: false,
    is_self_excluded: false,
    fiat_locked: false,
    country_blocked: false,
    country_fiat_locked: false,
    kyc_required: false,
    kyc_status: "none",
    kyc_admin_decision: "pending",
    prior_paid_fiat: 0,
  };
  const shared = {
    now: NOW,
    requestCreatedAt: NOW,
    requestIp: "203.0.113.10",
    subject,
    identity: {
      visitorId: "visitor-1",
      linkedId: "user-1",
      eventIp: "203.0.113.10",
      eventTime: NOW,
      replayed: false,
    },
    providers: [provider("fingerprint"), provider("proxycheck")],
    behaviour: {
      cryptoDeposits: 4,
      cryptoDepositUsd: 500,
      fiatDeposits: 2,
      fiatDepositUsd: 200,
      wagerUsd: 2_000,
      gameEvents: 400,
      rewardUsd: 10,
      rainWins: 1,
      withdrawalRequests: 0,
      msSinceLastPaidFiat: null,
    },
    network: { sharedCheckoutVisitorUsers: 0, sharedCurrentIpUsers: 0 },
    blocklistMatches: [],
    signupRiskScore: 0,
    activeCaseSeverity: null,
    attempts10m: 0,
    deniedAttempts24h: 0,
  };

  const denied = evaluateFiatEligibility({
    ...shared,
    perkGate: { enabled: true, granted: false },
  });
  assert.equal(denied.decision, "deny");
  assert.ok(
    denied.signals.some((signal) => signal.key === "fiat_perk_not_granted"),
  );
  // Not being on the allowlist is not an attack, so it must never contain.
  assert.equal(denied.enforce, false);

  const granted = evaluateFiatEligibility({
    ...shared,
    perkGate: { enabled: true, granted: true },
  });
  assert.equal(granted.decision, "allow");

  // Absent gate state behaves exactly as before the perk system existed.
  assert.equal(evaluateFiatEligibility(shared).decision, "allow");
});
