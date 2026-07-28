import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type pg from "pg";

import {
  domainFromEmail,
  FiatEmailDomainGuard,
  fetchCheckoutEmailEvents,
  fetchSuspiciousGmailEvents,
  normalizeEmailDomain,
  suspiciousGmailDotPattern,
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
