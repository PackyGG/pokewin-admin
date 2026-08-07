import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type pg from "pg";

import {
  domainFromEmail,
  FiatEmailDomainGuard,
  fetchCheckoutEmailEvents,
  fetchRefundedAmountClusterCandidates,
  fetchSuspiciousDepositClusterCandidates,
  fetchSuspiciousGmailEvents,
  normalizeEmailDomain,
  qualifyingDepositClusterMembers,
  qualifyingRefundedAmountCluster,
  suspiciousGmailClusterCandidate,
  suspiciousGmailDotPattern,
  type DepositClusterCandidate,
  type DepositClusterMember,
  type RefundedAmountClusterCandidate,
  type RefundedAmountClusterMember,
} from "../src/fiat-email-domains.js";
import {
  applyBlacklistedCheckoutEmail,
  scoreFiatDeposit,
} from "../src/fiat-risk.js";
import type { Signup } from "../src/types.js";

test("email-domain matching is exact and normalized", () => {
  assert.equal(normalizeEmailDomain("@Stolas.ORG"), "stolas.org");
  assert.equal(domainFromEmail(" Person@Stolas.ORG "), "stolas.org");
  assert.equal(domainFromEmail("person@sub.stolas.org"), "sub.stolas.org");
  assert.equal(normalizeEmailDomain("https://stolas.org"), null);
  assert.equal(normalizeEmailDomain("stolas"), null);
});

test("dot-fragmented Gmail aliases are blocked without flagging normal Gmail addresses", () => {
  const suspicious = [
    "margenebrombergguidet.t.if.i.v.z.c@gmail.com",
    "giecphangqua.nh.ghun.g@gmail.com",
    "carmenw.oods29.7.1@gmail.com",
    "CarmenW.oods29.7.1+checkout@GoogleMail.com",
    "catherinebish.op47.972@gmail.com",
    "CatherineBish.OP47.972+checkout@GoogleMail.com",
    "phuongquiechr.ac.hr.uang@gmail.com",
  ];
  for (const email of suspicious) {
    assert.equal(
      suspiciousGmailDotPattern(email)?.type,
      "gmail_dot_fragmentation",
      email,
    );
  }

  const allowed = [
    "first.last@gmail.com",
    "first.middle.last@gmail.com",
    "john.r.smith@gmail.com",
    "a.b.c.d@gmail.com",
    "carmenw.oods29.7.1@outlook.com",
    "plainaddress@gmail.com",
    "catherinebish.op.972@gmail.com",
    "catherinebish.op47.work@gmail.com",
    "catherinebish.op4.972@gmail.com",
    "john.smith.1972@gmail.com",
  ];
  for (const email of allowed) {
    assert.equal(suspiciousGmailDotPattern(email), null, email);
  }
});

function clusterMember(
  index: number,
  email: string,
  overrides: Partial<DepositClusterMember> = {},
): DepositClusterMember {
  return {
    source_event_id: `event-${index}`,
    provider_event_id: `provider-event-${index}`,
    deposit_intent_id: `423e4567-e89b-42d3-a456-42661417400${index}`,
    provider_payment_id: `payment-${index}`,
    user_id: `user-${index}`,
    username: `user${index}`,
    checkout_email: email,
    payment_method_type: "card",
    account_identity: `whop-user-${index}`,
    currency: "EUR",
    payment_identity: `payment-${index}`,
    requested_amount_cents: 1847,
    occurred_at: new Date(
      `2026-07-28T12:${String(index * 5).padStart(2, "0")}:00.000Z`,
    ),
    ...overrides,
  };
}

function clusterCandidate(
  members: DepositClusterMember[],
): DepositClusterCandidate {
  const anchor = members.at(-1);
  assert.ok(anchor);
  return { ...anchor, cluster_members: members };
}

test("same-amount suspicious deposits form a cluster only with distinct identities", () => {
  const supplied = [
    clusterMember(1, "margenebrombergguidet.t.if.i.v.z.c@gmail.com"),
    clusterMember(2, "giecphangqua.nh.ghun.g@gmail.com"),
    clusterMember(3, "carmenw.oods29.7.1@gmail.com", {
      user_id: "user-2",
    }),
  ];
  assert.equal(
    suspiciousGmailClusterCandidate(supplied[0]?.checkout_email ?? "")?.type,
    "suspicious_deposit_cluster",
  );
  assert.deepEqual(
    qualifyingDepositClusterMembers(clusterCandidate(supplied)),
    supplied,
  );

  const ordinaryPromotion = [
    clusterMember(1, "alice.smith@gmail.com"),
    clusterMember(2, "bob.jones@gmail.com"),
    clusterMember(3, "charlie.brown@gmail.com"),
  ];
  assert.equal(
    qualifyingDepositClusterMembers(clusterCandidate(ordinaryPromotion)),
    null,
  );

  const repeatedAccount = supplied.map((member, index) => ({
    ...member,
    source_event_id: `repeat-${index}`,
    provider_payment_id: `repeat-payment-${index}`,
    user_id: "same-user",
    account_identity: "same-whop-user",
  }));
  assert.equal(
    qualifyingDepositClusterMembers(clusterCandidate(repeatedAccount)),
    null,
  );

  const repeatedPaymentIdentity = supplied.map((member) => ({
    ...member,
    payment_identity: "same-provider-payment",
  }));
  assert.equal(
    qualifyingDepositClusterMembers(
      clusterCandidate(repeatedPaymentIdentity),
    ),
    null,
  );
});

test("review-only Gmail matches promote into a fresh containment delivery", async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  let storedMatchType: string | null = null;
  const client = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      if (/INSERT INTO fiat_email_domain_matches/.test(sql)) {
        const requestedType = String(values?.[9]);
        if (storedMatchType === null) {
          storedMatchType = requestedType;
          return { rows: [{ id: "match-1" }] };
        }
        if (
          storedMatchType === "gmail_dot_fragmentation"
          && requestedType === "suspicious_deposit_cluster"
          && /ON CONFLICT[\s\S]*DO UPDATE/.test(sql)
        ) {
          storedMatchType = requestedType;
          return { rows: [{ id: "match-1" }] };
        }
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
  const guard = new FiatEmailDomainGuard(
    { antifraud: {} } as never,
    { warn() {} } as never,
  );
  const persistMatch = (
    guard as unknown as {
      persistMatch(
        client: pg.PoolClient,
        event: Record<string, unknown>,
        risk: Record<string, unknown>,
      ): Promise<boolean>;
    }
  ).persistMatch.bind(guard);
  const event = {
    ...clusterMember(1, "margenebrombergguidet.t.if.i.v.z.c@gmail.com"),
    match_source: "whop_checkout",
  };

  assert.equal(
    await persistMatch(client as never, event, {
      type: "gmail_dot_fragmentation",
      domain: "gmail.com",
      reason: "fragmented alias",
    }),
    true,
  );
  assert.equal(
    await persistMatch(client as never, event, {
      type: "suspicious_deposit_cluster",
      domain: "gmail.com",
      reason: "corroborated cluster",
    }),
    true,
  );

  assert.equal(storedMatchType, "suspicious_deposit_cluster");
  const matchWrites = calls.filter(({ sql }) =>
    /INSERT INTO fiat_email_domain_matches/.test(sql)
  );
  assert.equal(matchWrites.length, 2);
  assert.match(matchWrites[1]?.sql ?? "", /lock_delivered_at = NULL/);
  assert.match(matchWrites[1]?.sql ?? "", /attempt_count = 0/);

  const riskWrites = calls.filter(({ sql }) => /INSERT INTO risk_events/.test(sql));
  assert.equal(riskWrites.length, 2);
  assert.equal(riskWrites[0]?.values?.[2], "whop_checkout");
  assert.equal(riskWrites[0]?.values?.[15], true);
  assert.equal(riskWrites[1]?.values?.[2], "whop_checkout_cluster");
  assert.equal(riskWrites[1]?.values?.[15], false);

  const repairMigration = await readFile(
    new URL(
      "../migrations/071_cluster_containment_hardening.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(repairMigration, /INSERT INTO risk_events/);
  assert.match(repairMigration, /'whop_checkout_cluster'/);
  assert.match(
    repairMigration,
    /UPDATE fiat_email_domain_matches[\s\S]*lock_delivered_at = NULL/,
  );
});

test("deposit-cluster polling is bounded and conjunctive", async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const source = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      return { rows: [] };
    },
  } as unknown as pg.Pool;
  const occurredAt = new Date("2026-07-21T12:00:00.000Z");

  await fetchSuspiciousDepositClusterCandidates(
    source,
    { occurredAt, sourceId: "cluster-row-1" },
    75,
  );

  assert.equal(calls.length, 1);
  assert.match(calls[0]?.sql ?? "", /requested_amount_cents/);
  assert.match(calls[0]?.sql ?? "", /interval '30 minutes'/);
  assert.match(calls[0]?.sql ?? "", /provider_payment_id/);
  assert.match(calls[0]?.sql ?? "", /payment_identity/);
  assert.match(calls[0]?.sql ?? "", /data,user,id/);
  assert.doesNotMatch(calls[0]?.sql ?? "", /card_last4 ~/);
  assert.match(calls[0]?.sql ?? "", /fdi\.user_id/);
  assert.match(calls[0]?.sql ?? "", /gmail\.com/);
  assert.match(calls[0]?.sql ?? "", /\(\(pwe\.received_at AT TIME ZONE 'UTC'\), pwe\.id::text\)\s*>/);
  assert.match(calls[0]?.sql ?? "", /LIMIT \$3/);
  assert.deepEqual(calls[0]?.values, [occurredAt, "cluster-row-1", 75]);
});

function refundedMember(index: number): RefundedAmountClusterMember {
  return {
    ...clusterMember(index, `payer${index}@example.com`, {
      requested_amount_cents: 2000,
      currency: "USD",
      account_identity: `user-${(index % 3) + 1}`,
    }),
    status: "refunded",
    updated_at: new Date(`2026-08-05T12:0${index}:00.000Z`),
  };
}

function refundedCandidate(
  totalPaymentCount: number,
): RefundedAmountClusterCandidate {
  const members = [1, 2, 3, 4, 5].map(refundedMember);
  return {
    ...members[4]!,
    total_payment_count: totalPaymentCount,
    refunded_members: members,
  };
}

test("refunded amount clusters require volume, distinct accounts, and refund concentration", () => {
  const campaign = qualifyingRefundedAmountCluster(refundedCandidate(6));
  assert.ok(campaign);
  assert.equal(campaign.members.length, 5);
  assert.equal(campaign.accountCount, 3);
  assert.equal(campaign.paymentCount, 5);
  assert.equal(Number(campaign.refundRatio.toFixed(3)), 0.833);

  assert.equal(qualifyingRefundedAmountCluster(refundedCandidate(20)), null);
  assert.equal(qualifyingRefundedAmountCluster({
    ...refundedCandidate(6),
    refunded_members: refundedCandidate(6).refunded_members.map((member) => ({
      ...member,
      account_identity: "same-user",
    })),
  }), null);
});

test("refunded amount polling follows refund updates and measures all settled payments", async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const source = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      return { rows: [] };
    },
  } as unknown as pg.Pool;
  const occurredAt = new Date("2026-07-01T00:00:00.000Z");
  await fetchRefundedAmountClusterCandidates(
    source,
    { occurredAt, sourceId: "intent-1" },
    50,
  );
  assert.match(calls[0]?.sql ?? "", /fdi\.status::text IN \('refunded', 'partially_refunded'\)/);
  assert.match(calls[0]?.sql ?? "", /\(\(fdi\.updated_at AT TIME ZONE 'UTC'\), fdi\.id::text\)\s*>/);
  assert.match(calls[0]?.sql ?? "", /COUNT\(\*\)::int AS total_payment_count/);
  assert.match(calls[0]?.sql ?? "", /interval '3 days 12 hours'/);
  assert.deepEqual(calls[0]?.values, [occurredAt, "intent-1", 50]);
});

test("refunded amount cluster migration creates durable campaign state and backfill cursor", async () => {
  const migration = await readFile(
    new URL("../migrations/057_refunded_amount_clusters.sql", import.meta.url),
    "utf8",
  );

  assert.match(migration, /CREATE TABLE IF NOT EXISTS fiat_refunded_amount_clusters/);
  assert.match(migration, /UNIQUE \(currency, requested_amount_cents\)/);
  assert.match(migration, /active_until timestamptz NOT NULL/);
  assert.match(migration, /'fiat_refunded_amount_clusters_v1'/);
  assert.match(migration, /now\(\) - interval '30 days'/);
});

test("Gmail pattern backfill includes heavy fragments and coded numeric suffixes", async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const source = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      return { rows: [] };
    },
  } as unknown as pg.Pool;
  const occurredAt = new Date("2026-07-21T12:00:00.000Z");

  await fetchSuspiciousGmailEvents(
    source,
    { occurredAt, sourceId: "gmail-row-1" },
    50,
  );

  assert.equal(calls.length, 1);
  assert.match(calls[0]?.sql ?? "", /IN \('gmail\.com', 'googlemail\.com'\)/);
  assert.match(calls[0]?.sql ?? "", /\) >= 3/);
  assert.match(
    calls[0]?.sql ?? "",
    /\^\[a-z\]\{10,\}.*\[a-z\]\{1,3\}.*\[0-9\]\{3,4\}/,
  );
  assert.match(
    calls[0]?.sql ?? "",
    /\^\[a-z\]\{10,\}\\\.\[a-z\].*\\\.\[0-9\].*\\\+/,
  );
  assert.match(calls[0]?.sql ?? "", /\(\(pwe\.received_at AT TIME ZONE 'UTC'\), pwe\.id::text\)\s*>/);
  assert.deepEqual(calls[0]?.values, [occurredAt, "gmail-row-1", 50]);
});

test("checkout email polling uses Whop payment.created metadata and a tuple cursor", async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const source = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      return { rows: [] };
    },
  } as unknown as pg.Pool;
  const occurredAt = new Date("2026-07-28T12:00:00.000Z");

  await fetchCheckoutEmailEvents(
    source,
    { occurredAt, sourceId: "event-row-1" },
    25,
    "stolas.org",
  );

  assert.equal(calls.length, 1);
  assert.match(calls[0]?.sql ?? "", /event_type = 'payment\.created'/);
  assert.match(calls[0]?.sql ?? "", /data,user,email/);
  assert.match(calls[0]?.sql ?? "", /data,metadata,internal_user_id/);
  assert.match(calls[0]?.sql ?? "", /data,metadata,deposit_intent_id/);
  assert.match(calls[0]?.sql ?? "", /payment_method_type/);
  assert.match(calls[0]?.sql ?? "", /\(\(pwe\.received_at AT TIME ZONE 'UTC'\), pwe\.id::text\)\s*>/);
  assert.deepEqual(calls[0]?.values, [
    occurredAt,
    "event-row-1",
    25,
    "stolas.org",
  ]);
});

test("blacklist matches are durable before signed lock delivery", async () => {
  const source = await readFile(
    new URL("../src/fiat-email-domains.ts", import.meta.url),
    "utf8",
  );
  const migration = await readFile(
    new URL("../migrations/018_fiat_email_domain_blacklist.sql", import.meta.url),
    "utf8",
  );
  const patternMigration = await readFile(
    new URL("../migrations/020_gmail_dot_fragmentation.sql", import.meta.url),
    "utf8",
  );
  const clusterMigration = await readFile(
    new URL("../migrations/022_suspicious_deposit_clusters.sql", import.meta.url),
    "utf8",
  );
  const clusterReplayMigration = await readFile(
    new URL(
      "../migrations/023_replay_suspicious_deposit_clusters.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const clusterReplayV2Migration = await readFile(
    new URL(
      "../migrations/024_replay_suspicious_deposit_clusters_v2.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const codedSuffixReplayMigration = await readFile(
    new URL(
      "../migrations/026_replay_coded_gmail_suffixes.sql",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(source, /INSERT INTO fiat_email_domain_matches/);
  assert.match(source, /INSERT INTO fiat_problem_alert_outbox/);
  assert.match(source, /'payment_method_type'/);
  assert.match(source, /'infinity'::timestamptz/);
  assert.match(
    source,
    /if \(outcome\.delivered\)[\s\S]*UPDATE fiat_problem_alert_outbox/,
  );
  assert.match(source, /fiat_blacklisted_email_domain/);
  assert.match(source, /gmail_dot_fragmentation/);
  assert.match(source, /now\(\) - interval '7 days'/);
  assert.match(source, /score_after,[\s\S]*100/);
  assert.match(source, /lock_delivered_at IS NULL/);
  assert.match(source, /next_attempt_at/);
  assert.match(migration, /fiat_email_domain_blacklist_audit/);
  assert.match(migration, /idempotency_key uuid NOT NULL UNIQUE/);
  assert.match(migration, /WHERE lock_delivered_at IS NULL/);
  assert.match(patternMigration, /ADD COLUMN IF NOT EXISTS match_type/);
  assert.match(clusterMigration, /suspicious_deposit_cluster/);
  assert.match(
    clusterReplayMigration,
    /interval '7 days'[\s\S]*fiat_suspicious_deposit_clusters[\s\S]*NOT EXISTS[\s\S]*suspicious_deposit_cluster/,
  );
  assert.match(
    clusterReplayV2Migration,
    /fiat_suspicious_deposit_clusters_v2[\s\S]*interval '7 days'[\s\S]*NOT EXISTS[\s\S]*suspicious_deposit_cluster/,
  );
  assert.match(
    codedSuffixReplayMigration,
    /interval '7 days'[\s\S]*fiat_gmail_dot_patterns/,
  );
  assert.match(source, /fiat_suspicious_deposit_clusters_v2/);
  assert.match(source, /cluster_source_event_ids/);
  assert.match(
    source,
    /problem_code = 'suspicious_deposit_cluster'[\s\S]*interval '30 minutes'/,
  );
  assert.match(
    source,
    /jsonb_array_elements_text[\s\S]*cluster_source_event_ids[\s\S]*ANY\(\$1::text\[\]\)/,
  );
  assert.doesNotMatch(
    source,
    /problem_code = 'suspicious_deposit_cluster'[\s\S]{0,300}details ->> 'amount_cents'/,
  );
  assert.match(
    source,
    /DELETE FROM fiat_problem_alert_outbox[\s\S]*gmail_dot_fragmentation/,
  );
  assert.match(source, /if \(existingAlert\.rows\.length > 0\) continue/);
  assert.match(
    source,
    /NOT EXISTS[\s\S]*lock_delivered_at IS NULL/,
  );
});

test("a matching signup is durably queued for signed lock and fiat notification", async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const client = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      if (/SELECT EXISTS/.test(sql)) return { rows: [{ active: true }] };
      if (/INSERT INTO fiat_email_domain_matches/.test(sql)) {
        return { rows: [{ id: "match-1" }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const guard = new FiatEmailDomainGuard(
    {
      antifraud: {
        connect: async () => client,
      },
    } as never,
    { warn() {} } as never,
  );
  const signup = {
    id: "user-1",
    username: "new-user",
    email: " Person@Stolas.ORG ",
    created_at: new Date("2026-07-28T12:00:00.000Z"),
  } as Signup;

  assert.equal(await guard.captureSignup(signup), true);
  const match = calls.find(({ sql }) =>
    /INSERT INTO fiat_email_domain_matches/.test(sql),
  );
  assert.equal(match?.values?.[0], "signup:user-1");
  assert.equal(match?.values?.[1], "signup");
  assert.equal(match?.values?.[7], "person@stolas.org");
  assert.equal(match?.values?.[9], "blacklisted_domain");

  const risk = calls.find(({ sql }) => /INSERT INTO risk_events/.test(sql));
  assert.equal(risk?.values?.[1], "fiat_blacklisted_email_domain");
  assert.equal(risk?.values?.[2], "signup");
  assert.equal(risk?.values?.[7], "signup");

  const alert = calls.find(({ sql }) =>
    /INSERT INTO fiat_problem_alert_outbox/.test(sql),
  );
  assert.equal(alert?.values?.[0], "signup");
  assert.match(alert?.sql ?? "", /'infinity'::timestamptz/);
  assert.match(
    alert?.sql ?? "",
    /'email', \$8::text[\s\S]*'email_domain', \$10::text/,
  );
  assert.equal(calls.at(-1)?.sql, "COMMIT");
});

test("blacklist mutations bind idempotency to actor and exact state", async () => {
  const routes = await readFile(
    new URL("../src/fiat-email-domain-routes.ts", import.meta.url),
    "utf8",
  );

  assert.match(routes, /priorAudit\.actor_id !== parsed\.data\.actorId/);
  assert.match(routes, /priorAudit\.after_state\.domain !== domain/);
  assert.match(routes, /priorAudit\.rule_id !== params\.data\.id/);
  assert.match(routes, /priorAudit\.after_state\.enabled !== parsed\.data\.enabled/);
  assert.match(routes, /idempotency_conflict/);
});

test("catch history is server-paginated and exposes only linkable detector facts", async () => {
  const routes = await readFile(
    new URL("../src/fiat-email-domain-routes.ts", import.meta.url),
    "utf8",
  );

  assert.match(routes, /app\.get\("\/v1\/fiat-email-catches"/);
  assert.match(routes, /page: z\.coerce\.number/);
  assert.match(routes, /limit: z\.coerce\.number/);
  assert.match(routes, /riskType:/);
  assert.match(routes, /lockStatus:/);
  assert.match(routes, /search:/);
  assert.match(routes, /ORDER BY occurred_at DESC, id DESC/);
  assert.match(routes, /depositIntentId: row\.deposit_intent_id/);
  assert.match(routes, /userId: row\.user_id/);
  assert.doesNotMatch(routes, /payload: row\./);
});

test("per-user catch rollup groups every signal behind one paginated row", async () => {
  const routes = await readFile(
    new URL("../src/fiat-email-domain-routes.ts", import.meta.url),
    "utf8",
  );

  assert.match(routes, /app\.get\("\/v1\/fiat-email-catch-users"/);
  assert.match(routes, /GROUP BY user_id/);
  assert.match(routes, /bool_or\(lock_delivered_at IS NOT NULL\)/);
  assert.match(routes, /count\(DISTINCT deposit_intent_id\)::int/);
  assert.match(routes, /array_agg\(DISTINCT match_type\)/);
  assert.match(routes, /max\(occurred_at\) AS last_occurred_at/);
  assert.match(routes, /catchCount: row\.catch_count/);
  assert.match(routes, /lastOccurredAt: row\.last_occurred_at\.toISOString\(\)/);
});

function baseFiatScore(): ReturnType<typeof scoreFiatDeposit> {
  return {
    riskScore: 10,
    verdict: "good",
    recommendation: "No fraud hold recommended.",
    summary: "Low risk.",
    signals: [],
    scoreBreakdown: {
      provider: 0,
      funding: 0,
      velocity: 0,
      account: 4,
      behavior: 6,
      network: 0,
    },
    flowChecks: [
      {
        key: "provider",
        label: "Provider",
        description: "Provider evidence",
        status: "pass",
        score: 0,
        evidence: ["3DS verified"],
      },
    ],
  };
}

test("a blacklisted checkout email forces the maximum fiat risk result", () => {
  const base = baseFiatScore();
  const result = applyBlacklistedCheckoutEmail(base, {
    deposit_intent_id: "intent-1",
    checkout_email: "person@stolas.org",
    domain: "stolas.org",
    match_type: "blacklisted_domain",
    lock_delivered_at: new Date("2026-07-28T12:00:00.000Z"),
  });

  assert.equal(result.riskScore, 100);
  assert.equal(result.verdict, "bad");
  assert.equal(result.scoreBreakdown.provider, 100);
  assert.match(result.signals[0]?.detail ?? "", /person@stolas\.org/);
  assert.equal(result.flowChecks[0]?.status, "block");
  assert.match(
    result.flowChecks[0]?.evidence.join(" ") ?? "",
    /withdrawal lock confirmed/,
  );
});

test("a dot-fragmented Gmail match uses explicit pattern evidence", () => {
  const base = baseFiatScore();
  const result = applyBlacklistedCheckoutEmail(base, {
    deposit_intent_id: "intent-2",
    checkout_email: "carmenw.oods29.7.1@gmail.com",
    domain: "gmail.com",
    match_type: "gmail_dot_fragmentation",
    lock_delivered_at: null,
  });

  assert.equal(result.riskScore, 50);
  assert.equal(result.verdict, "review");
  assert.equal(result.flowChecks[0]?.status, "review");
  assert.equal(result.signals[0]?.key, "suspicious_checkout_email_pattern");
  assert.match(result.summary, /dot-fragmentation/);
  assert.doesNotMatch(result.summary, /blocked domain/);
});

test("a clustered checkout uses explicit cluster evidence", () => {
  const result = applyBlacklistedCheckoutEmail(baseFiatScore(), {
    deposit_intent_id: "intent-3",
    checkout_email: "longname.x.y.fragment@gmail.com",
    domain: "gmail.com",
    match_type: "suspicious_deposit_cluster",
    lock_delivered_at: new Date("2026-07-28T12:30:00.000Z"),
  });

  assert.equal(result.riskScore, 100);
  assert.equal(result.signals[0]?.key, "suspicious_deposit_cluster");
  assert.match(result.summary, /coordinated deposit cluster/);
  assert.match(
    result.flowChecks[0]?.evidence.join(" ") ?? "",
    /same amount, distinct accounts and payment identities/,
  );
});

test("email-domain cursors never jump past rows that arrive stamped in the past", async () => {
  const source = await readFile(
    new URL("../src/fiat-email-domains.ts", import.meta.url),
    "utf8",
  );
  // payment_webhook_events.received_at is producer-set and read through the
  // replication mirror, so a row can become visible already timestamped in the
  // past. An empty poll that parks the cursor on now() leaves it behind the
  // cursor forever, and these two streams are the containment path.
  assert.equal(
    source.match(/GREATEST\(occurred_at, now\(\) - interval '5 seconds'\)/g)
      ?.length,
    3,
  );
  assert.doesNotMatch(source, /GREATEST\(occurred_at, now\(\)\)/);
});

test("a cluster alert cannot be muted forever by one unlockable member", async () => {
  const source = await readFile(
    new URL("../src/fiat-email-domains.ts", import.meta.url),
    "utf8",
  );
  // The all-confirmed release stays the fast path; the age escape stops one
  // member whose lock never lands from holding the campaign alert at infinity.
  assert.match(
    source,
    /NOT EXISTS \([\s\S]*lock_delivered_at IS NULL[\s\S]*\)[\s\S]*OR alert\.occurred_at < now\(\) - interval '30 minutes'/,
  );
  assert.match(source, /LOCK_CONFIRMATION_ALARM_ATTEMPTS = 10/);
  assert.match(
    source,
    /outcome\.attempt > LOCK_CONFIRMATION_ALARM_ATTEMPTS[\s\S]*this\.log\.error/,
  );
});
