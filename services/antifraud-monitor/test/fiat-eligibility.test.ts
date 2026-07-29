import assert from "node:assert/strict";
import test from "node:test";

import { FingerprintReuseError, fiatEligibilityInternals } from "../src/fiat-eligibility.js";
import { FiatEligibilityAccess } from "../src/fiat-eligibility-auth.js";
import {
  authenticateFiatEligibilityRequest,
  fiatEligibilityRequestSchema,
} from "../src/fiat-eligibility-routes.js";
import type { EnrichmentResult } from "../src/enrichment.js";

const DEV_KEY = "dev-fiat-key-that-is-at-least-32-characters";
const PROD_KEY = "prod-fiat-key-that-is-at-least-32-characters";

function access(): FiatEligibilityAccess {
  return new FiatEligibilityAccess({
    FIAT_ELIGIBILITY_DEV_API_KEY: DEV_KEY,
    FIAT_ELIGIBILITY_PROD_API_KEY: PROD_KEY,
    FIAT_ELIGIBILITY_DEV_ALLOWED_IPS: "10.20.0.0/16,2001:db8::/48",
    FIAT_ELIGIBILITY_PROD_ALLOWED_IPS: "203.0.113.10,2001:db8:1::10",
  });
}

function provider(
  providerName: "fingerprint" | "proxycheck",
  overrides: Partial<EnrichmentResult> = {},
): EnrichmentResult {
  return {
    provider: providerName,
    status: "success",
    lookupKey: "lookup",
    score: 0,
    signals: [],
    ...overrides,
  };
}

function reviewInput(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-07-29T12:00:00.000Z");
  return {
    now,
    requestCreatedAt: new Date("2026-07-29T11:59:30.000Z"),
    subject: {
      id: "user-1",
      username: "safe-user",
      email: "safe@example.com",
      image: null,
      signup_ip: "203.0.113.20",
      country: "Germany",
      country_code: "DE",
      continent_code: "EU",
      state: null,
      city: "Berlin",
      affiliate_code: null,
      referred_by: null,
      is_suspected_alt: false,
      created_at: new Date("2026-01-01T00:00:00.000Z"),
      fingerprint_request_id: "signup-request",
      visitor_id: "visitor-1",
      fingerprint_confidence: 0.99,
      fingerprint_ip: "203.0.113.20",
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
      prior_paid_fiat: 2,
    },
    requestIp: "203.0.113.20",
    fingerprint: provider("fingerprint"),
    proxycheck: provider("proxycheck"),
    fingerprintIdentity: {
      visitorId: "visitor-1",
      linkedId: "user-1",
      eventIp: "203.0.113.20",
      eventTime: new Date("2026-07-29T11:59:35.000Z"),
      replayed: false,
    },
    network: {
      sharedCheckoutVisitorUsers: 0,
      sharedCurrentIpUsers: 0,
    },
    signupRiskScore: 0,
    activeCaseSeverity: null,
    attempts10m: 0,
    deniedAttempts24h: 0,
    ...overrides,
  };
}

test("dedicated Fiat credentials are isolated by environment and source IP", () => {
  assert.deepEqual(
    authenticateFiatEligibilityRequest(access(), {
      authorization: `Bearer ${PROD_KEY}`,
      sourceIp: "203.0.113.10",
      environment: "prod",
    }),
    { authorized: true, environment: "prod" },
  );
  assert.deepEqual(
    authenticateFiatEligibilityRequest(access(), {
      authorization: `Bearer ${DEV_KEY}`,
      sourceIp: "10.20.44.8",
      environment: "prod",
    }),
    {
      authorized: false,
      status: 403,
      error: "environment_credential_mismatch",
    },
  );
  assert.deepEqual(
    authenticateFiatEligibilityRequest(access(), {
      authorization: `Bearer ${PROD_KEY}`,
      sourceIp: "203.0.113.11",
      environment: "prod",
    }),
    {
      authorized: false,
      status: 403,
      error: "source_ip_not_allowed",
    },
  );
  assert.deepEqual(
    authenticateFiatEligibilityRequest(access(), {
      authorization: "Bearer read-token-that-must-not-work",
      sourceIp: "203.0.113.10",
      environment: "prod",
    }),
    { authorized: false, status: 401, error: "unauthorized" },
  );
});

test("Fiat request contract accepts only the exact dev/prod payload", () => {
  const parsed = fiatEligibilityRequestSchema.safeParse({
    env: "dev",
    createdAt: "2026-07-29T12:00:00.000Z",
    ipAddress: "2001:db8::123",
    fingerprint: "fingerprint-request-id",
    userID: "user-1",
  });
  assert.equal(parsed.success, true);
  assert.equal(
    fiatEligibilityRequestSchema.safeParse({
      env: "staging",
      createdAt: "2026-07-29T12:00:00.000Z",
      ipAddress: "not-an-ip",
      fingerprint: "short",
      userID: "user-1",
      unexpected: true,
    }).success,
    false,
  );
});

test("established matching account is automatically allowed", () => {
  const reviewed = fiatEligibilityInternals.automaticReview(reviewInput());
  assert.equal(reviewed.decision, "allow");
  assert.equal(reviewed.riskScore, 0);
  assert.equal(
    reviewed.signals.some((signal) => signal.key === "established_fiat_history"),
    true,
  );
});

test("new account with changed IP and device is automatically denied", () => {
  const base = reviewInput();
  const reviewed = fiatEligibilityInternals.automaticReview({
    ...base,
    subject: {
      ...base.subject,
      created_at: new Date("2026-07-29T06:00:00.000Z"),
      signup_ip: "198.51.100.4",
      visitor_id: "signup-device",
      prior_paid_fiat: 0,
    },
    fingerprintIdentity: {
      ...base.fingerprintIdentity,
      visitorId: "checkout-device",
    },
  });
  assert.equal(reviewed.decision, "deny");
  assert.ok(reviewed.riskScore >= 50);
  assert.deepEqual(
    reviewed.signals
      .filter((signal) =>
        ["account_younger_than_one_day", "signup_ip_changed", "signup_fingerprint_changed"]
          .includes(signal.key)
      )
      .map((signal) => signal.key)
      .sort(),
    [
      "account_younger_than_one_day",
      "signup_fingerprint_changed",
      "signup_ip_changed",
    ],
  );
});

test("manual Fiat-off controller and provider failures fail closed", () => {
  const base = reviewInput();
  const reviewed = fiatEligibilityInternals.automaticReview({
    ...base,
    subject: { ...base.subject, fiat_locked: true },
    proxycheck: provider("proxycheck", {
      status: "failed",
      errorCode: "timeout",
    }),
  });
  assert.equal(reviewed.decision, "deny");
  assert.equal(
    reviewed.signals.find((signal) => signal.key === "fiat_disabled_for_user")
      ?.blocking,
    true,
  );
  assert.equal(
    reviewed.signals.find((signal) => signal.key === "ip_check_unavailable")
      ?.blocking,
    true,
  );
});

test("fresh Fingerprint identity is mandatory and replay-safe", () => {
  const base = reviewInput();
  const reviewed = fiatEligibilityInternals.automaticReview({
    ...base,
    fingerprintIdentity: {
      ...base.fingerprintIdentity,
      linkedId: null,
      eventTime: new Date("2026-07-29T11:55:00.000Z"),
      replayed: true,
    },
  });
  assert.equal(reviewed.decision, "deny");
  for (const key of [
    "fingerprint_linked_id_missing",
    "fingerprint_event_stale",
    "fingerprint_event_replayed",
  ]) {
    assert.equal(
      reviewed.signals.find((signal) => signal.key === key)?.blocking,
      true,
    );
  }
  assert.equal(new FingerprintReuseError().name, "FingerprintReuseError");
});
