import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CARD_CHANGE_LOCK_WINDOW_MS,
  CARD_CHANGE_REVIEW_WINDOW_MS,
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
    occurredAt: new Date("2026-07-30T11:00:00.000Z"),
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
    refundedAmountClusterReason: null,
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

test("an active refunded-amount campaign contains withdrawals", () => {
  const outcome = evaluateFiatDepositIdentity({
    baseline: null,
    observation: observation({
      refundedAmountClusterReason:
        "5 of 6 settled payments were refunded across 5 accounts",
    }),
  });
  assert.equal(outcome.verdict, "contain");
  assert.deepEqual(outcome.reasonCodes, [
    "checkout_refunded_amount_cluster",
  ]);
  assert.deepEqual(outcome.reviewCodes, []);
  assert.equal(outcome.containmentAction, "withdrawals");
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

test("a catch-all payer email opens review without containment", () => {
  const outcome = evaluateFiatDepositIdentity({
    baseline: null,
    observation: observation({
      email: { catchall: true, deliverability: "deliverable" },
    }),
  });
  assert.equal(outcome.verdict, "review");
  assert.deepEqual(outcome.reasonCodes, []);
  assert.deepEqual(outcome.reviewCodes, ["checkout_email_catchall"]);
});

test("an undeliverable payer email opens review, an unknown one only watches", () => {
  const undeliverable = evaluateFiatDepositIdentity({
    baseline: null,
    observation: observation({
      email: { catchall: false, deliverability: "undeliverable" },
    }),
  });
  assert.equal(undeliverable.verdict, "review");
  assert.deepEqual(undeliverable.reviewCodes, [
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

test("a changed payer email opens review without containment", () => {
  const outcome = evaluateFiatDepositIdentity({
    baseline: baseline(),
    observation: observation({
      checkoutEmail: "someone.else@example.com",
      priorCleanDeposits: 99,
    }),
  });
  assert.equal(outcome.verdict, "review");
  assert.deepEqual(outcome.reasonCodes, []);
  assert.deepEqual(outcome.reviewCodes, ["checkout_email_changed"]);
});

test("a card changed within two hours locks withdrawals", () => {
  const outcome = evaluateFiatDepositIdentity({
    baseline: baseline(),
    observation: observation({
      cardLast4: "1881",
    }),
  });
  assert.equal(outcome.verdict, "contain");
  assert.equal(outcome.containmentAction, "withdrawals");
  assert.deepEqual(outcome.reasonCodes, ["checkout_card_changed_recent"]);
});

test("a card changed later the same day opens review without a lock", () => {
  const outcome = evaluateFiatDepositIdentity({
    baseline: baseline({
      occurredAt: new Date(
        OCCURRED_AT.getTime() - CARD_CHANGE_LOCK_WINDOW_MS - 1,
      ),
    }),
    observation: observation({
      cardLast4: "1881",
    }),
  });
  assert.equal(outcome.verdict, "review");
  assert.deepEqual(outcome.reviewCodes, ["checkout_card_changed_same_day"]);
});

test("a card changed after 24 hours is evidence only", () => {
  const outcome = evaluateFiatDepositIdentity({
    baseline: baseline({
      occurredAt: new Date(
        OCCURRED_AT.getTime() - CARD_CHANGE_REVIEW_WINDOW_MS - 1,
      ),
    }),
    observation: observation({
      cardLast4: "1881",
    }),
  });
  assert.equal(outcome.verdict, "watch");
  assert.deepEqual(outcome.watchCodes, ["checkout_card_changed_late"]);
});

test("a same-number card on a different brand is a different card", () => {
  const outcome = evaluateFiatDepositIdentity({
    baseline: baseline({ cardBrand: "visa" }),
    observation: observation({ cardBrand: "mastercard", priorCleanDeposits: 0 }),
  });
  assert.equal(outcome.verdict, "contain");
  assert.deepEqual(outcome.reasonCodes, ["checkout_card_changed_recent"]);
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

test("a missing card brand on either side is not a card change", () => {
  // Brand and last4 come from two independent recursive key searches over
  // possibly different webhook events, so one side can carry a last4 with no
  // brand. Reading that absence as a second card contained the account: KYC
  // plus deposit and withdrawal locks, on the same physical card.
  const baselineMissingBrand = evaluateFiatDepositIdentity({
    baseline: baseline({ cardBrand: null }),
    observation: observation({ cardBrand: "visa", priorCleanDeposits: 0 }),
  });
  assert.equal(baselineMissingBrand.verdict, "clear");
  assert.deepEqual(baselineMissingBrand.reasonCodes, []);

  const observationMissingBrand = evaluateFiatDepositIdentity({
    baseline: baseline({ cardBrand: "visa" }),
    observation: observation({ cardBrand: null, priorCleanDeposits: 0 }),
  });
  assert.equal(observationMissingBrand.verdict, "clear");
  assert.deepEqual(observationMissingBrand.reasonCodes, []);

  const bothMissing = evaluateFiatDepositIdentity({
    baseline: baseline({ cardBrand: null }),
    observation: observation({ cardBrand: null, priorCleanDeposits: 0 }),
  });
  assert.equal(bothMissing.verdict, "clear");

  // A genuinely different last4 still contains, brand or no brand.
  const differentNumber = evaluateFiatDepositIdentity({
    baseline: baseline({ cardBrand: null }),
    observation: observation({ cardLast4: "1881", priorCleanDeposits: 0 }),
  });
  assert.equal(differentNumber.verdict, "contain");
  assert.deepEqual(differentNumber.reasonCodes, ["checkout_card_changed_recent"]);
});

async function pollerSource(): Promise<string> {
  return await readFile(
    new URL("../src/fiat-deposit-identity.ts", import.meta.url),
    "utf8",
  );
}

test("the deposit cursor cannot re-read or skip on a sub-millisecond tail", async () => {
  const source = await pollerSource();
  // node-postgres hands Dates back at millisecond precision, so the cursor is
  // always ms-truncated. Truncating only the parameter side left the newest
  // deposit permanently greater than the cursor; truncating only the predicate
  // would skip peers sharing that millisecond. Predicate and ORDER BY use the
  // same truncated key.
  assert.match(
    source,
    /date_trunc\('milliseconds', fdi\.paid_at \$\{UTC\}\),\s+fdi\.id\s+\) > \(/,
  );
  assert.match(
    source,
    /ORDER BY date_trunc\('milliseconds', fdi\.paid_at \$\{UTC\}\), fdi\.id/,
  );
  // uuid compared as uuid, not text, so a plain index stays usable. The seed
  // cursor is an empty string, which is not a uuid.
  assert.doesNotMatch(source, /ORDER BY \(fdi\.paid_at \$\{UTC\}\), fdi\.id::text/);
  assert.match(source, /COALESCE\(NULLIF\(\$2, ''\)::uuid, \$\{NIL_UUID\}\)/);
});

test("a failed identity evaluation leaves a durable record, not just a log line", async () => {
  const source = await pollerSource();
  // The cursor advances past a throwing deposit either way, so without an
  // outbox row the deposit is silently never contained and nothing says so.
  assert.match(
    source,
    /catch \(error\) \{[\s\S]*this\.log\.error\([\s\S]*queueEvaluationFailure\(intent, error\)/,
  );
  assert.match(source, /:fiat_identity_error/);
  assert.match(
    source,
    /queueEvaluationFailure[\s\S]*INSERT INTO fiat_problem_alert_outbox/,
  );
  assert.match(
    source,
    /DELETE FROM fiat_problem_alert_outbox[\s\S]*:fiat_identity_error/,
  );
});

test("the identity schema accepts review verdicts and replays constraint failures", async () => {
  const migration = await readFile(
    new URL(
      "../migrations/071_cluster_containment_hardening.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    migration,
    /verdict IN \('clear', 'watch', 'review', 'contain'\)/,
  );
  assert.match(migration, /fiat_deposit_identity_checks_verdict_check/);
  assert.match(migration, /fiat_identity_checkout_ip_occurred_idx/);
  assert.match(migration, /fiat_identity_checkout_device_occurred_idx/);
  assert.match(
    migration,
    /UPDATE source_cursors[\s\S]*fiat-deposit-identity/,
  );
});

test("card brand and last4 are only paired from one event", async () => {
  const source = await pollerSource();
  assert.match(
    source,
    /pairedCard =\s+\(primary\.cardBrand && primary\.cardLast4 \? primary : undefined\)/,
  );
});
