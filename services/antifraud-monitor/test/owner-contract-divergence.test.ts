import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

async function source(relative: string): Promise<string> {
  return readFile(new URL(relative, import.meta.url), "utf8");
}

async function migrationCorpus(): Promise<string> {
  const directory = new URL("../migrations/", import.meta.url);
  const files = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  return Promise.all(
    files.map((name) => readFile(new URL(name, directory), "utf8")),
  ).then((values) => values.join("\n"));
}

test("OWNER DIVERGENCE: signup score and timing policy are not implemented", async () => {
  const config = await source("../src/config.ts");
  const sourceReader = await source("../src/source.ts");
  const monitor = await source("../src/monitor.ts");

  assert.match(config, /MONITOR_DURATION_SECONDS[\s\S]*?default\(180\)/);
  assert.doesNotMatch(config, /STANDARD_MONITOR_DURATION|HIGH_MONITOR_DURATION/);
  assert.match(sourceReader, /interval '5 seconds'/);
  assert.doesNotMatch(sourceReader, /interval '30 seconds'/);
  assert.match(
    monitor,
    /signals\.reduce\(\(total, signal\) => total \+ signal\.points, 0\)/,
  );
  assert.doesNotMatch(
    monitor,
    /Math\.min\(100,[\s\S]*?signals\.reduce/,
    "the authoritative 0-100 signup cap is absent",
  );
});

/**
 * Temporary divergence sentinel for the data-workstream integration.
 *
 * Replace this test with a black-box FiatEligibilityService regression after
 * the runtime gate lands. The replacement must exercise both dev and prod,
 * seed a prior unexpired stored allow, and prove that an absent or explicit
 * false account/environment switch returns a fresh deny rather than the cached
 * allow. Keep a true-switch control case so the fail-closed gate does not erase
 * otherwise valid idempotency.
 */
test("TEMP OWNER DIVERGENCE: Fiat eligibility is not default-disabled and cached allows bypass the switch", async () => {
  const eligibility = await source("../src/fiat-eligibility.ts");
  const cachedDecisionLookup = eligibility.indexOf(
    "const previous = await this.existing(input.fingerprint)",
  );
  const accountPolicyLookup = eligibility.indexOf(
    "const source = this.sourceFor(input.env)",
    cachedDecisionLookup,
  );

  assert.ok(cachedDecisionLookup >= 0);
  assert.ok(
    accountPolicyLookup > cachedDecisionLookup,
    "a cached allow is returned before current account/environment policy is loaded",
  );
  assert.match(
    eligibility,
    /COALESCE\(cardinality\(ufl\.locked_deposits_fiat\), 0\) > 0 AS fiat_locked/,
    "missing per-user lock state currently resolves to unlocked rather than explicit enablement",
  );
  assert.doesNotMatch(
    eligibility,
    /fiat_(?:eligibility_)?enabled|explicit_fiat_(?:eligibility_)?switch/i,
    "no explicit true-only Fiat eligibility switch is enforced",
  );
});

test("OWNER DIVERGENCE: permanent versioned signup profiles are absent", async () => {
  const migrations = await migrationCorpus();
  const monitor = await source("../src/monitor.ts");

  assert.match(migrations, /CREATE TABLE IF NOT EXISTS subjects/);
  assert.match(migrations, /CREATE TABLE IF NOT EXISTS signup_assessments/);
  assert.doesNotMatch(migrations, /CREATE TABLE IF NOT EXISTS antifraud_profiles/);
  assert.doesNotMatch(
    migrations,
    /signup_assessments[\s\S]{0,500}(model_version|score_version)/,
  );
  assert.match(
    monitor,
    /ON CONFLICT \(user_id\) DO UPDATE SET\s+score = EXCLUDED\.score/,
  );
  assert.match(
    monitor,
    /ON CONFLICT \(user_id, provider, lookup_key\) DO UPDATE SET/,
  );
});

test("OWNER DIVERGENCE: automatic containment conflicts with the KYC policy", async () => {
  const ingest = await source("../../../src/app/api/antifraud/ingest/route.ts");
  const email = await source("../src/fiat-email-domains.ts");

  assert.match(ingest, /AUTOMATED_EMAIL_KYC_ACTOR_ID/);
  assert.match(ingest, /AUTOMATED_ABSTRACT_EMAIL_KYC_ACTOR_ID/);
  assert.match(ingest, /AUTOMATED_FREE_BATTLE_KYC_ACTOR_ID/);
  assert.match(ingest, /await requireUserKyc\(/);
  assert.match(email, /KYC required automatically/);
  assert.match(ingest, /abstract_email_catchall[\s\S]*?is_locked = TRUE/);
  assert.doesNotMatch(
    ingest,
    /abstract_email_catchall[\s\S]*?is_banned = TRUE/,
  );
});

test("OWNER DIVERGENCE: operator IP and fingerprint blocklists are absent", async () => {
  const migrations = await migrationCorpus();
  const server = await source("../src/server.ts");

  assert.doesNotMatch(migrations, /CREATE TABLE IF NOT EXISTS .*ip.*blocklist/i);
  assert.doesNotMatch(
    migrations,
    /CREATE TABLE IF NOT EXISTS .*fingerprint.*blocklist/i,
  );
  assert.doesNotMatch(server, /\/v1\/(?:ip|fingerprint)-blocklist/);
});

test("OWNER DIVERGENCE: identity-provider and unified relationship evidence are incomplete", async () => {
  const sourceReader = await source("../src/source.ts");
  const network = await source("../src/network-risk.ts");

  for (const provider of ["google", "discord", "steam"]) {
    assert.doesNotMatch(
      sourceReader,
      new RegExp(`(?:oauth|credential|identity).{0,80}${provider}`, "i"),
    );
  }
  assert.match(network, /type: "shared_ip" \| "shared_device"/);
  assert.doesNotMatch(network, /session_hop|session_hopping/);
  assert.doesNotMatch(network, /downstream_value|fund_movement/);
});

test("OWNER DIVERGENCE: country context and hard-signal actions still score instead of only classify", async () => {
  const riskyMigration = await source(
    "../migrations/030_risky_location_score_tuning.sql",
  );
  const weights = await source("../src/score-catalog.ts");
  const ingest = await source("../../../src/app/api/antifraud/ingest/route.ts");

  assert.match(riskyMigration, /SET points = 20/);
  for (const key of [
    "fingerprint_bad_bot",
    "fingerprint_tampering",
    "fingerprint_event_replayed",
    "fingerprint_ip_mismatch",
    "fingerprint_linked_id_mismatch",
  ]) {
    assert.match(weights, new RegExp(`${key}: \\d+`));
  }
  assert.doesNotMatch(
    ingest,
    /fingerprint_(?:bad_bot|tampering|event_replayed|ip_mismatch|linked_id_mismatch)/,
    "hard Fingerprint signals have no dedicated containment command",
  );
});

test("OWNER DIVERGENCE: fresh-account promo, tip, and sponsorship actions are incomplete", async () => {
  const tuning = await source(
    "../migrations/014_signup_live_behavior_tuning.sql",
  );
  const catalog = await source("../src/event-catalog.ts");
  const freeBattle = await source("../src/free-battle-risk.ts");

  assert.match(catalog, /ledger_promo_code_redeemed/);
  assert.doesNotMatch(tuning, /promo/);
  assert.match(tuning, /'tip-before-deposit'[\s\S]*?40/);
  assert.match(tuning, /'sponsored-battle-before-deposit'[\s\S]*?40/);
  assert.match(
    freeBattle,
    /relationshipScoreForBattleCount[\s\S]*?40[\s\S]*?80[\s\S]*?120/,
  );
});

test("OWNER DIVERGENCE: locked-review-only KYC action does not exist", async () => {
  const reviewActions = await source(
    "../../../src/app/(antifraud)/antifraud/reviews/actions.ts",
  );
  const quickActions = await source(
    "../../../src/app/(antifraud)/antifraud/reviews/_components/quick-review-actions.tsx",
  );

  assert.match(
    reviewActions,
    /action: z\.enum\(\["fine", "ban", "lock_withdrawals"\]\)/,
  );
  assert.doesNotMatch(quickActions, /require_kyc|Require KYC/);
});
