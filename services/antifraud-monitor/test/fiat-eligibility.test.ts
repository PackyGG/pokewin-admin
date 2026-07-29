import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import type { Config } from "../src/config.js";
import {
  FiatEligibilityService,
  FingerprintReuseError,
  fiatEligibilityInternals,
} from "../src/fiat-eligibility.js";
import { FiatEligibilityAccess } from "../src/fiat-eligibility-auth.js";
import {
  authenticateFiatEligibilityRequest,
  fiatEligibilityRequestSchema,
  registerFiatEligibilityRoutes,
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

test("Fiat endpoint logs correlated decisions without credentials or raw device data", async () => {
  const logLines: string[] = [];
  const app = Fastify({
    logger: {
      level: "info",
      stream: {
        write(line: string) {
          logLines.push(line);
        },
      },
    },
  });
  const localAccess = new FiatEligibilityAccess({
    FIAT_ELIGIBILITY_DEV_API_KEY: DEV_KEY,
    FIAT_ELIGIBILITY_PROD_API_KEY: PROD_KEY,
    FIAT_ELIGIBILITY_DEV_ALLOWED_IPS: "127.0.0.1",
    FIAT_ELIGIBILITY_PROD_ALLOWED_IPS: "127.0.0.1",
  });
  const decision = {
    decisionId: "decision-1",
    decision: "allow" as const,
    allowed: true,
    riskScore: 8,
    reasonCodes: ["established_account"],
    expiresAt: "2026-07-29T12:01:00.000Z",
    idempotent: false,
  };
  const service = {
    assess: async () => decision,
  } as unknown as FiatEligibilityService;
  await registerFiatEligibilityRoutes(app, {
    config: {
      FIAT_ELIGIBILITY_RATE_LIMIT_PER_MINUTE: 60,
    } as Config,
    access: localAccess,
    service,
  });

  const fingerprint = "fresh-sensitive-fingerprint-request";
  const clientIp = "203.0.113.42";
  const response = await app.inject({
    method: "POST",
    url: "/v1/fiat-eligibility/check",
    headers: { authorization: `Bearer ${PROD_KEY}` },
    payload: {
      env: "prod",
      createdAt: new Date().toISOString(),
      ipAddress: clientIp,
      fingerprint,
      userID: "user-log-test",
    },
  });
  await app.close();

  assert.equal(response.statusCode, 200);
  const records = logLines.map(
    (line) => JSON.parse(line) as Record<string, unknown>,
  );
  const started = records.find(
    (record) => record.event === "fiat_eligibility.assessment_started",
  );
  const completed = records.find(
    (record) => record.event === "fiat_eligibility.assessment_completed",
  );
  assert.equal(started?.userId, "user-log-test");
  assert.equal(started?.clientAddressFamily, 4);
  assert.equal(completed?.decisionId, decision.decisionId);
  assert.equal(completed?.decision, "allow");
  assert.equal(completed?.riskScore, 8);
  assert.deepEqual(completed?.reasonCodes, ["established_account"]);
  assert.equal(typeof completed?.durationMs, "number");
  assert.equal(started?.requestId, completed?.requestId);

  const serializedLogs = logLines.join("");
  assert.equal(serializedLogs.includes(PROD_KEY), false);
  assert.equal(serializedLogs.includes(fingerprint), false);
  assert.equal(serializedLogs.includes(clientIp), false);
});

test("Fiat endpoint logs safe rejection, replay, and failure classifications", async () => {
  const logLines: string[] = [];
  const app = Fastify({
    logger: {
      level: "info",
      stream: {
        write(line: string) {
          logLines.push(line);
        },
      },
    },
  });
  const localAccess = new FiatEligibilityAccess({
    FIAT_ELIGIBILITY_DEV_API_KEY: DEV_KEY,
    FIAT_ELIGIBILITY_PROD_API_KEY: PROD_KEY,
    FIAT_ELIGIBILITY_DEV_ALLOWED_IPS: "127.0.0.1",
    FIAT_ELIGIBILITY_PROD_ALLOWED_IPS: "127.0.0.1",
  });
  const secretErrorMessage =
    "database failed at postgresql://private-user:private-password@db";
  const service = {
    assess: async (request: { userID: string }) => {
      if (request.userID === "replay-user") throw new FingerprintReuseError();
      throw Object.assign(new Error(secretErrorMessage), { code: "ECONNRESET" });
    },
  } as unknown as FiatEligibilityService;
  await registerFiatEligibilityRoutes(app, {
    config: {
      FIAT_ELIGIBILITY_RATE_LIMIT_PER_MINUTE: 60,
    } as Config,
    access: localAccess,
    service,
  });
  const requestPayload = {
    env: "prod",
    createdAt: new Date().toISOString(),
    ipAddress: "203.0.113.42",
    fingerprint: "fresh-sensitive-fingerprint-request",
    userID: "failure-user",
  };

  const invalid = await app.inject({
    method: "POST",
    url: "/v1/fiat-eligibility/check",
    payload: { env: "prod" },
  });
  const unauthenticated = await app.inject({
    method: "POST",
    url: "/v1/fiat-eligibility/check",
    headers: { authorization: "Bearer definitely-not-valid" },
    payload: requestPayload,
  });
  const replay = await app.inject({
    method: "POST",
    url: "/v1/fiat-eligibility/check",
    headers: { authorization: `Bearer ${PROD_KEY}` },
    payload: { ...requestPayload, userID: "replay-user" },
  });
  const failed = await app.inject({
    method: "POST",
    url: "/v1/fiat-eligibility/check",
    headers: { authorization: `Bearer ${PROD_KEY}` },
    payload: requestPayload,
  });
  await app.close();

  assert.equal(invalid.statusCode, 400);
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(replay.statusCode, 409);
  assert.equal(failed.statusCode, 503);
  const records = logLines.map(
    (line) => JSON.parse(line) as Record<string, unknown>,
  );
  for (const event of [
    "fiat_eligibility.invalid_request",
    "fiat_eligibility.authentication_rejected",
    "fiat_eligibility.fingerprint_reused",
    "fiat_eligibility.assessment_failed",
  ]) {
    assert.equal(
      records.some((record) => record.event === event),
      true,
      `${event} was not logged`,
    );
  }
  const failure = records.find(
    (record) => record.event === "fiat_eligibility.assessment_failed",
  );
  assert.equal(failure?.errorType, "Error");
  assert.equal(failure?.errorCode, "ECONNRESET");
  assert.equal(logLines.join("").includes(secretErrorMessage), false);
  assert.equal(logLines.join("").includes(PROD_KEY), false);
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
