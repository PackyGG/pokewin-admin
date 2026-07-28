import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type pg from "pg";

import {
  domainFromEmail,
  FiatEmailDomainGuard,
  fetchCheckoutEmailEvents,
  fetchSuspiciousDepositClusterCandidates,
  fetchSuspiciousGmailEvents,
  normalizeEmailDomain,
  qualifyingDepositClusterMembers,
  suspiciousGmailClusterCandidate,
  suspiciousGmailDotPattern,
  type DepositClusterCandidate,
  type DepositClusterMember,
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
  assert.match(calls[0]?.sql ?? "", /\(pwe\.received_at, pwe\.id::text\) >/);
  assert.match(calls[0]?.sql ?? "", /LIMIT \$3/);
  assert.deepEqual(calls[0]?.values, [occurredAt, "cluster-row-1", 75]);
});

test("Gmail pattern backfill is bounded to dot-heavy Whop checkout candidates", async () => {
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
  assert.match(calls[0]?.sql ?? "", /\(pwe\.received_at, pwe\.id::text\) >/);
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
  assert.match(calls[0]?.sql ?? "", /\(pwe\.received_at, pwe\.id::text\) >/);
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

  assert.match(source, /INSERT INTO fiat_email_domain_matches/);
  assert.match(source, /INSERT INTO fiat_problem_alert_outbox/);
  assert.match(source, /'payment_method_type'/);
  assert.match(source, /'infinity'::timestamptz/);
  assert.match(source, /if \(delivered\)[\s\S]*UPDATE fiat_problem_alert_outbox/);
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

  assert.equal(result.riskScore, 100);
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
    /same amount, short window, distinct accounts/,
  );
});
