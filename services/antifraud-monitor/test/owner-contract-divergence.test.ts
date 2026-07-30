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

test("signup score and timing policy match the owner contract", async () => {
  const config = await source("../src/config.ts");
  const sourceReader = await source("../src/source.ts");
  const monitor = await source("../src/monitor.ts");
  const profileRisk = await source("../src/profile-risk.ts");

  assert.match(config, /MONITOR_DURATION_SECONDS[\s\S]*?default\(600\)/);
  assert.match(sourceReader, /interval '30 seconds'/);
  assert.match(profileRisk, /score >= 21/);
  assert.match(profileRisk, /score >= 50/);
  assert.match(profileRisk, /score >= 70/);
  assert.match(profileRisk, /Math\.min\(100/);
  assert.match(monitor, /persistProfileAssessment/);
});

test("Fiat is globally disabled before cached approvals are considered", async () => {
  const config = await source("../src/config.ts");
  const eligibility = await source("../src/fiat-eligibility.ts");
  const globalGate = eligibility.indexOf("if (!this.globallyEnabled)");
  const cachedDecisionLookup = eligibility.indexOf("const previous = await this.existing");

  assert.match(config, /FIAT_ELIGIBILITY_GLOBALLY_ENABLED/);
  assert.ok(globalGate >= 0);
  assert.ok(cachedDecisionLookup >= 0);
  assert.ok(
    globalGate < cachedDecisionLookup,
    "the global deny must run before cached eligibility decisions",
  );
  assert.match(eligibility, /fiat_globally_disabled/);
  assert.match(eligibility, /riskScore: 0/);
});

test("permanent versioned signup profiles and provider evidence are present", async () => {
  const migrations = await migrationCorpus();
  const monitor = await source("../src/monitor.ts");
  const profileStore = await source("../src/profile-store.ts");

  assert.match(migrations, /CREATE TABLE IF NOT EXISTS antifraud_profiles/i);
  assert.match(migrations, /CREATE TABLE IF NOT EXISTS profile_assessment_history/i);
  assert.match(migrations, /CREATE TABLE IF NOT EXISTS profile_provider_evidence/i);
  assert.match(migrations, /evidence_key/i);
  assert.match(monitor, /persistProfileAssessment/);
  assert.match(profileStore, /profile_provider_evidence/);
  assert.match(
    profileStore,
    /ON CONFLICT \(user_id, provider, evidence_key\) DO NOTHING/i,
  );
});

test("automatic containment bans confirmed catch-all accounts without forcing KYC", async () => {
  const ingest = await source("../../../src/app/api/antifraud/ingest/route.ts");

  assert.doesNotMatch(ingest, /AUTOMATED_.*KYC/);
  assert.doesNotMatch(ingest, /await requireUserKyc\(/);
  assert.match(ingest, /abstract_email_catchall[\s\S]*?is_banned = TRUE/);
  assert.match(ingest, /DELETE FROM session/);
  assert.match(ingest, /locked_withdrawals_items = TRUE/);
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

test("KYC can only be requested from an eligible locked-account review", async () => {
  const kycActions = await source(
    "../../../src/app/(antifraud)/antifraud/kyc/actions.ts",
  );
  const quickActions = await source(
    "../../../src/app/(antifraud)/antifraud/reviews/_components/quick-review-actions.tsx",
  );
  const eligibility = await source(
    "../../../src/lib/antifraud/kyc-eligibility.ts",
  );

  assert.match(kycActions, /isLockedAccountEligibleForKyc/);
  assert.match(eligibility, /locked_withdrawals_items = TRUE/);
  assert.match(eligibility, /cardinality\(locked_withdrawals_crypto\)/);
  assert.doesNotMatch(quickActions, /require_kyc|Require KYC/);
});
