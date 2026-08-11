import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { Config } from "../src/config.js";
import {
  EnrichmentService,
  fingerprintEventIdentity,
  parseProxycheckResponse,
  providerContractMetadata,
  sanitizeFingerprintResponse,
  type EnrichmentResult,
} from "../src/enrichment.js";
import {
  evaluateFiatEligibility,
  type FiatEligibilityBehaviour,
  type FiatEligibilityPolicyInput,
  type FiatEligibilitySubject,
} from "../src/fiat-eligibility-policy.js";
import { maxMindRiskPoints } from "../src/maxmind.js";
import type { Signup } from "../src/types.js";

const CHECKOUT_IP = "203.0.113.20";
const VISITOR_ID = "visitor-1";
const USER_ID = "user-1";
const REQUEST_ID = "checkout-request-1";

/**
 * A realistic Fingerprint Pro Server API `getEvent` body. The identity block is
 * what binds the event to the requesting user, and it is exactly what
 * `sanitizeFingerprintResponse` has to strip before the body is persisted.
 */
function rawFingerprintEvent(): Record<string, unknown> {
  return {
    products: {
      identification: {
        data: {
          requestId: REQUEST_ID,
          visitorId: VISITOR_ID,
          linkedId: USER_ID,
          ip: CHECKOUT_IP,
          time: "2026-07-29T11:59:35.000Z",
          timestamp: 1_785_326_375_000,
          replayed: false,
          incognito: false,
          url: "https://packy.gg/checkout",
          confidence: { score: 0.99 },
          browserDetails: {
            browserName: "Chrome",
            browserFullVersion: "129.0.0",
            os: "Windows",
            osVersion: "11",
            device: "Other",
            userAgent: "Mozilla/5.0",
          },
          ipLocation: { latitude: 52.52, longitude: 13.4, country: { code: "DE" } },
        },
      },
      botd: { data: { bot: { result: "notDetected" }, ip: CHECKOUT_IP } },
      vpn: { data: { result: false, confidence: "high" } },
      proxy: { data: { result: false } },
      tor: { data: { result: false } },
      ipInfo: {
        data: {
          v4: {
            address: CHECKOUT_IP,
            datacenter: { result: false, name: "" },
            geolocation: { latitude: 52.52, longitude: 13.4 },
          },
        },
      },
      ipBlocklist: { data: { result: false, details: { attackSource: false } } },
      incognito: { data: { result: false } },
      tampering: { data: { result: false, anomalyScore: 0 } },
      virtualMachine: { data: { result: false } },
      highActivity: { data: { result: false } },
      privacySettings: { data: { result: false } },
      developerTools: { data: { result: false } },
      suspectScore: { data: { result: 0 } },
      velocity: { data: { distinctIp: { intervals: { "5m": 1, "1h": 1, "24h": 1 } } } },
    },
  };
}

function signupFixture(): Signup {
  return {
    id: USER_ID,
    username: "safe-user",
    email: "safe@example.com",
    image: null,
    signup_ip: CHECKOUT_IP,
    country: "Germany",
    country_code: "DE",
    continent_code: "EU",
    state: null,
    city: "Berlin",
    affiliate_code: null,
    referred_by: null,
    is_suspected_alt: false,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    fingerprint_request_id: REQUEST_ID,
    visitor_id: VISITOR_ID,
    fingerprint_confidence: 0.99,
    fingerprint_ip: CHECKOUT_IP,
    user_agent: null,
  };
}

/** An EnrichmentService whose Fingerprint client returns a canned event. */
function serviceReturning(event: unknown): EnrichmentService {
  const service = new EnrichmentService({
    FINGERPRINT_SECRET_API_KEY: "fingerprint-secret-key",
    FINGERPRINT_REGION: "eu",
  } as unknown as Config);
  (service as unknown as {
    fingerprint: { getEvent: (id: string) => Promise<unknown> };
  }).fingerprint = { getEvent: async () => event };
  return service;
}

function subjectFixture(): FiatEligibilitySubject & Record<string, unknown> {
  return {
    id: USER_ID,
    username: "safe-user",
    email: "safe@example.com",
    image: null,
    signup_ip: CHECKOUT_IP,
    country: "Germany",
    country_code: "DE",
    continent_code: "EU",
    state: null,
    city: "Berlin",
    affiliate_code: null,
    referred_by: null,
    is_suspected_alt: false,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    fingerprint_request_id: REQUEST_ID,
    visitor_id: VISITOR_ID,
    fingerprint_confidence: 0.99,
    fingerprint_ip: CHECKOUT_IP,
    latest_login_ip: CHECKOUT_IP,
    latest_login_visitor_id: VISITOR_ID,
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
  };
}

function behaviourFixture(): FiatEligibilityBehaviour {
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
  };
}

function policyInput(
  fingerprint: EnrichmentResult,
  identity: FiatEligibilityPolicyInput["identity"],
): FiatEligibilityPolicyInput {
  return {
    now: new Date("2026-07-29T12:00:00.000Z"),
    requestCreatedAt: new Date("2026-07-29T11:59:30.000Z"),
    requestIp: CHECKOUT_IP,
    subject: subjectFixture(),
    identity,
    providers: [
      fingerprint,
      {
        provider: "proxycheck",
        status: "success",
        lookupKey: "lookup",
        score: 0,
        ...providerContractMetadata("proxycheck", "live", "complete"),
        signals: [],
      },
    ],
    behaviour: behaviourFixture(),
    network: { sharedCheckoutVisitorUsers: 0, sharedCurrentIpUsers: 0 },
    blocklistMatches: [],
    additionalBlocklists: {
      emailDomain: null,
      disposableEmailDomain: null,
      disposableEmailPoints: 60,
    },
    geo: {
      checkoutCountryCode: "DE",
      latestLoginCountryCode: "DE",
    },
    whopHistory: {
      observedPayments: 0,
      priorDisputes: 0,
      priorRefunds: 0,
      priorFraudDeclines: 0,
      highRiskSessions: 0,
      maxProviderRiskScore: null,
    },
    signupRiskScore: 0,
    activeCaseSeverity: null,
    attempts10m: 0,
    deniedAttempts24h: 0,
    prePaymentSignals: [],
  };
}

test("the sanitized evidence body still carries no identity — that is why it exists", () => {
  const sanitized = sanitizeFingerprintResponse(rawFingerprintEvent());
  const serialized = JSON.stringify(sanitized);
  assert.doesNotMatch(serialized, /visitor-1|user-1|checkout-request-1/);
  assert.doesNotMatch(serialized, /203\.0\.113\.20/);
  assert.doesNotMatch(serialized, /latitude|longitude/);

  // Deriving identity from the persisted body therefore yields nothing. This
  // is the exact chain that used to deny every fiat checkout.
  const fromSanitized = fingerprintEventIdentity(sanitized);
  assert.equal(fromSanitized.visitorId, null);
  assert.equal(fromSanitized.linkedId, null);
  assert.equal(fromSanitized.eventIp, null);
});

test("fingerprintCheck carries the raw identity alongside the sanitized body", async () => {
  const result = await serviceReturning(rawFingerprintEvent())
    .fingerprintCheck(signupFixture());

  assert.equal(result.status, "success");
  assert.equal(result.identity?.visitorId, VISITOR_ID);
  assert.equal(result.identity?.linkedId, USER_ID);
  assert.equal(result.identity?.eventIp, CHECKOUT_IP);
  assert.equal(result.identity?.replayed, false);
  assert.deepEqual(
    result.identity?.eventTime,
    new Date("2026-07-29T11:59:35.000Z"),
  );

  // The persisted half must remain scrubbed.
  assert.doesNotMatch(
    JSON.stringify(result.response),
    /visitor-1|user-1|203\.0\.113\.20/,
  );
});

test("a matching live Fingerprint event does not fabricate an identity denial", async () => {
  const fingerprint = await serviceReturning(rawFingerprintEvent())
    .fingerprintCheck(signupFixture());
  const identity = fingerprint.identity
    ?? fingerprintEventIdentity(fingerprint.response);

  const outcome = evaluateFiatEligibility(policyInput(fingerprint, identity));
  const keys = outcome.signals.map((signal) => signal.key);

  assert.ok(!keys.includes("fingerprint_linked_id_missing"), keys.join(","));
  assert.ok(!keys.includes("fingerprint_linked_id_mismatch"), keys.join(","));
  assert.ok(!keys.includes("fingerprint_ip_mismatch"), keys.join(","));
  assert.equal(outcome.decision, "allow");
  assert.equal(outcome.enforce, false);
});

test("identity drift from the sanitized fallback still denies a forged checkout", async () => {
  // The real detections must stay alive: an event linked to another account is
  // still forgery, and it must still contain.
  const event = rawFingerprintEvent();
  const products = event.products as Record<
    string,
    { data: Record<string, unknown> }
  >;
  products.identification!.data.linkedId = "someone-else";

  const fingerprint = await serviceReturning(event)
    .fingerprintCheck(signupFixture());
  const outcome = evaluateFiatEligibility(
    policyInput(fingerprint, fingerprint.identity!),
  );

  assert.ok(
    outcome.signals.some(
      (signal) => signal.key === "fingerprint_linked_id_mismatch",
    ),
  );
  assert.equal(outcome.decision, "deny");
});

test("a stubbed provider result without identity falls back to the response", () => {
  // Callers that supply their own EnrichmentResult (replayed evidence, tests)
  // keep working through the response-derived fallback.
  const stub: EnrichmentResult = {
    provider: "fingerprint",
    status: "success",
    lookupKey: "lookup",
    score: 0,
    ...providerContractMetadata("fingerprint", "live", "complete"),
    response: rawFingerprintEvent(),
    signals: [],
  };
  assert.equal(stub.identity, undefined);
  const identity = stub.identity ?? fingerprintEventIdentity(stub.response);
  assert.equal(identity.visitorId, VISITOR_ID);
  assert.equal(identity.linkedId, USER_ID);
});

test("blocklist VPN evidence is derived from a count, never a literal true", () => {
  // The lateral subquery is aggregate-only with no GROUP BY, so it always
  // returns exactly one row. Selecting a literal `true AS detected` made every
  // IP rule claim "VPN/proxy detected" with an empty providers array.
  const source = readFileSync(
    new URL("../src/identifier-blocklist-routes.ts", import.meta.url),
    "utf8",
  );
  const lateral = source.slice(
    source.indexOf("LEFT JOIN LATERAL ("),
    source.indexOf(") vpn ON b.kind='ip'"),
  );
  assert.ok(lateral.length > 0, "expected the VPN evidence lateral join");
  assert.doesNotMatch(lateral, /\btrue AS detected\b/);
  assert.match(lateral, /count\(\*\)\s*>\s*0 AS detected|bool_or\(/);
});

test("MaxMind risk banding is shared, never re-implemented", () => {
  assert.equal(maxMindRiskPoints(90), 55);
  assert.equal(maxMindRiskPoints(85), 55);
  assert.equal(maxMindRiskPoints(70), 40);
  assert.equal(maxMindRiskPoints(50), 25);
  assert.equal(maxMindRiskPoints(25), 10);
  assert.equal(maxMindRiskPoints(5), 0);
  assert.equal(maxMindRiskPoints(4.9), -5);
  assert.equal(maxMindRiskPoints(0), -5);
});

test("a null ProxyCheck confidence keeps full detection points", () => {
  // Number(null) === 0 used to drop this into the `< 85` branch, scoring a live
  // proxy detection at zero while still rendering it as a detection.
  const scored = (confidence: unknown): number => {
    const result = parseProxycheckResponse(
      {
        status: "ok",
        [CHECKOUT_IP]: {
          proxy: "yes",
          risk: 10,
          detections: { proxy: true, tor: true, confidence },
        },
      },
      CHECKOUT_IP,
    );
    const signal = result.signals.find(
      (entry) => entry.key === "proxycheck_anonymous",
    );
    assert.ok(signal, "expected the anonymous-IP detection to be present");
    return signal.points;
  };

  const full = scored(undefined);
  assert.ok(full > 0);
  assert.equal(scored(null), full);
  assert.equal(scored(""), full);
  assert.equal(scored(97), full);
  // A genuine low confidence still discounts, exactly as before.
  assert.equal(scored(86), Math.round(full * 0.75));
  assert.equal(scored(10), 0);
});

test("a null MaxMind risk score fails closed instead of scoring 0.00 risk", async () => {
  const service = new EnrichmentService({
    FINGERPRINT_SECRET_API_KEY: "fingerprint-secret-key",
    FINGERPRINT_REGION: "eu",
    MAXMIND_ACCOUNT_ID: "account",
    MAXMIND_LICENSE_KEY: "license-key",
  } as unknown as Config);
  const originalFetch = globalThis.fetch;
  const responses: unknown[] = [
    { id: "9d2e0b4c-1f3a-4c6b-8f01-2c3d4e5f6a7b", risk_score: null },
    { id: "9d2e0b4c-1f3a-4c6b-8f01-2c3d4e5f6a7b", risk_score: "" },
    { id: "9d2e0b4c-1f3a-4c6b-8f01-2c3d4e5f6a7b" },
  ];
  try {
    for (const body of responses) {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch;
      const result = await service.maxmindCheck(signupFixture());
      assert.equal(result.status, "failed", JSON.stringify(body));
      assert.equal(result.score, undefined);
      assert.equal(result.nativeScore, undefined);
      assert.deepEqual(result.signals, []);
    }

    // A genuine zero is still a successful, credited assessment.
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          id: "9d2e0b4c-1f3a-4c6b-8f01-2c3d4e5f6a7b",
          risk_score: 0,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    const clean = await service.maxmindCheck(signupFixture());
    assert.equal(clean.status, "success");
    assert.equal(clean.score, 0);
    assert.equal(clean.signals[0]?.points, -5);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
