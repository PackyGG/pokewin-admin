import assert from "node:assert/strict";
import test from "node:test";

import {
  CARD_CHANGE_TRUST_DEPOSITS,
  emailDomain,
  evaluateFiatDepositIdentity,
  type FiatIdentityBaseline,
  type FiatIdentityObservation,
} from "../src/fiat-deposit-identity-policy.js";

const OCCURRED_AT = new Date("2026-07-30T12:00:00.000Z");

function baseline(
  overrides: Partial<FiatIdentityBaseline> = {},
): FiatIdentityBaseline {
  return {
    intentId: "intent-first",
    cardBrand: "visa",
    cardLast4: "4242",
    checkoutEmail: "payer@example.com",
    checkoutIp: "203.0.113.10",
    checkoutVisitorId: "visitor-a",
    ...overrides,
  };
}

function observation(
  overrides: Partial<FiatIdentityObservation> = {},
): FiatIdentityObservation {
  return {
    intentId: "intent-second",
    userId: "user-1",
    occurredAt: OCCURRED_AT,
    cardBrand: "visa",
    cardLast4: "4242",
    checkoutEmail: "payer@example.com",
    checkoutIp: "203.0.113.10",
    checkoutVisitorId: "visitor-a",
    email: { catchall: false, deliverability: "deliverable" },
    blacklistedEmailDomain: null,
    blocklistMatches: [],
    priorCleanDeposits: 1,
    ...overrides,
  };
}

test("an unchanged repeat deposit is clear", () => {
  const outcome = evaluateFiatDepositIdentity({
    baseline: baseline(),
    observation: observation(),
  });
  assert.equal(outcome.verdict, "clear");
  assert.deepEqual(outcome.reasonCodes, []);
  assert.deepEqual(outcome.watchCodes, []);
});

test("a blacklisted payer email domain contains the first deposit too", () => {
  const outcome = evaluateFiatDepositIdentity({
    baseline: null,
    observation: observation({
      blacklistedEmailDomain: "bad.example",
      checkoutEmail: "payer@bad.example",
    }),
  });
  assert.equal(outcome.verdict, "contain");
  assert.deepEqual(outcome.reasonCodes, ["checkout_email_domain_blacklisted"]);
});

test("operator blocklist hits contain and name the right kind", () => {
  const outcome = evaluateFiatDepositIdentity({
    baseline: baseline(),
    observation: observation({
      blocklistMatches: [
        { id: "r1", kind: "ip", value: "203.0.113.10", reason: "fraud ring", effect: "block" },
        { id: "r2", kind: "fingerprint", value: "visitor-a", reason: "farm", effect: "block" },
      ],
    }),
  });
  assert.equal(outcome.verdict, "contain");
  assert.deepEqual(outcome.reasonCodes, [
    "checkout_ip_blocklisted",
    "checkout_fingerprint_blocklisted",
  ]);
});

test("a known VPN IP only watches and never contains", () => {
  const outcome = evaluateFiatDepositIdentity({
    baseline: baseline(),
    observation: observation({
      blocklistMatches: [{
        id: "vpn-1",
        kind: "ip",
        value: "203.0.113.10",
        reason: "shared VPN exit",
        effect: "known_vpn",
      }],
    }),
  });
  assert.equal(outcome.verdict, "watch");
  assert.deepEqual(outcome.reasonCodes, []);
  assert.deepEqual(outcome.watchCodes, ["checkout_known_vpn_ip"]);
});

test("a catch-all payer email contains", () => {
  const outcome = evaluateFiatDepositIdentity({
    baseline: null,
    observation: observation({
      email: { catchall: true, deliverability: "deliverable" },
    }),
  });
  assert.equal(outcome.verdict, "contain");
  assert.deepEqual(outcome.reasonCodes, ["checkout_email_catchall"]);
});

test("an undeliverable payer email contains, an unknown one only watches", () => {
  const undeliverable = evaluateFiatDepositIdentity({
    baseline: null,
    observation: observation({
      email: { catchall: false, deliverability: "undeliverable" },
    }),
  });
  assert.equal(undeliverable.verdict, "contain");
  assert.deepEqual(undeliverable.reasonCodes, [
    "checkout_email_undeliverable",
  ]);

  const unknown = evaluateFiatDepositIdentity({
    baseline: null,
    observation: observation({
      email: { catchall: false, deliverability: "unknown" },
    }),
  });
  assert.equal(unknown.verdict, "watch");
  assert.deepEqual(unknown.watchCodes, [
    "checkout_email_deliverability_unknown",
  ]);
});

test("a missing provider answer never contains", () => {
  const outcome = evaluateFiatDepositIdentity({
    baseline: baseline(),
    observation: observation({
      email: { catchall: null, deliverability: null },
    }),
  });
  assert.equal(outcome.verdict, "clear");
});

test("a changed payer email contains regardless of history", () => {
  const outcome = evaluateFiatDepositIdentity({
    baseline: baseline(),
    observation: observation({
      checkoutEmail: "someone.else@example.com",
      priorCleanDeposits: 99,
    }),
  });
  assert.equal(outcome.verdict, "contain");
  assert.deepEqual(outcome.reasonCodes, ["checkout_email_changed"]);
});

test("a changed card contains below the trust threshold", () => {
  const outcome = evaluateFiatDepositIdentity({
    baseline: baseline(),
    observation: observation({
      cardLast4: "1881",
      priorCleanDeposits: CARD_CHANGE_TRUST_DEPOSITS - 1,
    }),
  });
  assert.equal(outcome.verdict, "contain");
  assert.deepEqual(outcome.reasonCodes, ["checkout_card_changed"]);
});

test("a changed card is accepted at or above the trust threshold", () => {
  const outcome = evaluateFiatDepositIdentity({
    baseline: baseline(),
    observation: observation({
      cardLast4: "1881",
      priorCleanDeposits: CARD_CHANGE_TRUST_DEPOSITS,
    }),
  });
  assert.equal(outcome.verdict, "watch");
  assert.deepEqual(outcome.watchCodes, ["checkout_card_changed_trusted"]);
});

test("the trust grace covers the card only, never the email", () => {
  const outcome = evaluateFiatDepositIdentity({
    baseline: baseline(),
    observation: observation({
      cardLast4: "1881",
      checkoutEmail: "someone.else@example.com",
      priorCleanDeposits: 50,
    }),
  });
  assert.equal(outcome.verdict, "contain");
  assert.deepEqual(outcome.reasonCodes, ["checkout_email_changed"]);
  assert.deepEqual(outcome.watchCodes, ["checkout_card_changed_trusted"]);
});

test("a same-number card on a different brand is a different card", () => {
  const outcome = evaluateFiatDepositIdentity({
    baseline: baseline({ cardBrand: "visa" }),
    observation: observation({ cardBrand: "mastercard", priorCleanDeposits: 0 }),
  });
  assert.equal(outcome.verdict, "contain");
  assert.deepEqual(outcome.reasonCodes, ["checkout_card_changed"]);
});

test("IP alone watches, device alone watches, both together contain", () => {
  const ipOnly = evaluateFiatDepositIdentity({
    baseline: baseline(),
    observation: observation({ checkoutIp: "198.51.100.7" }),
  });
  assert.equal(ipOnly.verdict, "watch");
  assert.deepEqual(ipOnly.watchCodes, ["checkout_ip_changed"]);

  const deviceOnly = evaluateFiatDepositIdentity({
    baseline: baseline(),
    observation: observation({ checkoutVisitorId: "visitor-b" }),
  });
  assert.equal(deviceOnly.verdict, "watch");
  assert.deepEqual(deviceOnly.watchCodes, ["checkout_device_changed"]);

  const both = evaluateFiatDepositIdentity({
    baseline: baseline(),
    observation: observation({
      checkoutIp: "198.51.100.7",
      checkoutVisitorId: "visitor-b",
    }),
  });
  assert.equal(both.verdict, "contain");
  assert.deepEqual(both.reasonCodes, ["checkout_ip_and_device_changed"]);
});

test("drift rules cannot fire on the account's first authorized deposit", () => {
  const outcome = evaluateFiatDepositIdentity({
    baseline: null,
    observation: observation({
      cardLast4: "9999",
      checkoutEmail: "brand.new@example.com",
      checkoutIp: "198.51.100.7",
      checkoutVisitorId: "visitor-z",
      priorCleanDeposits: 0,
    }),
  });
  assert.equal(outcome.verdict, "clear");
});

test("missing network evidence leaves the drift rules unrun and is surfaced", () => {
  const outcome = evaluateFiatDepositIdentity({
    baseline: baseline({ checkoutIp: null, checkoutVisitorId: null }),
    observation: observation({ checkoutIp: null, checkoutVisitorId: null }),
  });
  assert.equal(outcome.verdict, "watch");
  assert.deepEqual(outcome.watchCodes, [
    "checkout_identity_evidence_missing",
  ]);
});

test("a half-known comparison never invents drift", () => {
  const outcome = evaluateFiatDepositIdentity({
    baseline: baseline({ cardLast4: null, checkoutEmail: null }),
    observation: observation({ cardLast4: "1881", priorCleanDeposits: 0 }),
  });
  assert.equal(outcome.verdict, "clear");
});

test("emailDomain normalizes and rejects malformed addresses", () => {
  assert.equal(emailDomain("Payer@Example.COM"), "example.com");
  assert.equal(emailDomain("  payer@sub.example.com "), "sub.example.com");
  assert.equal(emailDomain("payer@"), null);
  assert.equal(emailDomain("@example.com"), null);
  assert.equal(emailDomain("not-an-email"), null);
  assert.equal(emailDomain(null), null);
});
