import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(path, "utf8");

test("Discord notification persistence has durable routing, leases, and dedupe", () => {
  const migration = read(
    "drizzle/admin/migrations/20260729_discord_notification_router.sql",
  );
  const router = read("src/lib/discord-notifications/router.ts");

  for (const table of [
    "discord_notification_guilds",
    "discord_notification_channels",
    "discord_notification_events",
    "discord_notification_routes",
    "discord_notification_jobs",
  ]) {
    assert.match(
      migration,
      new RegExp(`CREATE TABLE IF NOT EXISTS "${table}"`),
    );
  }
  assert.match(migration, /discord_notification_jobs_dedupe_idx/);
  assert.match(migration, /WHERE "status" IN \('pending', 'leased'\)/);
  assert.match(router, /FOR UPDATE SKIP LOCKED/);
  assert.match(router, /leased_until = now\(\) \+ interval '60 seconds'/);
  assert.match(
    router,
    /ON CONFLICT \(guild_id, event_key, dedupe_key, channel_id\) DO NOTHING/,
  );
  assert.match(router, /attempt_count >= max_attempts THEN 'dead'/);
});

test("bot API is scoped, guild-bound, and matches the worker contract", () => {
  const scopes = read("src/lib/api-auth/scopes.ts");
  const sync = read("src/app/api/v1/discord/antifraud/channels/sync/route.ts");
  const claim = read("src/app/api/v1/discord/antifraud/jobs/claim/route.ts");
  const ack = read("src/app/api/v1/discord/antifraud/jobs/[id]/ack/route.ts");
  const channelClaim = read(
    "src/app/api/v1/discord/antifraud/channel-jobs/claim/route.ts",
  );
  const channelAck = read(
    "src/app/api/v1/discord/antifraud/channel-jobs/[id]/ack/route.ts",
  );

  assert.match(scopes, /"discord:antifraud"/);
  for (const route of [sync, claim, ack, channelClaim, channelAck]) {
    assert.match(route, /scopes: \["discord:antifraud"\]/);
    assert.match(route, /process\.env\.ADMIN_GUILD_ID/);
  }
  assert.match(claim, /return \{ jobs: await claimDiscordJobs/);
  assert.match(ack, /z\.enum\(\["delivered", "failed"\]\)/);
  assert.match(channelClaim, /claimDiscordChannelCreationJobs/);
  assert.match(channelAck, /z\.enum\(\["created", "failed"\]\)/);
});

test("channel creation has a durable manager request and leased bot execution", () => {
  const migration = read(
    "drizzle/admin/migrations/20260730_discord_channel_creation.sql",
  );
  const operations = read(
    "src/lib/discord-notifications/channel-operations.ts",
  );
  const actions = read("src/app/(antifraud)/antifraud/discord/actions.ts");

  assert.match(migration, /discord_notification_channel_settings/);
  assert.match(migration, /discord_notification_channel_jobs/);
  assert.match(migration, /WHERE "status" IN \('pending', 'leased'\)/);
  assert.match(operations, /FOR UPDATE SKIP LOCKED/);
  assert.match(operations, /type = 'category'/);
  assert.match(operations, /parent\.position > boundary_top\.position/);
  assert.match(operations, /parent\.position < boundary_bottom\.position/);
  assert.match(
    operations,
    /boundary_top\.position < boundary_bottom\.position/,
  );
  assert.match(operations, /leased_until = now\(\) \+ interval '60 seconds'/);
  assert.match(actions, /requireAntifraudManager\(\)/);
  assert.match(actions, /queueDiscordChannelCreation/);
});

test("an event belongs to exactly one Discord channel", () => {
  const config = read("src/lib/discord-notifications/config.ts");
  const workspace = read(
    "src/app/(antifraud)/antifraud/discord/routing-workspace.tsx",
  );

  // The per-channel replace stays serialized per guild, and it refuses an
  // event another channel already claims instead of fanning it out.
  assert.match(config, /pg_advisory_xact_lock/);
  assert.match(config, /route\.channel_id <> \$\{channelId\}/);
  assert.match(config, /Remove it there first/);
  // The picker hides claimed events rather than offering them again.
  assert.match(workspace, /claimedElsewhere/);
  assert.doesNotMatch(workspace, /Also sent to/);
});

test("approved Discord categories moved outside the live boundary are rejected", () => {
  const router = read("src/lib/discord-notifications/router.ts");
  const operations = read(
    "src/lib/discord-notifications/channel-operations.ts",
  );

  for (const source of [router, operations]) {
    assert.match(source, /boundary_top\.channel_id/);
    assert.match(source, /boundary_bottom\.channel_id/);
    assert.match(source, /parent\.position > boundary_top\.position/);
    assert.match(source, /parent\.position < boundary_bottom\.position/);
    assert.match(source, /boundary_top\.position < boundary_bottom\.position/);
  }
});

test("monitor enqueue is bounded, signed, replay-safe, and webhook-free", () => {
  const receiver = read("src/app/api/antifraud/discord-events/route.ts");
  const sender = read("services/antifraud-monitor/src/discord-events.ts");
  const monitorConfig = read("services/antifraud-monitor/src/config.ts");

  assert.match(receiver, /MAX_SKEW_MS = 5 \* 60 \* 1000/);
  assert.match(receiver, /MAX_BODY_BYTES = 64 \* 1024/);
  assert.match(receiver, /timingSafeEqual/);
  assert.match(receiver, /x-antifraud-signature/);
  assert.match(sender, /createHmac\("sha256"/);
  assert.match(sender, /\/api\/antifraud\/discord-events/);
  assert.doesNotMatch(monitorConfig, /DISCORD_WEBHOOK_URL/);
});

test("errors and KYC channels post without tagging anyone", () => {
  const policy = read("src/lib/discord-notifications/antifraud-policy.ts");
  const router = read("src/lib/discord-notifications/router.ts");

  assert.match(policy, /SILENT_DISCORD_CATEGORY_IDS/);
  assert.match(policy, /APPROVED_DISCORD_CATEGORIES\.errors/);
  assert.match(policy, /APPROVED_DISCORD_CATEGORIES\.kyc/);
  // The mention content is dropped at enqueue, so no routing change can
  // reintroduce a ping in those categories.
  assert.match(
    router,
    /eligible\.parent_id IN \(\$\{silentCategoryIds\(\)\}\) THEN NULL/,
  );
});

test("rain reward-abuse batches notify Support only", () => {
  const policy = read("src/lib/discord-notifications/antifraud-policy.ts");
  const policySql = read("src/lib/discord-notifications/policy-sql.ts");
  const router = read("src/lib/discord-notifications/router.ts");

  assert.match(policy, /"antifraud\.reward_abuse_rain": \["support"\]/);
  assert.match(router, /discordEventMentionGroupOverride\(key\)/);
  assert.match(
    router,
    /CROSS JOIN \(VALUES \$\{mentionGroupKeyRows\(mentionGroupOverride\)\}\)/,
  );
  assert.match(policySql, /export function mentionGroupKeyRows/);
  assert.match(router, /jsonb_agg\(DISTINCT member\.user_id\) AS user_ids/);
  assert.match(router, /'users', mentions\.user_ids/);
});

test("error routing uses only the four surviving channels", () => {
  const originalMigration = read(
    "drizzle/admin/migrations/20260805_consolidate_error_discord_routing.sql",
  );
  const cleanupMigration = read(
    "drizzle/admin/migrations/20260812_discord_notification_routing_cleanup.sql",
  );
  const router = read("src/lib/discord-notifications/router.ts");
  const webapp = read("src/app/api/antifraud/webapp-errors/route.ts");
  const provider = read(
    "services/antifraud-monitor/src/provider-access-alerts.ts",
  );

  for (const channelId of ["1532248855133945956", "1532249079999103077"]) {
    assert.match(originalMigration, new RegExp(channelId));
  }
  for (const channelId of ["1536858616810704957", "1536858608132690040"]) {
    assert.match(cleanupMigration, new RegExp(channelId));
  }
  for (const retired of [
    "code",
    "failed_action",
    "provider_access",
    "system",
    "timeout",
  ]) {
    assert.match(
      originalMigration,
      new RegExp(`antifraud\\.error\\.${retired}`),
    );
  }
  assert.match(router, /canonicalDiscordEventKey/);
  assert.match(router, /normalized\.startsWith\("antifraud\.error\."\)/);
  assert.match(webapp, /name: "Webapp"/);
  assert.match(webapp, /name: "Server"/);
  assert.match(webapp, /verifySession\(\)/);
  assert.match(provider, /eventKey: "antifraud\.error\.third_party_api"/);
  assert.match(provider, /kind: "request_failed"/);
  assert.match(provider, /server: "Antifraud monitor · Railway production"/);
});

test("KYC requirements enqueue account review cards to the KYC route", () => {
  const producer = read("src/lib/discord-notifications/kyc-required.ts");
  const cleanupMigration = read(
    "drizzle/admin/migrations/20260812_discord_notification_routing_cleanup.sql",
  );
  const antifraudAction = read("src/app/(antifraud)/antifraud/kyc/actions.ts");
  const userAction = read("src/app/(admin)/users/[id]/kyc-actions.ts");

  assert.match(producer, /eventKey: "antifraud\.kyc_required"/);
  assert.match(producer, /KYC account review required/);
  assert.match(
    cleanupMigration,
    /'antifraud\.kyc_required', '1532298371052867634'/,
  );
  assert.match(antifraudAction, /enqueueKycRequiredReview/);
  assert.match(userAction, /requireAccountKyc/);
  assert.match(userAction, /reviewAccountKyc/);
  assert.match(userAction, /credential: string/);
});

test("KYC lifecycle notifications are cursor-backed and route failures stay retryable", () => {
  const lifecycle = read("src/lib/discord-notifications/kyc-lifecycle.ts");
  const started = read("src/lib/discord-notifications/sumsub-started.ts");
  const tick = read("src/app/api/antifraud/ops/tick/route.ts");
  const receiver = read("src/app/api/antifraud/discord-events/route.ts");
  const migration = read(
    "drizzle/admin/migrations/20260812_kyc_notification_reliability.sql",
  );

  assert.match(
    migration,
    /CREATE TABLE IF NOT EXISTS kyc_notification_cursors/,
  );
  assert.match(migration, /antifraud\.sumsub_started/);
  assert.match(migration, /antifraud\.sumsub_ready/);
  for (const producer of [lifecycle, started]) {
    assert.match(producer, /ORDER BY .* ASC/);
    assert.match(producer, /kyc_notification_cursors/);
    assert.match(producer, /enqueued \+ result\.duplicate === 0/);
  }
  assert.match(lifecycle, /last_webhook_digest/);
  assert.match(tick, /reconcileKycLifecycleNotifications\(\)/);
  assert.match(tick, /assertKycNotificationDeliveryHealthy\(\)/);
  assert.match(tick, /kyc\.notification_tick_failures/);
  assert.doesNotMatch(tick, /enqueueSumsubVerificationStarts\(\)\.catch/);
  assert.match(receiver, /error: "no_eligible_route"/);
});
