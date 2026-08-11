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

  assert.match(config, /MONITOR_DURATION_SECONDS[\s\S]*?default\(300\)/);
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
  const cachedDecisionLookup = eligibility.indexOf(
    "this.existing(input.fingerprint)",
  );

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

test("automatic containment fully locks first-seen catch-all accounts without forcing KYC", async () => {
  const ingest = await source("../../../src/app/api/antifraud/ingest/route.ts");
  const catchall = await source(
    "../../../src/lib/antifraud/abstract-catchall-containment.ts",
  );

  // Automated antifraud never calls the KYC API; staff decide from review.
  assert.doesNotMatch(ingest, /await requireUserKyc\(/);
  assert.match(catchall, /locked_deposits_fiat = ARRAY\['all'\]/);
  assert.match(catchall, /locked_withdrawals_items = TRUE/);
  assert.match(catchall, /available_reward_categories/);
  assert.doesNotMatch(catchall, /is_banned = TRUE/);
  assert.match(ingest, /isContainmentOutboxKind/);
  assert.match(
    await source(
      "../../../src/lib/antifraud/behavioral-withdrawal-containment.ts",
    ),
    /locked_withdrawals_items = TRUE/,
  );
});

test("Fiat identity drift opens review and applies only approved locks", async () => {
  const containment = await source(
    "../../../src/lib/antifraud/fiat-identity-containment.ts",
  );
  const policy = await source("../src/fiat-deposit-identity-policy.ts");
  const service = await source("../src/fiat-deposit-identity.ts");
  const migrations = await migrationCorpus();

  assert.doesNotMatch(containment, /requireUserKyc|getUserKyc|requireKyc/i);
  assert.match(containment, /"withdrawals" \| "fiat_and_withdrawals"/);
  assert.match(containment, /locked_withdrawals_items = TRUE/);
  assert.match(containment, /locked_deposits_fiat = ARRAY\['all'\]/);

  // The dashboard re-checks the reason it was handed; the monitor's containment
  // set and the dashboard's allowlist must not drift apart.
  for (const reason of [
    "checkout_email_domain_blacklisted",
    "checkout_ip_blocklisted",
    "checkout_fingerprint_blocklisted",
    "checkout_refunded_amount_cluster",
    "checkout_card_changed_recent",
    "checkout_ip_and_device_changed",
  ]) {
    assert.match(policy, new RegExp(`"${reason}"`));
    assert.match(containment, new RegExp(`"${reason}"`));
  }
  assert.match(service, /refundedAmountClusterActiveUntil/);
  assert.match(containment, /Date\.parse\(payload\.refundedAmountClusterActiveUntil\)/);
  assert.match(containment, /clusterActiveUntil > Date\.now\(\)/);

  // A single changed IP or device is ordinary customer behaviour; only the pair
  // contains.
  assert.match(policy, /"checkout_ip_changed"/);
  assert.match(policy, /"checkout_device_changed"/);
  assert.match(policy, /CARD_CHANGE_LOCK_WINDOW_MS = 2 \* 60 \* 60 \* 1000/);
  assert.match(policy, /CARD_CHANGE_REVIEW_WINDOW_MS = 24 \* 60 \* 60 \* 1000/);
  assert.match(policy, /"checkout_email_changed"/);
  assert.match(policy, /"checkout_email_undeliverable"/);
  assert.match(policy, /action: "review"/);

  // History is never walked: the cursor is seeded at deploy time.
  assert.match(
    migrations,
    /INSERT INTO source_cursors[\s\S]*?'fiat-deposit-identity', now\(\)/,
  );
  assert.match(service, /ON CONFLICT \(intent_id\) DO NOTHING/);
  assert.match(service, /ORDER BY \(fdi\.paid_at \$\{UTC\}\) DESC, fdi\.id DESC/);
});

test("operator IP and fingerprint blocklists are durable and enforced at signup", async () => {
  const migrations = await migrationCorpus();
  const server = await source("../src/server.ts");
  const matcher = await source("../src/identifier-blocklists.ts");
  const routes = await source("../src/identifier-blocklist-routes.ts");
  const ingest = await source("../../../src/app/api/antifraud/ingest/route.ts");
  const blocklist = await source(
    "../../../src/lib/antifraud/identifier-blocklist-containment.ts",
  );

  assert.match(migrations, /CREATE TABLE IF NOT EXISTS identifier_blocklists/i);
  assert.match(migrations, /kind IN \('ip','fingerprint'\)/i);
  assert.match(migrations, /identifier_blocklist_matches/i);
  assert.match(migrations, /identifier_blocklist_audit/i);
  assert.match(routes, /\/v1\/blocklists\/:kind/);
  assert.match(routes, /historical_backfill[\s\S]*review_only/);
  assert.match(matcher, /active_ip_blocklist/);
  assert.match(migrations, /effect = 'block'.*known_vpn/is);
  assert.match(matcher, /known_vpn_ip/);
  assert.match(matcher, /points: 15/);
  assert.match(matcher, /active_fingerprint_blocklist/);
  assert.match(matcher, /lock_review/);
  assert.match(blocklist, /identifierBlocklistContainmentTarget/);
  assert.match(blocklist, /blocklist\.ip/);
  assert.match(blocklist, /blocklist\.fingerprint/);
  assert.match(blocklist, /locked_withdrawals_items = TRUE/);
  assert.doesNotMatch(blocklist, /requireUserKyc|getUserKyc/i);
  assert.match(ingest, /isContainmentOutboxKind/);
  assert.match(server, /registerIdentifierBlocklistRoutes/);
});

test("identity-provider evidence is explicit; unified relationship evidence remains incomplete", async () => {
  const sourceReader = await source("../src/source.ts");
  const identity = await source("../src/types.ts");
  const profileStore = await source("../src/profile-store.ts");
  const network = await source("../src/network-risk.ts");

  for (const provider of ["google", "discord", "steam"]) {
    assert.match(identity, new RegExp(`"${provider}"`));
  }
  assert.match(identity, /"credential"/);
  assert.match(sourceReader, /jsonb_agg[\s\S]*?'provider', a\."providerId"/);
  assert.match(sourceReader, /WHERE a\."userId" = u\.id/);
  assert.match(sourceReader, /'linkedAt', \(a\.created_at/);
  assert.match(profileStore, /auth_provider_timeline/);
  assert.match(network, /type: "shared_ip" \| "shared_device"/);
  assert.doesNotMatch(network, /session_hop|session_hopping/);
  assert.doesNotMatch(network, /downstream_value|fund_movement/);
});

test("country context is bounded below monitoring and hard policies have signed containment", async () => {
  const behaviorMigration = await source(
    "../migrations/041_fresh_account_behavior_policy.sql",
  );
  const weights = await source("../src/score-catalog.ts");
  const ingest = await source("../../../src/app/api/antifraud/ingest/route.ts");
  const behavioral = await source(
    "../../../src/lib/antifraud/behavioral-withdrawal-containment.ts",
  );

  assert.match(behaviorMigration, /'risky_location', 15/);
  assert.match(weights, /risky_location: 15/);
  assert.match(ingest, /behavioral_withdrawal_containment/);
  for (const key of [
    "fingerprint_bad_bot",
    "fingerprint_tampering",
    "fingerprint_event_replayed",
    "fingerprint_ip_mismatch",
    "fingerprint_linked_id_mismatch",
  ]) {
    assert.match(weights, new RegExp(`${key}: \\d+`));
  }
  assert.match(behavioral, /fingerprint\.automation/);
  assert.match(behavioral, /fingerprint\.replayed/);
});

test("fresh-account promo, tip, and sponsorship actions are explicit", async () => {
  const tuning = await source(
    "../migrations/041_fresh_account_behavior_policy.sql",
  );
  const monitor = await source("../src/monitor.ts");
  const sourceReader = await source("../src/source.ts");

  assert.match(tuning, /fresh-third-promo-redemption/);
  assert.match(tuning, /ledger_promo_code_redeemed","ledger_promo_code_redeemed","ledger_promo_code_redeemed/);
  assert.match(tuning, /'lock_withdrawals'/);
  assert.match(tuning, /SET score_delta = 70/);
  assert.match(tuning, /tip-before-deposit/);
  assert.match(tuning, /sponsored-battle-before-deposit/);
  assert.match(sourceReader, /creator_has_site_role/);
  assert.match(sourceReader, /minimum_withdrawal_runup/);
  assert.match(monitor, /expected_creator_activity|isCreator/);
});

test("Account Review can request KYC on a case without changing its verdict", async () => {
  const kycActions = await source(
    "../../../src/app/(antifraud)/antifraud/kyc/actions.ts",
  );
  const reviewActions = await source(
    "../../../src/app/(antifraud)/antifraud/reviews/actions.ts",
  );
  const quickActions = await source(
    "../../../src/app/(antifraud)/antifraud/reviews/_components/quick-review-actions.tsx",
  );

  // The canonical requireAccountKyc now locks the account itself (deposits,
  // withdrawals, tips) instead of refusing unless it was already locked by
  // some other path — see fiat-identity-containment.ts for why lock-first
  // matters.
  assert.match(kycActions, /lockFiatAndWithdrawals\(/);
  assert.match(kycActions, /updateUserRewardLocks\(/);
  // Positive contract: Account Review now delegates to the canonical
  // requireAccountKyc action instead of leaving KYC unreachable from the
  // case-review workflow. Status-untouched behavior is covered by the
  // dedicated fixture test in scripts/__fixtures__/antifraud-signup-review-actions.test.ts.
  assert.match(reviewActions, /requireReviewKyc/);
  assert.match(reviewActions, /requireAccountKyc/);
  assert.match(quickActions, /Require KYC/);
});
