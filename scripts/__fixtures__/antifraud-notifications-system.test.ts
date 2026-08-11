import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(path, "utf8");

test("Fraud dashboard inbox and its rule storage are removed", () => {
  const sidebar = read(
    "src/app/(antifraud)/antifraud/_components/antifraud-sidebar.tsx",
  );
  const migration = read(
    "drizzle/admin/migrations/20260805_drop_antifraud_dashboard_inbox.sql",
  );

  for (const path of [
    "src/app/(antifraud)/antifraud/notifications/page.tsx",
    "src/app/(antifraud)/antifraud/notifications/actions.ts",
    "src/lib/antifraud/dashboard-notification-contract.ts",
    "src/lib/antifraud/dashboard-notification-rules.ts",
  ]) {
    assert.equal(existsSync(path), false, `${path} must stay removed`);
  }
  assert.doesNotMatch(sidebar, /Dashboard inbox|\/antifraud\/notifications/);
  assert.match(
    migration,
    /DROP TABLE IF EXISTS antifraud_dashboard_notification_rules/i,
  );
});

test("Discord management stays inside exact approved categories and live markers", () => {
  const policy = read("src/lib/discord-notifications/antifraud-policy.ts");
  const config = read("src/lib/discord-notifications/config.ts");
  const workspace = read(
    "src/app/(antifraud)/antifraud/discord/routing-workspace.tsx",
  );
  const actions = read("src/app/(antifraud)/antifraud/discord/actions.ts");
  const router = read("src/lib/discord-notifications/router.ts");
  const ingest = read("src/app/api/antifraud/discord-events/route.ts");

  for (const id of [
    "1532207307683795026",
    "1532207461077876766",
    "1532216500444856360",
    "1532297417339174922",
    "1532206965915390063",
    "1532206977286017154",
  ]) {
    assert.match(policy, new RegExp(id));
  }
  assert.match(config, /parent\.position > boundary_top\.position/);
  assert.match(config, /parent\.position < boundary_bottom\.position/);
  assert.match(config, /boundary_top\.position < boundary_bottom\.position/);
  assert.match(workspace, /APPROVED_DISCORD_CATEGORY_IDS/);
  assert.match(workspace, /DISCORD_MENTION_GROUPS/);
  assert.match(workspace, /isSilentDiscordCategory/);
  assert.match(workspace, /mentionGroupKeys/);
  assert.match(workspace, /onToggleMentionGroup/);
  assert.match(workspace, /Nobody tagged|never tag anyone/);
  assert.doesNotMatch(router, /\bescalate\b/);
  assert.doesNotMatch(ingest, /parsed\.data\.escalate/);
  assert.match(
    actions,
    /require2FA\(session\.userId, parsed\.data\.credential\)/,
  );
});

test("Discord recipients and error destinations match the owner contract", () => {
  const policy = read("src/lib/discord-notifications/antifraud-policy.ts");
  const discord = read("services/antifraud-monitor/src/discord.ts");

  for (const id of [
    "660132586630414338",
    "276098533629755392",
    "188051599099297802",
    "934854938641715240",
    "617341813296070684",
    "1302882250391818311",
    "976564661820481606",
    "620373461256110112",
  ]) {
    assert.match(policy + discord, new RegExp(id));
  }
  for (const destination of [
    "third-party-api",
    "discord-errors",
    "general-errors",
    "webapp-errors",
  ]) {
    assert.match(policy, new RegExp(`"${destination}"`));
  }
  // Producers cannot add recipients: the channel selection is the complete
  // policy even when the alert is urgent.
  assert.doesNotMatch(discord, /escalate:/);
  assert.doesNotMatch(policy, /DISCORD_ESCALATION_GROUP_KEYS/);
  // The compiled-in recipient arrays are gone; only prose may mention them.
  assert.doesNotMatch(discord, /^export const SUPPORT_USER_IDS/m);
  assert.match(discord, /components:/);
  assert.match(discord, /Why it was flagged/);
  assert.match(discord, /SIGNUP_RISK_FIELD_NAMES\.time/);
});

test("Fiat credit reviews own a dedicated deposits-channel action", () => {
  const alerts = read("services/antifraud-monitor/src/fiat-alerts.ts");
  const migration = read(
    "drizzle/admin/migrations/20260809_fiat_credit_review_discord_event.sql",
  );
  const mentions = read(
    "drizzle/admin/migrations/20260812_deposits_support_mentions.sql",
  );

  assert.match(alerts, /problemCode === "review"/);
  assert.match(alerts, /antifraud\.fiat_credit_review_required/);
  assert.match(alerts, /Open Deposit Reviews/);
  assert.match(migration, /antifraud\.fiat_credit_review_required/);
  assert.match(migration, /1535849236447625266/);
  assert.match(migration, /1532207461077876766/);
  assert.match(mentions, /1535849236447625266/);
  assert.match(mentions, /1532207461077876766/);
  assert.match(mentions, /antifraud\.fiat_credit_review_required/);
  assert.match(mentions, /'support'/);
  assert.match(mentions, /ON CONFLICT \(guild_id, channel_id, group_key\) DO NOTHING/);
});

test("audit stays manager-only and runtime config never renders secrets", () => {
  const auditMigration = read(
    "drizzle/admin/migrations/20260730_antifraud_security_audit.sql",
  );
  const auditPage = read("src/app/(antifraud)/antifraud/audit/page.tsx");
  const runtime = read("services/antifraud-monitor/src/runtime-config.ts");

  assert.match(auditMigration, /BEFORE UPDATE OR DELETE/);
  assert.match(auditMigration, /BEFORE TRUNCATE/);
  assert.match(auditPage, /requireAntifraudManagerPage\(\)/);
  assert.match(runtime, /fingerprintConfigured: Boolean\(/);
  assert.match(runtime, /secretConfigured: Boolean\(/);
  assert.doesNotMatch(runtime, /secretValue|tokenValue|providerPayload/);
});
