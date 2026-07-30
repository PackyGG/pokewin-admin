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
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS "${table}"`));
  }
  assert.match(migration, /discord_notification_jobs_dedupe_idx/);
  assert.match(migration, /WHERE "status" IN \('pending', 'leased'\)/);
  assert.match(router, /FOR UPDATE SKIP LOCKED/);
  assert.match(router, /leased_until = now\(\) \+ interval '60 seconds'/);
  assert.match(router, /ON CONFLICT \(guild_id, event_key, dedupe_key, channel_id\) DO NOTHING/);
  assert.match(router, /attempt_count >= max_attempts THEN 'dead'/);
});

test("bot API is scoped, guild-bound, and matches the worker contract", () => {
  const scopes = read("src/lib/api-auth/scopes.ts");
  const sync = read(
    "src/app/api/v1/discord/antifraud/channels/sync/route.ts",
  );
  const claim = read(
    "src/app/api/v1/discord/antifraud/jobs/claim/route.ts",
  );
  const ack = read(
    "src/app/api/v1/discord/antifraud/jobs/[id]/ack/route.ts",
  );
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
  const actions = read(
    "src/app/(antifraud)/antifraud/webhooks/actions.ts",
  );

  assert.match(migration, /discord_notification_channel_settings/);
  assert.match(migration, /discord_notification_channel_jobs/);
  assert.match(migration, /WHERE "status" IN \('pending', 'leased'\)/);
  assert.match(operations, /FOR UPDATE SKIP LOCKED/);
  assert.match(operations, /type = 'category'/);
  assert.match(operations, /parent\.position > boundary_top\.position/);
  assert.match(operations, /parent\.position < boundary_bottom\.position/);
  assert.match(operations, /boundary_top\.position < boundary_bottom\.position/);
  assert.match(operations, /leased_until = now\(\) \+ interval '60 seconds'/);
  assert.match(actions, /requireAntifraudManager\(\)/);
  assert.match(actions, /queueDiscordChannelCreation/);
});

test("an enabled event can only be assigned to one Discord channel", () => {
  const config = read("src/lib/discord-notifications/config.ts");
  const workspace = read(
    "src/app/(antifraud)/antifraud/webhooks/routing-workspace.tsx",
  );

  assert.match(config, /pg_advisory_xact_lock/);
  assert.match(config, /route\.channel_id <> \$\{channelId\}/);
  assert.match(config, /Remove it there first/);
  assert.match(workspace, /assignedElsewhere/);
  assert.match(workspace, /!assignedElsewhere\.has\(event\.key\)/);
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
  const sender = read(
    "services/antifraud-monitor/src/discord-events.ts",
  );
  const monitorConfig = read(
    "services/antifraud-monitor/src/config.ts",
  );

  assert.match(receiver, /MAX_SKEW_MS = 5 \* 60 \* 1000/);
  assert.match(receiver, /MAX_BODY_BYTES = 64 \* 1024/);
  assert.match(receiver, /timingSafeEqual/);
  assert.match(receiver, /x-antifraud-signature/);
  assert.match(sender, /createHmac\("sha256"/);
  assert.match(sender, /\/api\/antifraud\/discord-events/);
  assert.doesNotMatch(monitorConfig, /DISCORD_WEBHOOK_URL/);
});
