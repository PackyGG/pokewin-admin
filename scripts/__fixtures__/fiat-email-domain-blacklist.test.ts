import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

test("verified Fraud users edit durable email blacklist rules with reasons", () => {
  const sidebar = read(
    "src/app/(antifraud)/antifraud/_components/antifraud-sidebar.tsx",
  );
  const hosts = read("src/lib/app-hosts.ts");
  const page = read(
    "src/app/(antifraud)/antifraud/email-blacklist/page.tsx",
  );
  const actions = read(
    "src/app/(antifraud)/antifraud/email-blacklist/actions.ts",
  );

  assert.match(sidebar, /SidebarGroupLabel>System/);
  assert.match(sidebar, /\/antifraud\/email-blacklist/);
  assert.match(hosts, /"email-blacklist"/);
  assert.match(page, /requireAntifraudPageAccess/);
  assert.match(actions, /requireAntifraudAccess/);
  assert.match(actions, /fiat_email_domain_blacklisted/);
  const client = read(
    "src/app/(antifraud)/antifraud/email-blacklist/email-blacklist-client.tsx",
  );
  assert.match(client, /email-domain-reason/);
  assert.match(client, /Optional expiry/);
  assert.match(client, /window\.confirm/);
  assert.match(page, /key=\{result\.data/);
  assert.match(page, /rule\.updatedAt/);
  assert.match(client, /isCheckingHistory/);
  assert.match(client, /setInterval\(\(\) => router\.refresh\(\), 3_000\)/);
});

test("blacklisted domains ban while patterns and clusters lock without automatic KYC", () => {
  const monitor = read(
    "services/antifraud-monitor/src/fiat-email-domains.ts",
  );
  const ingest = read("src/app/api/antifraud/ingest/route.ts");
  const client = read(
    "src/app/(antifraud)/antifraud/email-blacklist/email-blacklist-client.tsx",
  );

  assert.match(monitor, /INSERT INTO risk_events/);
  assert.match(monitor, /fiat_blacklisted_email_domain/);
  assert.match(monitor, /persistSignupMatch/);
  assert.match(monitor, /suspiciousGmailDotPattern/);
  assert.match(monitor, /gmail_dot_fragmentation/);
  assert.match(monitor, /suspiciousGmailClusterCandidate/);
  assert.match(monitor, /suspicious_deposit_cluster/);
  assert.match(monitor, /account_identity/);
  assert.match(monitor, /data,user,id/);
  assert.match(monitor, /payment_identity/);
  assert.doesNotMatch(monitor, /card_last4 ~ '\^\[0-9\]\{4\}\$'/);
  assert.match(monitor, /cluster_source_event_ids/);
  assert.match(monitor, /interval '30 minutes'/);
  assert.match(monitor, /provider_payment_id/);
  assert.match(monitor, /match_source: "signup"/);
  assert.match(monitor, /\{ reviewOnly: true \}/);
  assert.match(monitor, /Staff review is required; no automatic account action was taken/);
  assert.doesNotMatch(monitor, /UPDATE user_feature_locks/);
  assert.match(ingest, /getProdPrimaryDrizzleDb/);
  assert.match(ingest, /ARRAY\['all'\]::text\[\]/);
  assert.match(ingest, /locked_withdrawals_items = TRUE/);
  assert.match(ingest, /signal\.riskScore !== 100/);
  assert.match(ingest, /suspicious dot-fragmented Gmail address/);
  assert.match(ingest, /suspicious coordinated deposit cluster/);
  assert.match(ingest, /emailRiskType === "blacklisted_domain"/);
  assert.match(ingest, /is_banned = TRUE/);
  assert.match(ingest, /DELETE FROM session/);
  assert.match(ingest, /blockedDomainMatch \? "banned" : "locked"/);
  assert.match(ingest, /signal\.payload\?\.reviewOnly !== true/);
  assert.doesNotMatch(ingest, /requireUserKyc|getUserKyc/);
  assert.match(ingest, /pg_advisory_xact_lock/);
  assert.match(ingest, /antifraud-containment:/);
  assert.match(
    client,
    /automatically banned and sent to staff review/,
  );
});

test("Fraud Fiat deposits force blacklist matches to the critical score", () => {
  const risk = read("services/antifraud-monitor/src/fiat-risk.ts");

  assert.match(risk, /blacklisted_checkout_email_domain/);
  assert.match(risk, /suspicious_checkout_email_pattern/);
  assert.match(risk, /suspicious_deposit_cluster/);
  assert.match(risk, /riskScore: 100/);
  assert.match(risk, /verdict: "bad"/);
  assert.match(risk, /Keep crypto and item withdrawals locked/);
});

test("email blacklist alerts have a dedicated bot event destination", () => {
  const config = read("services/antifraud-monitor/src/config.ts");
  const alerts = read("services/antifraud-monitor/src/fiat-alerts.ts");
  const transport = read(
    "services/antifraud-monitor/src/discord-events.ts",
  );

  assert.match(config, /ADMIN_GUILD_ID/);
  assert.match(alerts, /case "email_blacklist":/);
  assert.match(alerts, /antifraud\.email_blacklist/);
  assert.match(alerts, /sendBotDiscordEvent/);
  assert.match(transport, /\/api\/antifraud\/discord-events/);
  assert.match(transport, /x-antifraud-signature/);
  assert.doesNotMatch(config, /DISCORD_WEBHOOK_URL/);
});
