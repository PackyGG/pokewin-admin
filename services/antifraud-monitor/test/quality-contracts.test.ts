import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { sequenceMatches } from "../src/monitor.js";
import { SEVERITY_BANDS } from "../src/score-catalog.js";
import { severity } from "../src/scoring.js";
import { HIGH_RISK_SIGNUP_SCORE } from "../src/signup-alerts.js";

async function source(relative: string): Promise<string> {
  return readFile(new URL(relative, import.meta.url), "utf8");
}

test("current signup review and severity thresholds stay explicit", () => {
  assert.equal(HIGH_RISK_SIGNUP_SCORE, 50);
  assert.equal(severity(59), "medium");
  assert.equal(severity(60), "medium");
  assert.equal(severity(79), "medium");
  assert.equal(severity(80), "high");
  assert.equal(severity(119), "high");
  assert.equal(severity(120), "critical");
  assert.deepEqual(
    SEVERITY_BANDS.map(({ key, minimum, maximum }) => ({
      key,
      minimum,
      maximum,
    })),
    [
      { key: "low", minimum: 0, maximum: 39 },
      { key: "medium", minimum: 40, maximum: 79 },
      { key: "high", minimum: 80, maximum: 119 },
      { key: "critical", minimum: 120, maximum: null },
    ],
  );
});

test("all five signup providers are required and failures enter recovery", async () => {
  const monitor = await source("../src/monitor.ts");
  const prepareStart = monitor.indexOf("private async prepareSignup");
  const prepareEnd = monitor.indexOf("private async persistSignup", prepareStart);
  const prepare = monitor.slice(prepareStart, prepareEnd);

  for (const provider of [
    "cachedFingerprint",
    "cachedProxycheck",
    "cachedAbstractIp",
    "cachedAbstractEmail",
    "cachedOpportify",
  ]) {
    assert.match(prepare, new RegExp(`this\\.${provider}\\(signup, weights\\)`));
  }
  assert.match(prepare, /\.filter\(\(result\) => result\.status === "failed"\)/);
  assert.match(prepare, /Provider enrichment unavailable:/);
  assert.match(
    monitor,
    /error_text LIKE 'Provider enrichment unavailable:%'/,
    "provider failures must remain eligible for dead-letter replay",
  );
  assert.match(
    prepare,
    /persistAbstractCatchallContainment[\s\S]*?throw new Error/,
    "confirmed catch-all containment must commit before another provider failure is raised",
  );
});

test("reward rush rules cannot combine events from different monitor sessions", async () => {
  const monitor = await source("../src/monitor.ts");
  assert.match(
    monitor,
    /FROM risk_events\s+WHERE session_id = \$1\s+ORDER BY occurred_at/,
  );

  const welcome = {
    event_type: "welcome_reward_opened",
    occurred_at: new Date("2026-07-30T12:00:00.000Z"),
  };
  const wager = {
    event_type: "ledger_upgrader_bet",
    occurred_at: new Date("2026-07-30T12:01:00.000Z"),
  };
  assert.equal(
    sequenceMatches(
      [welcome, wager],
      ["welcome_reward_opened", "ledger_upgrader_bet"],
      180,
      ["fiat_deposit", "crypto_deposit"],
    ),
    true,
  );
  assert.equal(
    sequenceMatches(
      [
        welcome,
        {
          event_type: "fiat_deposit",
          occurred_at: new Date("2026-07-30T12:00:30.000Z"),
        },
        wager,
      ],
      ["welcome_reward_opened", "ledger_upgrader_bet"],
      180,
      ["fiat_deposit", "crypto_deposit"],
    ),
    false,
  );
});

test("migration runner serializes, rolls back failures, and records only commits", async () => {
  const migrate = await source("../src/migrate.ts");
  assert.match(migrate, /SELECT pg_advisory_lock\(\$1\)/);
  assert.match(
    migrate,
    /SELECT EXISTS\(SELECT 1 FROM schema_migrations WHERE version = \$1\)/,
  );
  assert.match(
    migrate,
    /await client\.query\(await readFile[\s\S]*?INSERT INTO schema_migrations[\s\S]*?COMMIT/,
  );
  assert.match(migrate, /catch \(error\) \{\s+await client\.query\("ROLLBACK"\)/);
  assert.match(migrate, /SELECT pg_advisory_unlock\(\$1\)/);
});

test("legacy withdrawal and fiat scores retain explicit model identities", async () => {
  const withdrawalMigration = await source(
    "../migrations/015_withdrawal_risk_v2.sql",
  );
  const withdrawal = await source("../src/withdrawal-risk.ts");
  const withdrawalRoutes = await source("../src/withdrawal-routes.ts");
  const fiatMigration = await source(
    "../migrations/012_fiat_deposit_assessments.sql",
  );
  const fiat = await source("../src/fiat-risk.ts");

  assert.match(
    withdrawalMigration,
    /model_version integer NOT NULL DEFAULT 1/,
  );
  assert.match(withdrawal, /WITHDRAWAL_RISK_MODEL_VERSION = 4/);
  assert.match(withdrawalRoutes, /model_version=\$1/);
  assert.match(fiatMigration, /score_version text NOT NULL DEFAULT 'fiat-v1'/);
  assert.match(fiat, /score_version='fiat-v2'/);
});

test("delivery backfill preserves acknowledged history and replays only containment", async () => {
  const migration = await source(
    "../migrations/028_dashboard_delivery_receipts.sql",
  );
  assert.match(
    migration,
    /event\.dashboard_delivered_at IS NULL/,
    "reruns must not rewrite existing delivery receipts",
  );
  assert.match(
    migration,
    /event\.event_type <> 'risky_free_battle_containment'/,
    "only the explicitly documented containment family may be replayed",
  );
  assert.match(
    migration,
    /\(event\.recorded_at, event\.id\) <=\s+\(cursor\.recorded_at, cursor\.event_id\)/,
  );
  assert.match(
    migration,
    /WHERE dashboard_delivered_at IS NULL/,
    "pending delivery scans need a partial index",
  );
});

test("MAIN activity reads are time bounded and index contracts match expressions", async () => {
  const activity = await source("../src/source.ts");
  const indexes = await source("../migrations/source-mirror-indexes.sql");

  assert.match(activity, /lt\.user_id = \$1/);
  assert.match(activity, /lt\.created_at >=/);
  assert.match(activity, /lt\.created_at <= \(\$6::timestamptz/);
  assert.match(activity, /ur\.user_id = \$1/);
  assert.match(activity, /bp\.user_id = \$1/);
  assert.match(activity, /LIMIT \$7/);
  assert.match(
    indexes,
    /ON ledger_transactions \(user_id, created_at\)/,
  );
  assert.match(
    indexes,
    /ON user_rewards \(user_id, \(COALESCE\(opened_at, granted_at\)\)\)/,
  );
});

test("refund history quarantines uncertain outcomes and prevents duplicate payments", async () => {
  const migration = await source(
    "../../../drizzle/admin/migrations/20260729_whop_refund_operations.sql",
  );
  const actions = await source(
    "../../../src/app/(antifraud)/antifraud/refunds/refund-actions.ts",
  );
  const whop = await source("../../../src/lib/whop-admin.ts");

  assert.match(migration, /UNIQUE \(provider_payment_id\)/);
  assert.match(migration, /'unknown'/);
  assert.match(migration, /ON DELETE RESTRICT/);
  assert.match(whop, /maxRetries:\s*0/);
  assert.match(actions, /client\.payments\.retrieve/);
  assert.match(actions, /client\.payments\.refund/);
  assert.match(
    actions,
    /safe\.outcomeUnknown \|\| refundRequested \? "unknown" : "failed"/,
  );
});
