import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type pg from "pg";

import {
  domainFromEmail,
  fetchCheckoutEmailEvents,
  normalizeEmailDomain,
} from "../src/fiat-email-domains.js";
import {
  applyBlacklistedCheckoutEmail,
  scoreFiatDeposit,
} from "../src/fiat-risk.js";

test("email-domain matching is exact and normalized", () => {
  assert.equal(normalizeEmailDomain("@Stolas.ORG"), "stolas.org");
  assert.equal(domainFromEmail(" Person@Stolas.ORG "), "stolas.org");
  assert.equal(domainFromEmail("person@sub.stolas.org"), "sub.stolas.org");
  assert.equal(normalizeEmailDomain("https://stolas.org"), null);
  assert.equal(normalizeEmailDomain("stolas"), null);
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

  assert.match(source, /INSERT INTO fiat_email_domain_matches/);
  assert.match(source, /INSERT INTO fiat_problem_alert_outbox/);
  assert.match(source, /'infinity'::timestamptz/);
  assert.match(source, /if \(delivered\)[\s\S]*UPDATE fiat_problem_alert_outbox/);
  assert.match(source, /fiat_blacklisted_email_domain/);
  assert.match(source, /score_after,[\s\S]*100/);
  assert.match(source, /lock_delivered_at IS NULL/);
  assert.match(source, /next_attempt_at/);
  assert.match(migration, /fiat_email_domain_blacklist_audit/);
  assert.match(migration, /idempotency_key uuid NOT NULL UNIQUE/);
  assert.match(migration, /WHERE lock_delivered_at IS NULL/);
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

test("a blacklisted checkout email forces the maximum fiat risk result", () => {
  const base: ReturnType<typeof scoreFiatDeposit> = {
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

  const result = applyBlacklistedCheckoutEmail(base, {
    deposit_intent_id: "intent-1",
    checkout_email: "person@stolas.org",
    domain: "stolas.org",
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
