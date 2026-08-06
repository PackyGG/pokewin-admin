import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import Fastify from "fastify";

import type { Config } from "../src/config.js";
import {
  FiatEligibilityService,
  FingerprintReuseError,
  fiatEligibilityInternals,
} from "../src/fiat-eligibility.js";
import { parseFiatEligibilityGloballyEnabled } from "../src/config.js";
import { FiatEligibilityAccess } from "../src/fiat-eligibility-auth.js";
import {
  authenticateFiatEligibilityRequest,
  fiatEligibilityRequestSchema,
  registerFiatEligibilityRoutes,
} from "../src/fiat-eligibility-routes.js";
import {
  providerContractMetadata,
  type EnrichmentResult,
} from "../src/enrichment.js";
import {
  CONTAINING_FINGERPRINT_SIGNALS,
  SMALL_CRYPTO_DEPOSIT_USD,
  SMALL_CRYPTO_TRUST_WEIGHT,
  type FiatEligibilityBehaviour,
  type FiatEligibilityPolicyInput,
  type FiatEligibilitySubject,
} from "../src/fiat-eligibility-policy.js";

const DEV_KEY = "dev-fiat-key-that-is-at-least-32-characters";
const PROD_KEY = "prod-fiat-key-that-is-at-least-32-characters";
const serverSource = readFileSync(
  new URL("../src/server.ts", import.meta.url),
  "utf8",
);

function access(): FiatEligibilityAccess {
  return new FiatEligibilityAccess({
    FIAT_ELIGIBILITY_DEV_API_KEY: DEV_KEY,
    FIAT_ELIGIBILITY_PROD_API_KEY: PROD_KEY,
    FIAT_ELIGIBILITY_DEV_ALLOWED_IPS: "10.20.0.0/16,2001:db8::/48",
    FIAT_ELIGIBILITY_PROD_ALLOWED_IPS: "203.0.113.10,2001:db8:1::10",
  });
}

function provider(
  providerName: "fingerprint" | "proxycheck" | "abstract_ip",
  overrides: Partial<EnrichmentResult> = {},
): EnrichmentResult {
  return {
    provider: providerName,
    status: "success",
    lookupKey: "lookup",
    score: 0,
    ...providerContractMetadata(providerName, "live", "complete"),
    signals: [],
    ...overrides,
  };
}

/** A clean, established, self-funded account checking out from signup state. */
function subjectFixture(
  overrides: Partial<FiatEligibilitySubject> = {},
): FiatEligibilitySubject & Record<string, unknown> {
  return {
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
    latest_login_ip: "203.0.113.20",
    latest_login_visitor_id: "visitor-1",
    latest_login_at: new Date("2026-07-29T11:58:00.000Z"),
    latest_login_confidence: 0.99,
    latest_login_suspected_alt: false,
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
    ...overrides,
  };
}

function behaviourFixture(
  overrides: Partial<FiatEligibilityBehaviour> = {},
): FiatEligibilityBehaviour {
  return {
    cryptoDeposits: 3,
    cryptoDepositUsd: 150,
    cryptoTrustUsd: 150,
    fiatDeposits: 2,
    fiatDepositUsd: 80,
    wagerUsd: 400,
    gameEvents: 60,
    rewardUsd: 12,
    rainWins: 1,
    withdrawalRequests: 0,
    msSinceLastPaidFiat: 86_400_000,
    ...overrides,
  };
}

function reviewInput(
  overrides: Partial<FiatEligibilityPolicyInput> = {},
): FiatEligibilityPolicyInput {
  const now = new Date("2026-07-29T12:00:00.000Z");
  return {
    now,
    requestCreatedAt: new Date("2026-07-29T11:59:30.000Z"),
    subject: subjectFixture(),
    requestIp: "203.0.113.20",
    providers: [provider("fingerprint"), provider("proxycheck")],
    identity: {
      visitorId: "visitor-1",
      linkedId: "user-1",
      eventIp: "203.0.113.20",
      eventTime: new Date("2026-07-29T11:59:35.000Z"),
      replayed: false,
    },
    behaviour: behaviourFixture(),
    network: {
      sharedCheckoutVisitorUsers: 0,
      sharedCurrentIpUsers: 0,
    },
    blocklistMatches: [],
    additionalBlocklists: {
      emailDomain: null,
      disposableEmailDomain: null,
      disposableEmailPoints: 60,
    },
    signupRiskScore: 0,
    activeCaseSeverity: null,
    attempts10m: 0,
    deniedAttempts24h: 0,
    ...overrides,
  };
}

/** A provider result carrying one named signal, for reputation coverage. */
function providerWithSignal(
  providerName: "fingerprint" | "proxycheck" | "abstract_ip",
  key: string,
  points = 40,
): EnrichmentResult {
  return {
    provider: providerName,
    status: "success",
    lookupKey: "lookup",
    score: 0,
    ...providerContractMetadata(providerName, "live", "complete"),
    signals: [{ key, title: key, detail: key, points }],
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
    amountCents: 2000,
    currency: "USD",
    locale: "en-US",
    timezone: "Europe/Berlin",
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

test("Fiat endpoint rejects oversized bodies before automatic review", async () => {
  const app = Fastify({ logger: false });
  const localAccess = new FiatEligibilityAccess({
    FIAT_ELIGIBILITY_DEV_API_KEY: DEV_KEY,
    FIAT_ELIGIBILITY_PROD_API_KEY: PROD_KEY,
    FIAT_ELIGIBILITY_DEV_ALLOWED_IPS: "127.0.0.1",
    FIAT_ELIGIBILITY_PROD_ALLOWED_IPS: "127.0.0.1",
  });
  let assessed = false;
  await registerFiatEligibilityRoutes(app, {
    config: {
      FIAT_ELIGIBILITY_RATE_LIMIT_PER_MINUTE: 60,
    } as Config,
    access: localAccess,
    service: {
      assess: async () => {
        assessed = true;
        throw new Error("must_not_run");
      },
    } as unknown as FiatEligibilityService,
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/fiat-eligibility/check",
    headers: { authorization: `Bearer ${PROD_KEY}` },
    payload: {
      env: "prod",
      createdAt: new Date().toISOString(),
      ipAddress: "203.0.113.42",
      fingerprint: "fresh-fingerprint-request",
      userID: "user-1",
      padding: "x".repeat(4 * 1024),
    },
  });
  await app.close();

  assert.equal(response.statusCode, 413);
  assert.equal(assessed, false);
});

test("server pre-authentication logs dedicated Fiat endpoint rejections", () => {
  assert.match(
    serverSource,
    /pathname === FIAT_ELIGIBILITY_PATH[\s\S]*?fiat_eligibility\.authentication_rejected[\s\S]*?reply\s*\.code\(authentication\.status\)/,
  );
});

test("server logs the shared dev and prod Fiat endpoint when it starts", () => {
  assert.match(
    serverSource,
    /fiat_eligibility\.endpoint_ready[\s\S]*?new URL\(FIAT_ELIGIBILITY_PATH, config\.PUBLIC_BASE_URL\)[\s\S]*?configuredEnvironments\(\)[\s\S]*?FIAT_ELIGIBILITY_GLOBALLY_ENABLED[\s\S]*?FIAT_ELIGIBILITY_RATE_LIMIT_PER_MINUTE/,
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
    timestamp: "2026-07-29T12:00:00.000Z",
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
  const responses = await Promise.all(
    (["dev", "prod"] as const).map((environment) => app.inject({
      method: "POST",
      url: "/v1/fiat-eligibility/check",
      headers: {
        authorization: `Bearer ${environment === "dev" ? DEV_KEY : PROD_KEY}`,
      },
      payload: {
        env: environment,
        createdAt: new Date().toISOString(),
        ipAddress: clientIp,
        fingerprint,
        userID: `user-log-test-${environment}`,
      },
    })),
  );
  await app.close();

  for (const response of responses) {
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      decisionId: "decision-1",
      allowed: true,
      timestamp: "2026-07-29T12:00:00.000Z",
    });
  }
  const records = logLines.map(
    (line) => JSON.parse(line) as Record<string, unknown>,
  );
  const started = records.filter(
    (record) => record.event === "fiat_eligibility.assessment_started",
  );
  const completed = records.filter(
    (record) => record.event === "fiat_eligibility.assessment_completed",
  );
  assert.deepEqual(
    started.map((record) => record.environment).sort(),
    ["dev", "prod"],
  );
  assert.deepEqual(
    completed.map((record) => record.environment).sort(),
    ["dev", "prod"],
  );
  for (const environment of ["dev", "prod"]) {
    const startedRecord = started.find(
      (record) => record.environment === environment,
    );
    const completedRecord = completed.find(
      (record) => record.environment === environment,
    );
    assert.equal(startedRecord?.userId, `user-log-test-${environment}`);
    assert.equal(startedRecord?.clientAddressFamily, 4);
    assert.equal(completedRecord?.decisionId, decision.decisionId);
    assert.equal(completedRecord?.decision, "allow");
    assert.equal(completedRecord?.riskScore, 8);
    assert.deepEqual(completedRecord?.reasonCodes, ["established_account"]);
    assert.equal(typeof completedRecord?.durationMs, "number");
    assert.equal(startedRecord?.requestId, completedRecord?.requestId);
  }

  const serializedLogs = logLines.join("");
  assert.equal(serializedLogs.includes(DEV_KEY), false);
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
  assert.equal(reviewed.enforce, false);
  assert.equal(reviewed.riskScore, 0);
  assert.deepEqual(reviewed.enforcementReasons, []);
  // Behaviour credit is what earns the headroom, and it is capped as a group.
  const credit = reviewed.signals
    .filter((signal) => signal.points < 0)
    .reduce((total, signal) => total + signal.points, 0);
  assert.ok(credit < 0);
  assert.ok(credit >= -30);
});

test("changed checkout IP alone is scored and never contains", () => {
  const base = reviewInput();
  const reviewed = fiatEligibilityInternals.automaticReview({
    ...base,
    // Six days old, same device, but a different IP than signup.
    subject: subjectFixture({
      created_at: new Date("2026-07-23T12:00:00.000Z"),
      signup_ip: "198.51.100.4",
    }),
  });
  assert.equal(reviewed.decision, "allow");
  assert.equal(reviewed.enforce, false);
  assert.deepEqual(reviewed.enforcementReasons, []);
  assert.ok(reviewed.signals.some((signal) => signal.key === "signup_ip_changed"));

  // Eight days old, identical evidence: scored, not contained.
  const older = fiatEligibilityInternals.automaticReview({
    ...base,
    subject: subjectFixture({
      created_at: new Date("2026-07-21T12:00:00.000Z"),
      signup_ip: "198.51.100.4",
    }),
  });
  assert.equal(older.enforce, false);
  assert.equal(older.decision, "allow");
});

test("changed checkout device is scored against signup and latest login without containment", () => {
  const base = reviewInput();
  const reviewed = fiatEligibilityInternals.automaticReview({
    ...base,
    // 35 hours old, same IP, different device.
    subject: subjectFixture({
      created_at: new Date("2026-07-28T01:00:00.000Z"),
    }),
    identity: { ...base.identity, visitorId: "checkout-device" },
  });
  assert.equal(reviewed.decision, "deny");
  assert.equal(reviewed.enforce, false);
  assert.deepEqual(reviewed.enforcementReasons, []);
  assert.ok(reviewed.signals.some(
    (signal) => signal.key === "signup_fingerprint_changed",
  ));

  // 40 hours old: past the device window, and the IP window does not apply
  // because the IP still matches signup.
  const older = fiatEligibilityInternals.automaticReview({
    ...base,
    subject: subjectFixture({
      created_at: new Date("2026-07-27T20:00:00.000Z"),
    }),
    identity: { ...base.identity, visitorId: "checkout-device" },
  });
  assert.deepEqual(older.enforcementReasons, []);
});

test("changed IP and device plus bad reputation contains at any age", () => {
  const base = reviewInput();
  const drifted = {
    subject: subjectFixture({ signup_ip: "198.51.100.4" }),
    identity: { ...base.identity, visitorId: "checkout-device" },
  };

  // Two years old, both identifiers changed, clean providers: scored only.
  const clean = fiatEligibilityInternals.automaticReview({
    ...base,
    ...drifted,
  });
  assert.deepEqual(clean.enforcementReasons, []);

  for (const [label, providers] of [
    ["bad IP", [
      provider("fingerprint"),
      providerWithSignal("proxycheck", "proxycheck_anonymous", 55),
    ]],
    ["bad device", [
      providerWithSignal("fingerprint", "fingerprint_tampering", 70),
      provider("proxycheck"),
    ]],
    ["bad corroborating IP", [
      provider("fingerprint"),
      provider("proxycheck"),
      providerWithSignal("abstract_ip", "abstract_ip_abuse", 80),
    ]],
  ] as const) {
    const reviewed = fiatEligibilityInternals.automaticReview({
      ...base,
      ...drifted,
      providers,
    });
    assert.equal(reviewed.decision, "deny", label);
    assert.ok(
      reviewed.enforcementReasons.includes(
        "checkout_identity_changed_with_bad_reputation",
      ),
      label,
    );
  }
});

test("latest verified login is a second checkout identity baseline", () => {
  const base = reviewInput();
  const matching = fiatEligibilityInternals.automaticReview(base);
  assert.equal(
    matching.signals.some((signal) => signal.key.startsWith("latest_login_")),
    false,
  );

  const changedIp = fiatEligibilityInternals.automaticReview({
    ...base,
    subject: subjectFixture({ latest_login_ip: "198.51.100.4" }),
  });
  assert.ok(
    changedIp.signals.some((signal) => signal.key === "latest_login_ip_changed"),
  );

  const changedDevice = fiatEligibilityInternals.automaticReview({
    ...base,
    subject: subjectFixture({ latest_login_visitor_id: "login-device" }),
  });
  assert.ok(
    changedDevice.signals.some(
      (signal) => signal.key === "latest_login_fingerprint_changed",
    ),
  );
});

test("checkout differing from a recent login on both IP and device is denied", () => {
  const base = reviewInput();
  const reviewed = fiatEligibilityInternals.automaticReview({
    ...base,
    subject: subjectFixture({
      latest_login_ip: "198.51.100.4",
      latest_login_visitor_id: "login-device",
      latest_login_at: new Date("2026-07-29T11:55:00.000Z"),
    }),
  });
  assert.equal(reviewed.decision, "deny");
  assert.equal(reviewed.enforce, false);
  assert.equal(
    reviewed.signals.find(
      (signal) => signal.key === "recent_login_identity_mismatch",
    )?.blocking,
    true,
  );
});

test("bad checkout identity drift from latest login contains at any age", () => {
  const base = reviewInput();
  const reviewed = fiatEligibilityInternals.automaticReview({
    ...base,
    subject: subjectFixture({
      latest_login_ip: "198.51.100.4",
      latest_login_visitor_id: "login-device",
      latest_login_at: new Date("2026-07-01T00:00:00.000Z"),
    }),
    providers: [
      provider("fingerprint"),
      providerWithSignal("proxycheck", "proxycheck_anonymous", 55),
    ],
  });
  assert.equal(reviewed.decision, "deny");
  assert.ok(
    reviewed.enforcementReasons.includes(
      "checkout_identity_changed_from_latest_login_with_bad_reputation",
    ),
  );
});

test("a live provider risk score alone counts as bad reputation", () => {
  assert.equal(
    fiatEligibilityInternals.badIpReputation([
      provider("proxycheck", { score: 51 }),
    ]),
    true,
  );
  assert.equal(
    fiatEligibilityInternals.badIpReputation([
      provider("proxycheck", { score: 50 }),
    ]),
    false,
  );
  assert.equal(
    fiatEligibilityInternals.badDeviceReputation([
      provider("fingerprint", { score: 40 }),
    ]),
    true,
  );
  // A failed provider has no opinion — it must never read as clean OR as bad.
  assert.equal(
    fiatEligibilityInternals.badIpReputation([
      provider("proxycheck", { status: "failed", score: 99 }),
    ]),
    false,
  );
});

test("a second checkout within 60s is denied without containment", () => {
  const base = reviewInput();
  const reviewed = fiatEligibilityInternals.automaticReview({
    ...base,
    behaviour: behaviourFixture({ msSinceLastPaidFiat: 12_000 }),
  });
  assert.equal(reviewed.decision, "deny");
  assert.equal(reviewed.enforce, false);
  assert.deepEqual(reviewed.enforcementReasons, []);
  assert.ok(reviewed.signals.some(
    (signal) => signal.key === "repeat_fiat_within_sixty_seconds",
  ));

  const later = fiatEligibilityInternals.automaticReview({
    ...base,
    behaviour: behaviourFixture({ msSinceLastPaidFiat: 61_000 }),
  });
  assert.deepEqual(later.enforcementReasons, []);
  assert.equal(later.decision, "allow");
});

test("an operator blocklist hit on the checkout IP or device contains", () => {
  for (const kind of ["ip", "fingerprint"] as const) {
    const reviewed = fiatEligibilityInternals.automaticReview({
      ...reviewInput(),
      blocklistMatches: [{
        id: "rule-1",
        kind,
        value: kind === "ip" ? "203.0.113.20" : "visitor-1",
        reason: "manual fraud rule",
        effect: "block",
        matched_on: "checkout",
      }],
    });
    assert.equal(reviewed.decision, "deny");
    assert.deepEqual(reviewed.enforcementReasons, [`blocklist_${kind}_match`]);
  }
});

test("pre-Fiat source and blocklist reads include latest login identity", async () => {
  let sourceSql = "";
  let sourceValues: unknown[] = [];
  await fiatEligibilityInternals.loadSourceSubject({
    query: async (text: string, values: unknown[]) => {
      sourceSql = text;
      sourceValues = values;
      return { rows: [] };
    },
  } as never, "user-1");
  assert.match(sourceSql, /event_type = 'signup'/);
  assert.match(sourceSql, /event_type = 'login'/);
  assert.match(sourceSql, /latest_login_visitor_id/);
  assert.match(sourceSql, /latest_login_ip/);
  assert.match(sourceSql, /ABS\(lt\.amount::numeric\) < \$6::numeric/);
  assert.deepEqual(sourceValues.slice(-2), [
    SMALL_CRYPTO_DEPOSIT_USD,
    SMALL_CRYPTO_TRUST_WEIGHT,
  ]);

  let blocklistValues: unknown[] = [];
  let blocklistSql = "";
  await fiatEligibilityInternals.loadBlocklistMatches({
    query: async (text: string, values: unknown[]) => {
      blocklistSql = text;
      blocklistValues = values;
      return { rows: [] };
    },
  } as never, {
    requestIp: "203.0.113.20",
    checkoutVisitorId: "checkout-device",
    latestLoginIp: "198.51.100.4",
    latestLoginVisitorId: "login-device",
    signupIp: "192.0.2.8",
    signupVisitorId: "signup-device",
  });
  assert.deepEqual(blocklistValues, [
    "203.0.113.20",
    "checkout-device",
    "198.51.100.4",
    "login-device",
    "192.0.2.8",
    "signup-device",
  ]);
  assert.match(blocklistSql, /'latest_login'/);
  assert.match(blocklistSql, /ROW_NUMBER\(\) OVER/);
});

test("a known VPN IP raises Fiat risk without containing", () => {
  const reviewed = fiatEligibilityInternals.automaticReview({
    ...reviewInput(),
    blocklistMatches: [{
      id: "vpn-1",
      kind: "ip",
      value: "203.0.113.20",
      reason: "shared VPN exit",
      effect: "known_vpn",
      matched_on: "checkout",
    }],
  });
  assert.equal(reviewed.enforce, false);
  assert.equal(reviewed.signals.find((signal) => signal.key === "known_vpn_ip_match")?.points, 15);
});

test("all remaining checkout blocklists deny with the correct containment", () => {
  const operatorEmail = fiatEligibilityInternals.automaticReview({
    ...reviewInput(),
    additionalBlocklists: {
      ...reviewInput().additionalBlocklists,
      emailDomain: "fraud.example",
    },
  });
  assert.equal(operatorEmail.decision, "deny");
  assert.deepEqual(operatorEmail.enforcementReasons, [
    "blocklist_email_domain_match",
  ]);

  const disposable = fiatEligibilityInternals.automaticReview({
    ...reviewInput(),
    additionalBlocklists: {
      ...reviewInput().additionalBlocklists,
      disposableEmailDomain: "temporary.example",
    },
  });
  assert.equal(disposable.decision, "deny");
  assert.equal(disposable.enforce, false);
  assert.ok(disposable.signals.some(
    (signal) => signal.key === "disposable_email_domain_match",
  ));

});

test("pre-Fiat reads operator and disposable email lists", async () => {
  const queries: string[] = [];
  const antifraud = {
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: [{ active: true }] };
    },
  };
  const matches = await fiatEligibilityInternals.loadAdditionalBlocklists(
    antifraud as never,
    {
      email: "person@mailinator.com",
      disposableEmailPoints: 60,
    },
  );
  assert.equal(matches.emailDomain, "mailinator.com");
  assert.equal(matches.disposableEmailDomain, "mailinator.com");
  assert.ok(queries.some((sql) => sql.includes("fiat_email_domain_blacklist")));
});

test("pre-Fiat observations query every assessment without creating actions", async () => {
  let sql = "";
  let values: unknown[] = [];
  const evidence = await fiatEligibilityInternals.loadPrePaymentObservations({
    query: async (text: string, bound: unknown[]) => {
      sql = text;
      values = bound;
      return { rows: [{
        ip_attempts_10m: 2,
        device_attempts_10m: 1,
        platform_attempts_10m: 19,
        ip_distinct_users_24h: 2,
        device_distinct_users_24h: 1,
        linked_active_risk_users: 1,
        amount_attempts_30m: 4,
        amount_distinct_users_30m: 2,
        ip_has_current_user_24h: false,
        device_has_current_user_24h: false,
        amount_has_current_user_30m: false,
      }] };
    },
  } as never, {
    environment: "prod",
    userId: "user-1",
    requestIp: "203.0.113.20",
    checkoutVisitorId: "visitor-1",
    amountCents: 2000,
    currency: "USD",
  });
  assert.deepEqual(values, [
    "prod", "user-1", "203.0.113.20", "visitor-1", 2000, "USD",
  ]);
  assert.match(sql, /fiat_eligibility_assessments/);
  assert.match(sql, /provider_evidence#>>'\{requestContext,currency\}'/);
  assert.equal(evidence.ipAttempts10m, 3);
  assert.equal(evidence.amountDistinctUsers30m, 3);
  assert.equal(evidence.status, "complete");
  assert.match(sql, /CASE[\s\S]+\^\[0-9\]\+\$/);
});

test("pre-Fiat distinct counts do not add an already-seen current user", async () => {
  const evidence = await fiatEligibilityInternals.loadPrePaymentObservations({
    query: async () => ({ rows: [{
      ip_attempts_10m: 2,
      device_attempts_10m: 2,
      platform_attempts_10m: 5,
      ip_distinct_users_24h: 2,
      device_distinct_users_24h: 2,
      linked_active_risk_users: 0,
      amount_attempts_30m: 2,
      amount_distinct_users_30m: 2,
      ip_has_current_user_24h: true,
      device_has_current_user_24h: true,
      amount_has_current_user_30m: true,
    }] }),
  } as never, {
    environment: "prod",
    userId: "user-1",
    requestIp: "203.0.113.20",
    checkoutVisitorId: "visitor-1",
    amountCents: 2000,
    currency: "USD",
  });
  assert.equal(evidence.ipAttempts10m, 3);
  assert.equal(evidence.ipDistinctUsers24h, 2);
  assert.equal(evidence.deviceDistinctUsers24h, 2);
  assert.equal(evidence.amountAttempts30m, 3);
  assert.equal(evidence.amountDistinctUsers30m, 2);
});

test("behaviour rewards self-funded play and punishes reward farming", () => {
  const farmed = fiatEligibilityInternals.automaticReview({
    ...reviewInput(),
    subject: subjectFixture({
      created_at: new Date("2026-07-01T12:00:00.000Z"),
      prior_paid_fiat: 0,
    }),
    behaviour: behaviourFixture({
      cryptoDeposits: 0,
      cryptoDepositUsd: 0,
      cryptoTrustUsd: 0,
      fiatDeposits: 0,
      fiatDepositUsd: 0,
      wagerUsd: 0,
      gameEvents: 0,
      rewardUsd: 40,
      rainWins: 9,
      withdrawalRequests: 2,
      msSinceLastPaidFiat: null,
    }),
  });
  assert.equal(farmed.decision, "deny");
  assert.equal(farmed.enforce, false, "farming is scored, never contained");
  const farmedKeys = farmed.signals.map((signal) => signal.key);
  assert.ok(farmedKeys.includes("behaviour_reward_farmed_never_funded"));
  assert.ok(farmedKeys.includes("behaviour_withdrawing_without_funding"));

  // Higher crypto volume buys strictly more headroom than a small deposit.
  const scoreFor = (cryptoTrustUsd: number): number =>
    fiatEligibilityInternals.automaticReview({
      ...reviewInput(),
      subject: subjectFixture({ signup_ip: "198.51.100.4" }),
      behaviour: behaviourFixture({
        cryptoDepositUsd: cryptoTrustUsd,
        cryptoTrustUsd,
      }),
    }).riskScore;
  assert.ok(scoreFor(600) <= scoreFor(120));
  assert.ok(scoreFor(120) <= scoreFor(30));

  const smallOnly = fiatEligibilityInternals.automaticReview({
    ...reviewInput(),
    subject: subjectFixture({
      created_at: new Date("2026-07-01T12:00:00.000Z"),
    }),
    behaviour: behaviourFixture({
      cryptoDeposits: 3,
      cryptoDepositUsd: 42,
      cryptoTrustUsd: 10.5,
      fiatDeposits: 0,
      fiatDepositUsd: 0,
      gameEvents: 0,
      rewardUsd: 40,
      withdrawalRequests: 1,
    }),
  });
  assert.equal(
    smallOnly.signals.some(
      (signal) => signal.key === "behaviour_crypto_funding_history",
    ),
    false,
  );
  assert.ok(
    smallOnly.signals.some(
      (signal) => signal.key === "behaviour_reward_farmed_never_funded",
    ),
  );

  // Credits never apply once anything blocking fired.
  const blocked = fiatEligibilityInternals.automaticReview({
    ...reviewInput(),
    subject: subjectFixture({ is_banned: true }),
  });
  assert.equal(blocked.signals.some((signal) => signal.points < 0), false);
  assert.equal(blocked.riskScore, 100);
});

test("manual Fiat-off controller and provider failures fail closed", () => {
  const base = reviewInput();
  const reviewed = fiatEligibilityInternals.automaticReview({
    ...base,
    subject: subjectFixture({ fiat_locked: true }),
    providers: [
      provider("fingerprint"),
      provider("proxycheck", { status: "failed", errorCode: "timeout" }),
    ],
  });
  assert.equal(reviewed.decision, "deny");
  assert.equal(reviewed.enforce, false, "a refusal is not an account offence");
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

test("a degraded corroborating provider scores but never blocks", () => {
  const reviewed = fiatEligibilityInternals.automaticReview({
    ...reviewInput(),
    providers: [
      provider("fingerprint"),
      provider("proxycheck"),
      provider("abstract_ip", { status: "failed", errorCode: "timeout" }),
    ],
  });
  assert.equal(reviewed.decision, "allow");
  const signal = reviewed.signals.find(
    (candidate) => candidate.key === "abstract_ip_check_degraded",
  );
  assert.equal(signal?.blocking, false);
  assert.equal(signal?.points, 10);
});

test("fresh Fingerprint identity is mandatory and replay-safe", () => {
  const base = reviewInput();
  const reviewed = fiatEligibilityInternals.automaticReview({
    ...base,
    identity: {
      ...base.identity,
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
  // A replayed event is forgery: contain. A missing link is a broken
  // integration: deny only.
  assert.deepEqual(reviewed.enforcementReasons, ["fingerprint_event_replayed"]);
  assert.equal(new FingerprintReuseError().name, "FingerprintReuseError");

  const foreignDevice = fiatEligibilityInternals.automaticReview({
    ...base,
    identity: { ...base.identity, linkedId: "another-user" },
  });
  assert.deepEqual(foreignDevice.enforcementReasons, [
    "fingerprint_linked_id_mismatch",
  ]);
});

test("every containment reason is one the dashboard will honour", () => {
  // The ingest route re-validates reason codes before it touches MAIN. A rule
  // the policy can emit but the route rejects would deny and silently never
  // lock, so the two lists must not drift.
  const dashboardReasons = new Set(
    [...readFileSync(
      new URL(
        "../../../src/app/api/antifraud/ingest/route.ts",
        import.meta.url,
      ),
      "utf8",
    ).matchAll(
      /FIAT_ELIGIBILITY_CONTAINMENT_REASONS = new Set\(\[([\s\S]*?)\]\)/g,
    )].flatMap((match) =>
      [...(match[1] ?? "").matchAll(/"([a-z0-9_]+)"/g)]
        .map((entry) => entry[1] ?? ""),
    ),
  );
  assert.ok(dashboardReasons.size >= 9);

  const emitted = new Set<string>([
    "checkout_identity_changed_with_bad_reputation",
    "checkout_identity_changed_from_latest_login_with_bad_reputation",
    "blocklist_ip_match",
    "blocklist_fingerprint_match",
    ...CONTAINING_FINGERPRINT_SIGNALS,
  ]);
  for (const reason of emitted) {
    assert.ok(
      dashboardReasons.has(reason),
      `${reason} is not accepted by the ingest route`,
    );
  }
});

test("concurrent identical requests share one automatic provider review", async () => {
  let releaseFingerprint!: () => void;
  const fingerprintGate = new Promise<void>((resolve) => {
    releaseFingerprint = resolve;
  });
  let fingerprintCalls = 0;
  let proxycheckCalls = 0;
  let sourceCalls = 0;
  const now = new Date("2026-07-29T12:00:00.000Z");
  const subject = {
    ...subjectFixture(),
    last_paid_fiat_at: null,
    crypto_deposits: 3,
    crypto_deposit_usd: "150.00",
    crypto_trust_usd: "150.00",
    fiat_deposits: 2,
    fiat_deposit_usd: "80.00",
    wager_usd: "400.00",
    game_events: 60,
    reward_usd: "12.00",
    rain_wins: 1,
    withdrawal_requests: 0,
  };
  const source = {
    query: async () => {
      sourceCalls += 1;
      if (sourceCalls === 1) return { rows: [subject] };
      return {
        rows: [{
          shared_checkout_visitor_users: 0,
          shared_current_ip_users: 0,
        }],
      };
    },
  };
  const request = {
    env: "prod" as const,
    createdAt: "2026-07-29T11:59:30.000Z",
    ipAddress: "203.0.113.20",
    fingerprint: "concurrent-fingerprint-request",
    userID: "user-1",
  };
  const storedRow = {
    id: "decision-concurrent",
    request_hash: fiatEligibilityInternals.requestHash(
      request,
      request.ipAddress,
    ),
    decision: "allow",
    risk_score: 0,
    reason_codes: [],
    enforcement: "none",
    enforcement_reasons: [],
    expires_at: new Date(now.getTime() + 60_000),
    created_at: now,
  };
  const statements: string[] = [];
  const answer = async (text: string) => {
    statements.push((text.trim().split("\n")[0] ?? "").trim());
    if (text.includes("WHERE fingerprint_request_id = $1")) return { rows: [] };
    if (text.includes("signup_risk_score")) return { rows: [] };
    if (text.includes("attempts_10m")) {
      return { rows: [{ attempts_10m: 0, denied_attempts_24h: 0 }] };
    }
    if (text.includes("FROM identifier_blocklists")) return { rows: [] };
    if (text.includes("FROM fiat_email_domain_blacklist")) {
      return { rows: [{ active: false }] };
    }
    if (text.includes("INSERT INTO fiat_eligibility_assessments")) {
      return { rows: [storedRow] };
    }
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text.trim())) return { rows: [] };
    throw new Error(`unexpected antifraud query: ${text.slice(0, 60)}`);
  };
  const antifraud = {
    query: (text: string) => answer(text),
    connect: async () => ({
      query: (text: string) => answer(text),
      release: () => undefined,
    }),
  };
  const admin = { query: async () => ({ rows: [{ active: false }] }) };
  const enrichment = {
    fingerprintCheck: async () => {
      fingerprintCalls += 1;
      await fingerprintGate;
      return provider("fingerprint", {
        response: {
          products: {
            identification: {
              data: {
                visitorId: "visitor-1",
                linkedId: "user-1",
                ip: "203.0.113.20",
                time: "2026-07-29T11:59:35.000Z",
              },
            },
          },
        },
      });
    },
    proxycheck: async () => {
      proxycheckCalls += 1;
      return provider("proxycheck");
    },
    abstractIpCheck: async () => provider("abstract_ip"),
  };
  const service = new FiatEligibilityService(
    {
      source,
      fiatDevSource: null,
      antifraud,
    } as never,
    { get: async () => ({}) } as never,
    enrichment as never,
    true,
  );

  const first = service.assess(request, now);
  const second = service.assess(request, now);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fingerprintCalls, 1);
  assert.equal(proxycheckCalls, 1);
  releaseFingerprint();

  const [primary, follower] = await Promise.all([first, second]);
  assert.equal(primary.decisionId, "decision-concurrent");
  assert.equal(primary.idempotent, false);
  assert.equal(follower.decisionId, primary.decisionId);
  assert.equal(follower.idempotent, true);
  assert.equal(sourceCalls, 2);
  // The assessment insert and its containment decision share one transaction.
  assert.ok(statements.includes("BEGIN"));
  assert.ok(statements.includes("COMMIT"));
});

test("a hanging corroborating provider cannot stall a checkout", async () => {
  // Abstract can only ever add points. Its own 5s SDK budget must not make a
  // paying customer wait, so it gets a 2s deadline and a breach is scored.
  assert.equal(
    fiatEligibilityInternals.CORROBORATING_PROVIDER_TIMEOUT_MS,
    2_000,
  );

  const now = new Date("2026-07-29T12:00:00.000Z");
  const subject = {
    ...subjectFixture(),
    last_paid_fiat_at: null,
    crypto_deposits: 3,
    crypto_deposit_usd: "150.00",
    crypto_trust_usd: "150.00",
    fiat_deposits: 2,
    fiat_deposit_usd: "80.00",
    wager_usd: "400.00",
    game_events: 60,
    reward_usd: "12.00",
    rain_wins: 1,
    withdrawal_requests: 0,
  };
  let sourceCalls = 0;
  const source = {
    query: async () => {
      sourceCalls += 1;
      return sourceCalls === 1
        ? { rows: [subject] }
        : { rows: [{ shared_checkout_visitor_users: 0, shared_current_ip_users: 0 }] };
    },
  };
  const request = {
    env: "prod" as const,
    createdAt: "2026-07-29T11:59:30.000Z",
    ipAddress: "203.0.113.20",
    fingerprint: "hanging-corroboration-request",
    userID: "user-1",
  };
  let recordedAbstractStatus: unknown = null;
  const answer = async (text: string, params?: unknown[]) => {
    if (text.includes("WHERE fingerprint_request_id = $1")) return { rows: [] };
    if (text.includes("signup_risk_score")) return { rows: [] };
    if (text.includes("attempts_10m")) {
      return { rows: [{ attempts_10m: 0, denied_attempts_24h: 0 }] };
    }
    if (text.includes("FROM identifier_blocklists")) return { rows: [] };
    if (text.includes("FROM fiat_email_domain_blacklist")) {
      return { rows: [{ active: false }] };
    }
    if (text.includes("INSERT INTO fiat_eligibility_assessments")) {
      const values = (params ?? []) as unknown[];
      recordedAbstractStatus = values[12];
      return {
        rows: [{
          id: "decision-hanging",
          request_hash: fiatEligibilityInternals.requestHash(
            request,
            request.ipAddress,
          ),
          decision: "allow",
          risk_score: 10,
          reason_codes: [],
          enforcement: "none",
          enforcement_reasons: [],
          expires_at: new Date(now.getTime() + 60_000),
          created_at: now,
        }],
      };
    }
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text.trim())) return { rows: [] };
    throw new Error(`unexpected antifraud query: ${text.slice(0, 60)}`);
  };
  const antifraud = {
    query: (text: string, params?: unknown[]) => answer(text, params),
    connect: async () => ({
      query: (text: string, params?: unknown[]) => answer(text, params),
      release: () => undefined,
    }),
  };
  const never = new Promise<never>(() => {});
  const enrichment = {
    fingerprintCheck: async () =>
      provider("fingerprint", {
        response: {
          products: {
            identification: {
              data: {
                visitorId: "visitor-1",
                linkedId: "user-1",
                ip: "203.0.113.20",
                time: "2026-07-29T11:59:35.000Z",
              },
            },
          },
        },
      }),
    proxycheck: async () => provider("proxycheck"),
    abstractIpCheck: () => never,
  };
  const service = new FiatEligibilityService(
    { source, fiatDevSource: null, antifraud } as never,
    { get: async () => ({}) } as never,
    enrichment as never,
    true,
  );

  const startedAt = Date.now();
  const decision = await service.assess(request, now);
  const elapsed = Date.now() - startedAt;

  assert.equal(decision.decisionId, "decision-hanging");
  assert.equal(decision.allowed, true);
  // Bounded by the corroborating deadline, not Abstract's 5s SDK budget.
  assert.ok(elapsed >= 1_800, `returned too early (${elapsed}ms)`);
  assert.ok(elapsed < 5_000, `checkout waited too long (${elapsed}ms)`);
  // The breach is recorded as a provider failure so the policy can score it.
  assert.equal(recordedAbstractStatus, "failed");
});

test("missing or false global Fiat config can never return allow", async () => {
  assert.equal(parseFiatEligibilityGloballyEnabled(undefined), false);
  assert.equal(parseFiatEligibilityGloballyEnabled("false"), false);
  assert.equal(parseFiatEligibilityGloballyEnabled("true"), true);
  assert.equal(parseFiatEligibilityGloballyEnabled("yes"), false);

  for (const env of ["dev", "prod"] as const) {
    let sourceCalls = 0;
    const now = new Date("2026-07-30T12:00:00.000Z");
    const request = {
      env,
      createdAt: now.toISOString(),
      ipAddress: "203.0.113.20",
      fingerprint: `disabled-${env}-fingerprint`,
      userID: "user-1",
    };
    const antifraud = {
      async query(sql: string) {
        if (sql.includes("INSERT INTO fiat_eligibility_gate_events")) {
          return {
            rowCount: 1,
            rows: [{
              id: `disabled-${env}`,
              request_hash: fiatEligibilityInternals.requestHash(
                request,
                request.ipAddress,
              ),
              created_at: now,
            }],
          };
        }
        throw new Error("disabled gate must not run another query");
      },
    };
    const service = new FiatEligibilityService(
      {
        source: { query: async () => { sourceCalls += 1; } },
        fiatDevSource: { query: async () => { sourceCalls += 1; } },
        antifraud,
      } as never,
      { get: async () => { throw new Error("weights must not load"); } } as never,
      {
        fingerprintCheck: async () => {
          throw new Error("provider must not run");
        },
        proxycheck: async () => {
          throw new Error("provider must not run");
        },
      } as never,
      false,
    );
    const decision = await service.assess(request, now);
    assert.equal(decision.allowed, false);
    assert.equal(decision.decision, "deny");
    assert.equal(decision.riskScore, 0);
    assert.deepEqual(decision.reasonCodes, ["fiat_globally_disabled"]);
    assert.equal(sourceCalls, 0);
  }
});
