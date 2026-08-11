import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildFiatDiscordPayload,
  fetchFailedPaymentWebhooks,
  fetchFiatProblems,
  fetchHighRiskFiatProblems,
  FiatProblemAlerts,
  fiatAlertDestinations,
  fiatAlertEventKey,
  fiatProblemTitle,
  isFiatRiskProblem,
  type FiatProblem,
} from "../src/fiat-alerts.js";
import type { Config } from "../src/config.js";

const FIAT_WORKSPACE_URL = "https://fraud.packydash.com/fiat-deposits";

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
    payment_method_type: "apple",
    failure_reason: "@here <@123456789012345678>",
  },
  occurred_at: new Date("2026-07-28T12:00:00.000Z"),
};

test("fiat problem payload is safe, useful, and has no Discord mentions", () => {
  const payload = buildFiatDiscordPayload(FIAT_WORKSPACE_URL, failedIntent);

  assert.equal(payload.username, "PackyGG Fiat");
  assert.ok(!("escalate" in payload));
  assert.equal(payload.embeds[0]?.title, "Fiat deposit failed");
  assert.equal(payload.embeds[0]?.color, 0xef4444);
  assert.equal(payload.embeds[0]?.url, FIAT_WORKSPACE_URL);
  assert.equal(payload.components[0]?.components[0]?.url, FIAT_WORKSPACE_URL);
  assert.match(
    payload.embeds[0]?.fields.find((field) => field.name === "Account")
      ?.value ?? "",
    /everyone/,
  );
  assert.doesNotMatch(JSON.stringify(payload), /<@/);
  assert.match(JSON.stringify(payload), /\$125\.50/);
  assert.equal(
    payload.embeds[0]?.fields.find((field) => field.name === "Payment option")
      ?.value,
    "Apple Pay",
  );
});

test("locked-account deposit alerts expose the active fiat lock", () => {
  const payload = buildFiatDiscordPayload(FIAT_WORKSPACE_URL, {
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
  });

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
  assert.equal(
    payload.embeds[0]?.fields.find((field) => field.name === "Payment option")
      ?.value,
    "Unknown",
  );
});

test("canonical bad fiat assessments use the same dedicated webhook payload", () => {
  const payload = buildFiatDiscordPayload(FIAT_WORKSPACE_URL, {
    ...failedIntent,
    source_id: "intent-3:high_risk",
    problem_code: "high_risk",
    details: {
      intent_id: "intent-3",
      status: "completed",
      credited_amount_cents: 75_000,
      provider_payment_status: "paid",
      payment_method_type: "card",
      deposit_occurred_at: "2026-07-28T11:55:00.000Z",
        risk_score: 85,
        verdict: "bad",
        recommendation: "Hold withdrawals and review the payment evidence.",
        summary: "Shared device and provider dispute evidence.",
    },
  });

  assert.equal(payload.embeds[0]?.title, "🚨 High-risk fiat deposit");
  assert.match(payload.embeds[0]?.description ?? "", /high-risk verdict/);
  assert.equal(
    payload.embeds[0]?.fields.find((field) => field.name === "📊 Risk score")
      ?.value,
    "**85 / 100**\nCritical risk",
  );
  assert.equal(
    payload.embeds[0]?.fields.find(
      (field) => field.name === "💵 Deposit amount",
    )?.value,
    "**$750.00**",
  );
  assert.equal(
    payload.embeds[0]?.fields.find(
      (field) => field.name === "🕒 Deposit received",
    )?.value,
    "<t:1785239700:F>\n<t:1785239700:R>",
  );
  assert.equal(payload.embeds[0]?.timestamp, "2026-07-28T11:55:00.000Z");
  assert.equal(
    payload.components[0]?.components[0]?.label,
    "Review High-Risk Deposit",
  );
  assert.match(JSON.stringify(payload), /provider dispute evidence/);
  assert.match(JSON.stringify(payload), /Hold withdrawals and review/);
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

test("only blocking and high-risk fiat problems use the risk webhook", () => {
  assert.equal(isFiatRiskProblem("high_risk"), true);
  assert.equal(isFiatRiskProblem("fiat_locked_account"), true);
  assert.equal(isFiatRiskProblem("blacklisted_email_domain"), true);
  assert.equal(isFiatRiskProblem("suspicious_deposit_cluster"), true);
  assert.equal(isFiatRiskProblem("pending_stale"), false);
  assert.equal(isFiatRiskProblem("checkout_creating_stale"), false);
  assert.equal(isFiatRiskProblem("failed"), false);
  assert.equal(isFiatRiskProblem("review"), false);
  assert.equal(isFiatRiskProblem("disputed"), false);
  assert.equal(isFiatRiskProblem("partially_refunded"), false);
  assert.equal(isFiatRiskProblem("refunded"), false);
  assert.equal(isFiatRiskProblem("webhook_failed"), false);
});

test("signup blacklist alerts identify the signup email", () => {
  const payload = buildFiatDiscordPayload(FIAT_WORKSPACE_URL, {
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
  });

  assert.match(payload.embeds[0]?.description ?? "", /new signup/);
  assert.equal(
    payload.embeds[0]?.fields.find((field) => field.name === "Signup email")
      ?.value,
    "person@stolas.org",
  );
  assert.doesNotMatch(JSON.stringify(payload), /Whop checkout email/);
  assert.ok(!("escalate" in payload));
});

test("Gmail pattern alerts explain the rule without blacklisting Gmail", () => {
  const payload = buildFiatDiscordPayload(FIAT_WORKSPACE_URL, {
    source_kind: "payment_webhook",
    source_id: "event-1:blacklisted_email_domain:gmail.com",
    problem_code: "blacklisted_email_domain",
    user_id: "user-1",
    username: "test-user",
    details: {
      checkout_email: "carmenw.oods29.7.1@gmail.com",
      email_domain: "gmail.com",
      email_risk_type: "gmail_dot_fragmentation",
      email_risk_reason: "Dot-fragmented Gmail pattern",
      risk_score: 100,
      status: "withdrawals_locked",
    },
    occurred_at: new Date("2026-07-28T12:00:00.000Z"),
  });

  assert.equal(payload.embeds[0]?.title, "Suspicious checkout email review");
  assert.match(payload.embeds[0]?.description ?? "", /dot-fragmentation/);
  assert.equal(
    payload.embeds[0]?.fields.find((field) => field.name === "Email provider")
      ?.value,
    "gmail.com",
  );
  assert.doesNotMatch(JSON.stringify(payload), /Blacklisted domain/);
});

test("deposit cluster alerts aggregate evidence without duplicate account alerts", () => {
  const payload = buildFiatDiscordPayload(
    "https://fraud.packydash.com/antifraud/fiat-deposits",
    {
      source_kind: "payment_webhook",
      source_id: "deposit-cluster:event-3",
      problem_code: "suspicious_deposit_cluster",
      user_id: "user-3",
      username: "user3",
      details: {
        currency: "EUR",
        amount_cents: 1847,
        cluster_member_count: 3,
        cluster_account_count: 3,
        cluster_payment_count: 3,
        cluster_window_minutes: 30,
        cluster_emails: [
          "margenebrombergguidet.t.if.i.v.z.c@gmail.com",
          "giecphangqua.nh.ghun.g@gmail.com",
          "carmenw.oods29.7.1@gmail.com",
        ],
        email_risk_type: "suspicious_deposit_cluster",
        risk_score: 100,
        status: "withdrawals_locked",
      },
      occurred_at: new Date("2026-07-28T12:15:00.000Z"),
    },
  );

  assert.equal(
    payload.embeds[0]?.title,
    "Suspicious Whop deposit cluster blocked",
  );
  assert.match(payload.embeds[0]?.description ?? "", /distinct accounts/);
  assert.equal(
    payload.embeds[0]?.fields.find(
      (field) => field.name === "Shared deposit amount",
    )?.value,
    "€18.47",
  );
  assert.match(
    payload.embeds[0]?.fields.find((field) => field.name === "Cluster evidence")
      ?.value ?? "",
    /3 events.*3 accounts.*3 payment identities/,
  );
  assert.equal(
    payload.embeds[0]?.fields.filter(
      (field) => field.name === "Cluster checkout emails",
    ).length,
    1,
  );
});

test("the four-route mapping preserves current fiat classification", () => {
  assert.deepEqual(fiatAlertDestinations("blacklisted_email_domain"), [
    "email_blacklist",
  ]);
  assert.deepEqual(fiatAlertDestinations("suspicious_deposit_cluster"), [
    "email_blacklist",
  ]);
  assert.deepEqual(fiatAlertDestinations("high_risk"), [
    "antifraud_risk",
    "high_risk_supplemental",
  ]);
  assert.deepEqual(fiatAlertDestinations("fiat_locked_account"), [
    "antifraud_risk",
  ]);
  assert.deepEqual(fiatAlertDestinations("failed"), ["fiat_operations"]);

  assert.equal(
    fiatAlertEventKey("email_blacklist"),
    "antifraud.email_blacklist",
  );
  assert.equal(fiatAlertEventKey("antifraud_risk"), "antifraud.fiat_risk");
  assert.equal(
    fiatAlertEventKey("high_risk_supplemental"),
    "antifraud.fiat_risk",
  );
  assert.equal(
    fiatAlertEventKey("fiat_operations"),
    "antifraud.fiat_operations",
  );
  assert.equal(
    fiatAlertEventKey("fiat_operations", "review"),
    "antifraud.fiat_credit_review_required",
  );
});

test("credit-review deposits use a dedicated action and review-queue button", () => {
  const payload = buildFiatDiscordPayload(FIAT_WORKSPACE_URL, {
    ...failedIntent,
    source_id: "intent-1:review",
    problem_code: "review",
    details: {
      ...failedIntent.details,
      status: "review",
    },
  });

  assert.equal(payload.embeds[0]?.title, "Fiat deposit needs review");
  assert.match(JSON.stringify(payload.components), /Open Deposit Reviews/);
  assert.doesNotMatch(
    JSON.stringify(payload.components),
    /Open Fiat Operations/,
  );
});

test("legacy high-risk destinations collapse into one routed event", async () => {
  const pending = [
    {
      ...failedIntent,
      problem_code: "high_risk" as const,
      destination: "antifraud_risk" as const,
      attempt_count: 0,
    },
    {
      ...failedIntent,
      problem_code: "high_risk" as const,
      destination: "high_risk_supplemental" as const,
      attempt_count: 0,
    },
  ];
  const updates: unknown[][] = [];
  let pendingIndex = 0;
  const antifraud = {
    query: async (text: string, values: unknown[] = []) => {
      if (
        text.includes("FROM fiat_problem_alert_deliveries AS delivery") &&
        text.includes("JOIN fiat_problem_alert_outbox AS alert")
      ) {
        const row = pending[pendingIndex];
        pendingIndex += 1;
        return { rows: row ? [row] : [] };
      }
      if (
        text.includes("UPDATE fiat_problem_alert_deliveries") &&
        text.includes("AND destination = $3")
      ) {
        updates.push(values);
      }
      return { rows: [] };
    },
  };
  const config = {
    ADMIN_GUILD_ID: "1483064422778798112",
    ANTIFRAUD_INGEST_URL: "https://fraud.packydash.com/api/antifraud/ingest",
    ANTIFRAUD_INGEST_SECRET: "ingest-secret-that-is-at-least-32-characters",
    FIAT_ALERT_DASHBOARD_URL: FIAT_WORKSPACE_URL,
  } as Config;
  const alerts = new FiatProblemAlerts(
    config,
    { antifraud, source: {} } as never,
    { error() {}, info() {} } as never,
  );
  const originalFetch = globalThis.fetch;
  const fetchUrls: string[] = [];
  const eventKeys: string[] = [];
  const dedupeKeys: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    fetchUrls.push(url);
    const body = JSON.parse(String(init?.body)) as {
      eventKey: string;
      dedupeKey: string;
    };
    eventKeys.push(body.eventKey);
    dedupeKeys.push(body.dedupeKey);
    return Response.json({ ok: true });
  };

  try {
    const deliver = alerts as unknown as { deliver(): Promise<void> };
    await deliver.deliver();
    await deliver.deliver();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(fetchUrls.length, 2);
  assert.ok(
    fetchUrls.every((url) => url.endsWith("/api/antifraud/discord-events")),
  );
  assert.deepEqual(eventKeys, ["antifraud.fiat_risk", "antifraud.fiat_risk"]);
  assert.equal(new Set(dedupeKeys).size, 1);
  assert.deepEqual(
    updates.map((values) => ({
      destination: values[2],
      delivered: values[3],
      retrySeconds: values[5],
    })),
    [
      {
        destination: "antifraud_risk",
        delivered: true,
        retrySeconds: 2,
      },
      {
        destination: "high_risk_supplemental",
        delivered: true,
        retrySeconds: 2,
      },
    ],
  );
});

test("fiat alert ingestion is mirror-only, durable, and retryable", async () => {
  const source = await readFile(
    new URL("../src/fiat-alerts.ts", import.meta.url),
    "utf8",
  );
  const migration = await readFile(
    new URL("../migrations/021_fiat_alert_destinations.sql", import.meta.url),
    "utf8",
  );
  const splitMigration = await readFile(
    new URL(
      "../migrations/022_split_high_risk_fiat_destination.sql",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(source, /FROM fiat_deposit_intents fdi/);
  assert.match(
    source,
    /JOIN user_feature_locks ufl ON ufl\.user_id = fdi\.user_id/,
  );
  assert.match(source, /cardinality\(ufl\.locked_deposits_fiat\) > 0/);
  assert.match(source, /ufl\.locked_deposits_at <= fdi\.created_at/);
  assert.match(source, /fiat_locked_account/);
  assert.match(source, /FROM fiat_deposit_assessments fda/);
  assert.match(source, /fda\.verdict = 'bad'/);
  assert.match(source, /HIGH_RISK_CURSOR_STREAM/);
  assert.match(source, /FROM payment_webhook_events pwe/);
  assert.match(source, /'payment_method_type'/);
  assert.match(source, /provider_evidence->>'paymentMethodType'/);
  assert.match(source, /received_at >= .*interval '30 days'/s);
  assert.match(source, /checkout_creating_stale/);
  assert.match(source, /pending_stale/);
  assert.match(source, /INSERT INTO fiat_problem_alert_outbox/);
  assert.match(source, /ON CONFLICT \(source_kind, source_id\) DO NOTHING/);
  assert.match(source, /INSERT INTO fiat_problem_alert_deliveries/);
  assert.match(
    source,
    /ON CONFLICT \(source_kind, source_id, destination\) DO NOTHING/,
  );
  assert.match(source, /delivery\.delivered_at IS NULL/);
  assert.match(source, /next_attempt_at/);
  assert.match(source, /antifraud\.fiat_risk/);
  assert.match(source, /antifraud\.fiat_operations/);
  assert.match(source, /antifraud\.email_blacklist/);
  assert.match(source, /sendBotDiscordEvent/);
  assert.match(source, /LIMIT 1/);
  assert.match(
    migration,
    /PRIMARY KEY \(source_kind, source_id, destination\)/,
  );
  assert.match(
    migration,
    /ON CONFLICT \(source_kind, source_id, destination\) DO NOTHING/,
  );
  assert.match(
    migration,
    /WHEN destination\.destination = 'email_blacklist' THEN now\(\)/,
  );
  assert.match(migration, /WHERE delivered_at IS NULL/);
  assert.match(splitMigration, /DELETE FROM fiat_problem_alert_deliveries/);
  assert.match(
    splitMigration,
    /alert\.problem_code IN \('high_risk', 'fiat_locked_account'\)/,
  );
  assert.equal(
    splitMigration.match(/d67b5118-9926-47bd-b58c-9203a15620be:high_risk/g)
      ?.length,
    2,
  );
  assert.match(
    splitMigration,
    /ON CONFLICT \(source_kind, source_id, destination\) DO NOTHING/,
  );
  assert.match(splitMigration, /WHERE alert\.problem_code = 'high_risk'/);

  const calls: Array<{ text: string; values: unknown[] }> = [];
  const pool = {
    query: async (text: string, values: unknown[]) => {
      calls.push({ text, values });
      return { rows: [] };
    },
  };
  await fetchFailedPaymentWebhooks(
    pool as never,
    {
      occurredAt: new Date("2026-07-01T00:00:00.000Z"),
      sourceId: "webhook-1:webhook_failed",
    },
    250,
  );
  assert.equal(calls[0]?.values[2], 250);
  assert.match(calls[0]?.text ?? "", /processing_status = 'failed'/);
  assert.match(calls[0]?.text ?? "", /payment_method_type/);
  assert.match(calls[0]?.text ?? "", /\) > \(\$1, \$2\)/);

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
  assert.match(
    riskCalls[0]?.text ?? "",
    /'deposit_occurred_at', fda\.occurred_at/,
  );
});

test("high-risk fiat alerts wait out the assessment settlement lag", async () => {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const pool = {
    query: async (text: string, values: unknown[]) => {
      calls.push({ text, values });
      return { rows: [] };
    },
  };
  await fetchHighRiskFiatProblems(
    pool as never,
    {
      occurredAt: new Date("2026-07-28T12:00:00.000Z"),
      sourceId: "intent-2:high_risk",
    },
    50,
  );
  // assessed_at is now() inside the refresh transaction, i.e. the transaction
  // START time. A slow transaction commits rows stamped before a faster one
  // that already advanced the cursor, so without a lag those canonical
  // verdict='bad' deposits are never fetched again and never alert.
  assert.match(
    calls[0]?.text ?? "",
    /fda\.assessed_at <= now\(\) - interval '5 seconds'/,
  );
});

test("locked-account alerts ignore checkouts that were never attempted", async () => {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const pool = {
    query: async (text: string, values: unknown[]) => {
      calls.push({ text, values });
      return { rows: [] };
    },
  };
  await fetchFiatProblems(
    pool as never,
    {
      occurredAt: new Date("2026-07-28T12:00:00.000Z"),
      sourceId: "intent-1:failed",
    },
    25,
  );
  assert.match(
    calls[0]?.text ?? "",
    /fdi\.status NOT IN \('created', 'canceled'\)/,
  );
});

test("blacklist alert copy does not promise a KYC requirement", () => {
  const payload = buildFiatDiscordPayload(FIAT_WORKSPACE_URL, {
    source_kind: "payment_webhook",
    source_id: "event-9:blacklisted_email_domain:stolas.org",
    problem_code: "blacklisted_email_domain",
    user_id: "user-9",
    username: "user9",
    details: {
      checkout_email: "person@stolas.org",
      email_domain: "stolas.org",
      risk_score: 100,
      status: "withdrawals_locked",
    },
    occurred_at: new Date("2026-07-28T12:00:00.000Z"),
  });
  // The email-domain containment path locks crypto and item withdrawals only.
  // Nothing in it ever sets a KYC requirement.
  assert.match(
    payload.embeds[0]?.description ?? "",
    /Crypto and item withdrawals are locked\./,
  );
  assert.doesNotMatch(payload.embeds[0]?.description ?? "", /KYC/);
});
