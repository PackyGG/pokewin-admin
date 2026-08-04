import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string) => readFile(path, "utf8");

test("VIP channel links preview MAIN users and persist only in Admin", async () => {
  const [
    previewRoute,
    linkRoute,
    dashboardContextRoute,
    operators,
    service,
    migration,
    memberMigration,
    scopes,
    endpoints,
  ] = await Promise.all([
    read("src/app/api/v1/discord/vips/link-preview/route.ts"),
    read("src/app/api/v1/discord/vips/link/route.ts"),
    read("src/app/api/v1/discord/vips/dashboard-context/route.ts"),
    read("src/lib/discord-dashboard-operators.ts"),
    read("src/lib/discord-vip-channel-links.ts"),
    read(
      "drizzle/admin/migrations/20260730_discord_vip_channel_links.sql",
    ),
    read(
      "drizzle/admin/migrations/20260804_discord_vip_member_links.sql",
    ),
    read("src/lib/api-auth/scopes.ts"),
    read("src/lib/api-auth/endpoints.ts"),
  ]);

  assert.match(previewRoute, /scopes: \["discord:vips:link"\]/);
  assert.match(linkRoute, /scopes: \["discord:vips:link"\]/);
  assert.match(dashboardContextRoute, /scopes: \["discord:vips:link"\]/);
  assert.match(dashboardContextRoute, /getVipDashboardContext/);
  assert.match(dashboardContextRoute, /guildId !== VIPS_GUILD_ID/);
  assert.match(service, /isDiscordDashboardOperator\(input\.actorDiscordUserId\)/);
  assert.match(operators, /"660132586630414338"/);
  assert.match(operators, /"934854938641715240"/);
  assert.match(operators, /"188051599099297802"/);
  assert.match(previewRoute, /guildId !== VIPS_GUILD_ID/);
  assert.match(linkRoute, /guildId !== VIPS_GUILD_ID/);
  assert.match(
    previewRoute,
    /guildId: DiscordIdSchema[\s\S]*channelId: DiscordIdSchema[\s\S]*memberDiscordUserId: DiscordIdSchema\.optional\(\)[\s\S]*userId: UserIdSchema[\s\S]*actorDiscordUserId: DiscordIdSchema/,
  );
  assert.match(
    linkRoute,
    /guildId: DiscordIdSchema[\s\S]*channelId: DiscordIdSchema[\s\S]*memberDiscordUserId: DiscordIdSchema\.optional\(\)[\s\S]*userId:[\s\S]*actorDiscordUserId: DiscordIdSchema[\s\S]*interactionId: DiscordIdSchema/,
  );

  assert.match(service, /VIPS_GUILD_ID = "1505650386894327919"/);
  assert.match(service, /getProdReadDrizzleDb/);
  assert.match(service, /previewVipChannelLink/);
  assert.match(service, /saveVipChannelLink/);
  assert.match(service, /FROM discord_vip_channel_links/);
  assert.match(service, /INSERT INTO discord_vip_channel_links/);
  assert.match(service, /UPDATE discord_vip_channel_links/);
  assert.match(service, /discord_vip_channel_link_operations/);
  assert.match(service, /channel_link_conflict/);
  assert.match(service, /discord_member_link_conflict/);
  assert.match(service, /idempotency_conflict/);
  assert.match(service, /INSERT INTO admin_user_tags/);
  assert.match(service, /ON CONFLICT \(target_user_id, tag\) DO NOTHING/);
  assert.match(service, /member_discord_user_id/);
  assert.match(service, /vipTagAdded/);
  assert.match(service, /discord_vip_channel_linked/);
  assert.doesNotMatch(service, /getProdWrite|MAIN_DATABASE_URL/);

  assert.match(migration, /CREATE TABLE IF NOT EXISTS "discord_vip_channel_links"/);
  assert.match(
    migration,
    /discord_vip_channel_links_guild_user_unique/,
  );
  assert.match(
    migration,
    /discord_vip_channel_links_guild_channel_unique/,
  );
  assert.match(
    migration,
    /CREATE TABLE IF NOT EXISTS "discord_vip_channel_link_operations"/,
  );
  assert.match(migration, /interaction_id" text PRIMARY KEY/);
  assert.match(memberMigration, /ADD COLUMN IF NOT EXISTS "member_discord_user_id"/);
  assert.match(memberMigration, /ADD COLUMN IF NOT EXISTS "vip_tag_added"/);
  assert.match(memberMigration, /discord_vip_channel_links_guild_member_unique/);

  assert.match(scopes, /"discord:vips:link"/);
  assert.match(endpoints, /\/api\/v1\/discord\/vips\/link-preview/);
  assert.match(endpoints, /\/api\/v1\/discord\/vips\/dashboard-context/);
  assert.match(endpoints, /\/api\/v1\/discord\/vips\/link"/);
});
