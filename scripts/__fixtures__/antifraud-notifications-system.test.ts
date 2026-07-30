import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(path, "utf8");

test("dashboard alert rules are opt-in, role-bound, and step-up protected", () => {
  const migration = read(
    "drizzle/admin/migrations/20260730_antifraud_notifications_system.sql",
  );
  const actions = read(
    "src/app/(antifraud)/antifraud/notifications/actions.ts",
  );
  const page = read(
    "src/app/(antifraud)/antifraud/notifications/page.tsx",
  );

  assert.match(migration, /antifraud_dashboard_notification_rules/);
  assert.doesNotMatch(
    migration,
    /INSERT INTO antifraud_dashboard_notification_rules/i,
  );
  assert.match(migration, /target_groups <@ ARRAY/);
  assert.match(actions, /requireAntifraudManager\(\)/);
  assert.match(actions, /require2FA\(session\.userId, input\.credential\)/);
  assert.match(actions, /beginAntifraudAction/);
  assert.match(actions, /finishAntifraudAction/);
  assert.match(page, /requireAntifraudManagerPage\(\)/);
});

test("Discord management stays inside exact approved categories and live markers", () => {
  const policy = read("src/lib/discord-notifications/antifraud-policy.ts");
  const config = read("src/lib/discord-notifications/config.ts");
  const workspace = read(
    "src/app/(antifraud)/antifraud/webhooks/routing-workspace.tsx",
  );
  const actions = read(
    "src/app/(antifraud)/antifraud/webhooks/actions.ts",
  );

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
  assert.match(actions, /require2FA\(session\.userId, parsed\.data\.credential\)/);
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
    "discord-command-errors",
    "general",
    "system",
    "code",
    "fail",
    "timeout",
    "webapp-errors",
  ]) {
    assert.match(policy, new RegExp(`"${destination}"`));
  }
  assert.match(discord, /alert\.lowRiskSignupReview \? \[\] : SUPPORT_USER_IDS/);
  assert.match(discord, /components:/);
  assert.match(discord, /Why it was flagged/);
});

test("audit stays manager-only and runtime config never renders secrets", () => {
  const auditMigration = read(
    "drizzle/admin/migrations/20260730_antifraud_security_audit.sql",
  );
  const auditPage = read(
    "src/app/(antifraud)/antifraud/audit/page.tsx",
  );
  const runtime = read("services/antifraud-monitor/src/runtime-config.ts");

  assert.match(auditMigration, /BEFORE UPDATE OR DELETE/);
  assert.match(auditMigration, /BEFORE TRUNCATE/);
  assert.match(auditPage, /requireAntifraudManagerPage\(\)/);
  assert.match(runtime, /fingerprintConfigured: Boolean\(/);
  assert.match(runtime, /secretConfigured: Boolean\(/);
  assert.doesNotMatch(runtime, /secretValue|tokenValue|providerPayload/);
});
