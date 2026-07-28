import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildFiatDiscordPayload,
  discordRetryAfterSeconds,
  fetchFailedPaymentWebhooks,
  fetchHighRiskFiatProblems,
  fiatProblemTitle,
  type FiatProblem,
} from "../src/fiat-alerts.js";

const failedIntent: FiatProblem = {
  source_kind: "deposit_intent",
  source_id: "intent-1:failed",
  problem_code: "failed",
  user_id: "user-1",
  username: "@everyone",
  details: {
    intent_id: "intent-1",
    status: "failed",
    credited_amount_cents: 12550,
    provider_payment_status: "failed",
    failure_reason: "@here <@123456789012345678>",
  },
  occurred_at: new Date("2026-07-28T12:00:00.000Z"),
};

test("fiat problem payload is safe, useful, and has no Discord mentions", () => {
  const payload = buildFiatDiscordPayload(
    "https://admin.packydash.com/fiat?tab=payments",
    failedIntent,
  );

  assert.equal(payload.username, "PackyGG Fiat");
  assert.equal(payload.content, "");
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
  assert.equal(payload.embeds[0]?.title, "Fiat deposit failed");
  assert.equal(payload.embeds[0]?.color, 0xef4444);
  assert.equal(
    payload.components[0]?.components[0]?.url,
    "https://admin.packydash.com/fiat?tab=payments",
  );
  assert.match(
    payload.embeds[0]?.fields.find((field) => field.name === "Account")
      ?.value ?? "",
    /everyone/,
  );
  assert.doesNotMatch(JSON.stringify(payload), /<@/);
  assert.match(JSON.stringify(payload), /\$125\.50/);
});

test("locked-account deposit alerts expose the active fiat lock", () => {
  const payload = buildFiatDiscordPayload(
    "https://admin.packydash.com/fiat?tab=payments",
    {
      ...failedIntent,
      source_id: "intent-2:fiat_locked_account",
      problem_code: "fiat_locked_account",
      details: {
        intent_id: "intent-2",
        status: "completed",
        credited_amount_cents: 50_000,
        locked_deposits_fiat: "credit_card",
        locked_deposits_reason: "High account risk",
      },
    },
  );

  assert.equal(
    payload.embeds[0]?.title,
    "High-risk fiat deposit from locked account",
  );
  assert.match(payload.embeds[0]?.description ?? "", /fiat deposits locked/);
  assert.equal(
    payload.embeds[0]?.fields.find(
      (field) => field.name === "Fiat deposit lock",
    )?.value,
    "credit_card",
  );
  assert.match(JSON.stringify(payload), /High account risk/);
});

test("canonical bad fiat assessments use the same dedicated webhook payload", () => {
  const payload = buildFiatDiscordPayload(
    "https://admin.packydash.com/fiat?tab=payments",
    {
      ...failedIntent,
      source_id: "intent-3:high_risk",
      problem_code: "high_risk",
      details: {
        intent_id: "intent-3",
        status: "completed",
        credited_amount_cents: 75_000,
        risk_score: 85,
        verdict: "bad",
        summary: "Shared device and provider dispute evidence.",
      },
    },
  );

  assert.equal(payload.embeds[0]?.title, "High-risk fiat deposit");
  assert.match(payload.embeds[0]?.description ?? "", /high-risk verdict/);
  assert.equal(
    payload.embeds[0]?.fields.find((field) => field.name === "Risk score")
      ?.value,
    "85/100",
  );
  assert.match(JSON.stringify(payload), /provider dispute evidence/);
});

test("every monitored problem has explicit operator-facing copy", () => {
  assert.equal(fiatProblemTitle("high_risk"), "High-risk fiat deposit");
  assert.equal(
    fiatProblemTitle("fiat_locked_account"),
    "High-risk fiat deposit from locked account",
  );
  assert.equal(fiatProblemTitle("review"), "Fiat deposit needs review");
  assert.equal(
    fiatProblemTitle("checkout_creating_stale"),
    "Fiat checkout creation stalled",
  );
  assert.equal(
    fiatProblemTitle("webhook_failed"),
    "Fiat webhook processing failed",
  );
  assert.equal(
    fiatProblemTitle("blacklisted_email_domain"),
    "Blacklisted email domain blocked",
  );
});

test("signup blacklist alerts identify the signup email", () => {
  const payload = buildFiatDiscordPayload(
    "https://fraud.packydash.com/antifraud/fiat-deposits",
    {
      source_kind: "signup",
      source_id: "signup:user-1:blacklisted_email_domain:stolas.org",
      problem_code: "blacklisted_email_domain",
      user_id: "user-1",
      username: "test-user",
      details: {
        email: "person@stolas.org",
        email_domain: "stolas.org",
        match_source: "signup",
        risk_score: 100,
        status: "withdrawals_locked",
      },
      occurred_at: new Date("2026-07-28T12:00:00.000Z"),
    },
  );

  assert.match(payload.embeds[0]?.description ?? "", /new signup/);
  assert.equal(
    payload.embeds[0]?.fields.find((field) => field.name === "Signup email")
      ?.value,
    "person@stolas.org",
  );
  assert.doesNotMatch(JSON.stringify(payload), /Whop checkout email/);
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
});

test("fiat Discord delivery honors bounded retry-after headers", () => {
  assert.equal(
    discordRetryAfterSeconds(new Headers({ "retry-after": "2.4" })),
    3,
  );
  assert.equal(
    discordRetryAfterSeconds(
      new Headers({ "x-ratelimit-reset-after": "999" }),
    ),
    300,
  );
  assert.equal(discordRetryAfterSeconds(new Headers()), null);
});

test("fiat alert ingestion is mirror-only, durable, and retryable", async () => {
  const source = await readFile(
    new URL("../src/fiat-alerts.ts", import.meta.url),
    "utf8",
  );
  const migration = await readFile(
    new URL("../migrations/017_fiat_problem_alerts.sql", import.meta.url),
    "utf8",
  );

  assert.match(source, /FROM fiat_deposit_intents fdi/);
  assert.match(source, /JOIN user_feature_locks ufl ON ufl\.user_id = fdi\.user_id/);
  assert.match(source, /cardinality\(ufl\.locked_deposits_fiat\) > 0/);
  assert.match(source, /ufl\.locked_deposits_at <= fdi\.created_at/);
  assert.match(source, /fiat_locked_account/);
  assert.match(source, /FROM fiat_deposit_assessments fda/);
  assert.match(source, /fda\.verdict = 'bad'/);
  assert.match(source, /HIGH_RISK_CURSOR_STREAM/);
  assert.match(source, /FROM payment_webhook_events pwe/);
  assert.match(source, /received_at >= .*interval '30 days'/s);
  assert.match(source, /checkout_creating_stale/);
  assert.match(source, /pending_stale/);
  assert.match(source, /INSERT INTO fiat_problem_alert_outbox/);
  assert.match(source, /ON CONFLICT \(source_kind, source_id\) DO NOTHING/);
  assert.match(source, /discord_delivered_at IS NULL/);
  assert.match(source, /next_attempt_at/);
  assert.match(source, /LIMIT 1/);
  assert.match(source, /discordRetryAfterSeconds/);
  assert.match(migration, /PRIMARY KEY \(source_kind, source_id\)/);
  assert.match(migration, /WHERE discord_delivered_at IS NULL/);

  const calls: Array<{ text: string; values: unknown[] }> = [];
  const pool = {
    query: async (text: string, values: unknown[]) => {
      calls.push({ text, values });
      return { rows: [] };
    },
  };
  await fetchFailedPaymentWebhooks(
    pool as never,
    250,
  );
  assert.equal(calls[0]?.values[0], 250);
  assert.match(calls[0]?.text ?? "", /processing_status = 'failed'/);

  const riskCalls: Array<{ text: string; values: unknown[] }> = [];
  const riskPool = {
    query: async (text: string, values: unknown[]) => {
      riskCalls.push({ text, values });
      return { rows: [] };
    },
  };
  await fetchHighRiskFiatProblems(
    riskPool as never,
    {
      occurredAt: new Date("2026-07-28T12:00:00.000Z"),
      sourceId: "intent-2:high_risk",
    },
    50,
  );
  assert.equal(riskCalls[0]?.values[2], 50);
  assert.match(riskCalls[0]?.text ?? "", /verdict = 'bad'/);
});
