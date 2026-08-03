import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

test("Fiat perk access changes are durable and backend-confirmed", () => {
  const migration = source(
    "services/antifraud-monitor/migrations/050_fiat_perks_v2.sql",
  );
  const access = source(
    "services/antifraud-monitor/src/fiat-perk-access.ts",
  );
  assert.match(migration, /CREATE TABLE IF NOT EXISTS fiat_perk_access_batches/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS fiat_perk_access_operations/);
  assert.match(migration, /maxmind_risk_score numeric/);
  assert.match(migration, /access_status text NOT NULL DEFAULT 'unknown'/);
  assert.match(access, /await this\.upstream\.update\(/);
  assert.match(access, /confirmed\.enabled !== operation\.desired_enabled/);
  assert.match(access, /access_status='enabled'/);
  assert.match(access, /access_status='disabled'/);
  assert.match(access, /recoverPendingBatches/);
});

test("Fiat perk screening uses and persists every configured provider", () => {
  const service = source("services/antifraud-monitor/src/fiat-perks.ts");
  const policy = source("services/antifraud-monitor/src/fiat-perk-policy.ts");
  const migration = source(
    "services/antifraud-monitor/migrations/051_fiat_perk_provider_evidence.sql",
  );
  assert.match(service, /"selected_accounts"/);
  assert.match(service, /enrichment\.fingerprintCheck\(subject/);
  assert.match(service, /enrichment\.proxycheck\(subject/);
  assert.match(service, /enrichment\.abstractIpCheck\(subject/);
  assert.match(service, /enrichment\.abstractEmailCheck\(subject/);
  assert.match(service, /enrichment\.opportifyCheck\(subject/);
  assert.match(service, /enrichment\.maxmindCheck\(subject\)/);
  assert.match(service, /fiat_perk_candidate_provider_evidence/);
  assert.match(service, /maxmind_reason_codes/);
  assert.match(migration, /PRIMARY KEY \(candidate_id, provider\)/);
  assert.match(migration, /'abstract_email'/);
  assert.match(policy, /key: `provider_\$\{name\}`/);
  assert.match(policy, /key: "maxmind_risk"/);
  assert.match(policy, /key: "maxmind_ip_risk"/);
  assert.match(policy, /key: "maxmind_disposition"/);
});

test("Fiat perks UI exposes deep filters and single or bulk access controls", () => {
  const page = source(
    "src/app/(antifraud)/antifraud/fiat-perks/fiat-perks-client.tsx",
  );
  const actions = source(
    "src/app/(antifraud)/antifraud/fiat-perks/actions.ts",
  );
  assert.match(page, /selected_accounts/);
  assert.match(page, /MaxMind risk/);
  assert.match(page, /Provider signal key/);
  assert.match(page, /All provider evidence/);
  assert.match(page, /Sanitized provider response/);
  assert.match(page, /Enable selected/);
  assert.match(page, /Disable selected/);
  assert.match(page, /Retry failed/);
  assert.match(actions, /changeFiatAccessBatch/);
  assert.match(actions, /requireAntifraudManager/);
});

test("Fiat perk run progress uses the durable live monitor transport", () => {
  const types = source("services/antifraud-monitor/src/types.ts");
  const service = source("services/antifraud-monitor/src/fiat-perks.ts");
  const server = source("services/antifraud-monitor/src/server.ts");
  const page = source(
    "src/app/(antifraud)/antifraud/fiat-perks/fiat-perks-client.tsx",
  );
  assert.match(types, /"fiat_perk\.run\.progress"/);
  assert.match(types, /"fiat_perk\.run\.completed"/);
  assert.match(service, /provider_checks = \$2/);
  assert.match(service, /publishRun\("fiat_perk\.run\.progress"/);
  assert.match(service, /publishRun\("fiat_perk\.run\.completed"/);
  assert.match(server, /fiatPerkAccess,\s*publishCommittedMutation,/);
  assert.match(page, /useSseStream<unknown>/);
  assert.match(page, /MONITOR_STREAM_PATH/);
  assert.match(page, /RUN_LIVE_SAFETY_POLL_MS/);
});
