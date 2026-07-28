import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildFiatDiscordPayload,
  fetchFailedPaymentWebhooks,
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

test("every monitored problem has explicit operator-facing copy", () => {
  assert.equal(fiatProblemTitle("review"), "Fiat deposit needs review");
  assert.equal(
    fiatProblemTitle("checkout_creating_stale"),
    "Fiat checkout creation stalled",
  );
  assert.equal(
    fiatProblemTitle("webhook_failed"),
    "Fiat webhook processing failed",
  );
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
  assert.match(source, /FROM payment_webhook_events pwe/);
  assert.match(source, /received_at >= .*interval '30 days'/s);
  assert.match(source, /checkout_creating_stale/);
  assert.match(source, /pending_stale/);
  assert.match(source, /INSERT INTO fiat_problem_alert_outbox/);
  assert.match(source, /ON CONFLICT \(source_kind, source_id\) DO NOTHING/);
  assert.match(source, /discord_delivered_at IS NULL/);
  assert.match(source, /next_attempt_at/);
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
});
