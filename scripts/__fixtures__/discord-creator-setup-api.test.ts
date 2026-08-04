import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string) => readFile(path, "utf8");

test("creator setup API is guild-pinned, scoped, and transactionally idempotent", async () => {
  const [service, superusers, prepare, complete, repair, cancel, link, stats, deal, rewards, migration, linkMigration, scopes, endpoints] =
    await Promise.all([
      read("src/lib/discord-creator-setups.ts"),
      read("src/lib/discord-bot-superusers.ts"),
      read("src/app/api/v1/discord/creator-setups/prepare/route.ts"),
      read("src/app/api/v1/discord/creator-setups/complete/route.ts"),
      read("src/app/api/v1/discord/creator-setups/repair/route.ts"),
      read("src/app/api/v1/discord/creator-setups/cancel/route.ts"),
      read("src/app/api/v1/discord/creator-setups/link/route.ts"),
      read("src/app/api/v1/discord/creator-setups/stats/route.ts"),
      read("src/app/api/v1/discord/creator-setups/deal/route.ts"),
      read("src/app/api/v1/discord/creator-setups/rewards/route.ts"),
      read(
        "drizzle/admin/migrations/20260729_discord_creator_setups.sql",
      ),
      read(
        "drizzle/admin/migrations/20260729_link_discord_creator_setups.sql",
      ),
      read("src/lib/api-auth/scopes.ts"),
      read("src/lib/api-auth/endpoints.ts"),
    ]);
  const prepareService = service.slice(
    service.indexOf("export async function prepareCreatorSetup"),
    service.indexOf("export async function completeCreatorSetup"),
  );

  assert.match(service, /CREATOR_SETUP_GUILD_ID = "1402743122789929022"/);
  assert.match(superusers, /"660132586630414338"/);
  assert.match(superusers, /"934854938641715240"/);
  assert.match(service, /isDiscordBotSuperuser\(input\.actorDiscordUserId\)/);
  assert.doesNotMatch(prepareService, /getProdReadDrizzleDb\(\)/);
  assert.doesNotMatch(prepareService, /requireActiveCreator/);
  assert.doesNotMatch(prepareService, /creator_not_found/);
  assert.match(service, /creator_discord_user_id/);
  assert.match(service, /pg_advisory_xact_lock/);
  assert.match(service, /INTERVAL '15 minutes'/);
  assert.match(service, /FOR UPDATE/);
  assert.match(service, /status = 'active'/);
  assert.match(service, /status = 'pending'/);

  for (const route of [prepare, complete, repair, cancel, link, stats, deal, rewards]) {
    assert.match(route, /scopes: \["discord:creator:setup"\]/);
  }
  assert.match(prepare, /rejectWrongGuild/);
  assert.match(complete, /rejectWrongGuild/);
  assert.match(repair, /rejectWrongGuild/);
  assert.match(repair, /principal\.keyId/);
  assert.match(repair, /previousCategoryId: DiscordIdSchema/);
  assert.match(cancel, /cancelCreatorSetup/);
  assert.match(link, /rejectWrongGuild/);
  assert.match(link, /creatorUserId[\s\S]*\^\[A-Za-z0-9_-\]\+\$/);
  assert.match(link, /actorDiscordUserId: DiscordIdSchema/);
  assert.match(link, /principal\.keyId/);
  assert.match(stats, /getCreatorSetupStats/);
  assert.match(stats, /rejectWrongGuild/);
  assert.match(deal, /getCreatorSetupDeal/);
  assert.match(deal, /rejectWrongGuild/);
  assert.match(service, /creatorsApi\.listDeals\(setup\.creator_user_id/);
  assert.match(service, /deal\.status === "active"/);
  assert.match(service, /deal\.status === "scheduled"/);
  assert.match(service, /total_withdraw_cap_usd/);
  assert.match(service, /max_sponsorship_per_stream_usd/);
  assert.match(rewards, /getCreatorSetupRewards/);
  assert.match(rewards, /rejectWrongGuild/);
  assert.match(service, /creator_reward_programs/);
  assert.match(service, /creator_reward_programs\.is_active, true/);
  assert.match(service, /thresholdUsd/);
  assert.match(service, /vipRewardUsd/);
  assert.match(service, /lossbackPct/);
  assert.match(service, /maxRewardPerUserUsd/);

  assert.match(migration, /CREATE TABLE IF NOT EXISTS "discord_creator_setups"/);
  assert.match(migration, /UNIQUE \("guild_id", "creator_discord_user_id"\)/);
  assert.match(migration, /"interaction_id" TEXT NOT NULL UNIQUE/);
  assert.match(migration, /discord_creator_setups_active_shape_check/);
  assert.match(linkMigration, /ADD COLUMN IF NOT EXISTS "creator_user_id" TEXT/);
  assert.match(linkMigration, /discord_creator_setups_creator_user_id_check/);
  assert.match(linkMigration, /discord_creator_setups_link_shape_check/);
  assert.match(
    linkMigration,
    /discord_creator_setups_guild_creator_user_unique/,
  );
  assert.match(
    linkMigration,
    /discord_creator_setups_link_interaction_unique/,
  );
  assert.match(service, /chat_channel_id = \$\{input\.channelId\}/);
  assert.match(service, /logs_channel_id = \$\{input\.channelId\}/);
  assert.match(service, /input\.actorDiscordUserId !== setup\.creator_discord_user_id/);
  assert.match(service, /input\.actorDiscordUserId !== setup\.created_by_discord_user_id/);
  assert.match(service, /await creatorsApi\.promote\(creatorUserId\)/);
  assert.match(service, /if \(!allowGrant\)/);
  assert.match(
    service,
    /ensureActiveCreator\(\s*input\.creatorUserId,\s*isDiscordBotSuperuser\(input\.actorDiscordUserId\)/,
  );
  assert.match(
    service,
    /promoted\.user_id !== creatorUserId[\s\S]*promoted\.role !== "creator"/,
  );
  assert.match(service, /event_type: "discord_creator_role_granted"/);
  assert.match(service, /eq\(user\.id,\s*creatorUserId\)/);
  assert.match(
    service,
    /await requireDiscordOwnership\(\s*setup\.creator_discord_user_id,\s*input\.creatorUserId/,
  );
  assert.doesNotMatch(
    service,
    /requireDiscordOwnership\(\s*input\.actorDiscordUserId/,
  );
  assert.match(service, /creatorRoleGranted: roleGranted/);
  assert.match(service, /"creator_mismatch"/);
  assert.match(service, /"discord_link_missing"/);
  assert.match(service, /eq\(account\.userId, creatorUserId\)/);
  assert.match(service, /creatorDiscordAccounts\.length > 1/);
  assert.match(service, /\.limit\(3\)/);
  assert.match(service, /roleGranted: !promoted\.already_creator/);
  assert.match(service, /"setup_actor_forbidden"/);
  assert.match(service, /"setup_link_conflict"/);
  assert.match(service, /"idempotency_conflict"/);
  assert.match(service, /export async function repairCreatorSetup/);
  assert.match(service, /alreadyRepaired/);
  assert.match(service, /category_id = \$\{input\.previousCategoryId\}/);
  assert.match(service, /event_type: "discord_creator_setup_repaired"/);
  assert.match(
    service,
    /status: "already_linked" as const,\s*setup: linkedSetup/s,
  );
  assert.match(
    service,
    /return \{ status: "linked" as const, setup: linkedSetup\(linked\) \}/,
  );
  assert.match(service, /event_type: "discord_creator_setup_linked"/);
  assert.match(service, /admin_user_id: null/);
  assert.match(scopes, /"discord:creator:setup"/);
  assert.match(endpoints, /\/api\/v1\/discord\/creator-setups\/prepare/);
  assert.match(endpoints, /\/api\/v1\/discord\/creator-setups\/complete/);
  assert.match(endpoints, /\/api\/v1\/discord\/creator-setups\/repair/);
  assert.match(endpoints, /\/api\/v1\/discord\/creator-setups\/cancel/);
  assert.match(endpoints, /\/api\/v1\/discord\/creator-setups\/link/);
  assert.match(endpoints, /\/api\/v1\/discord\/creator-setups\/stats/);
  assert.match(endpoints, /\/api\/v1\/discord\/creator-setups\/deal/);
  assert.match(endpoints, /\/api\/v1\/discord\/creator-setups\/rewards/);
});

test("creator activity notifications default on, are durable, and creator-guild pinned", async () => {
  const [service, signupService, readSettings, updateSettings, claim, ack, signupAck,
    migration, signupMigration, endpoints] =
    await Promise.all([
      read("src/lib/discord-creator-deposits.ts"),
      read("src/lib/discord-creator-signups.ts"),
      read("src/app/api/v1/discord/creator-setups/deposit-settings/route.ts"),
      read("src/app/api/v1/discord/creator-setups/deposit-settings/update/route.ts"),
      read("src/app/api/v1/discord/creator-deposits/jobs/claim/route.ts"),
      read("src/app/api/v1/discord/creator-deposits/jobs/[id]/ack/route.ts"),
      read("src/app/api/v1/discord/creator-signups/jobs/[id]/ack/route.ts"),
      read("drizzle/admin/migrations/20260730_creator_deposit_notifications.sql"),
      read("drizzle/admin/migrations/20260804_creator_signup_notifications.sql"),
      read("src/lib/api-auth/endpoints.ts"),
    ]);

  for (const route of [readSettings, updateSettings, claim, ack, signupAck]) {
    assert.match(route, /scopes: \["discord:creator:setup"\]/);
  }
  assert.match(readSettings, /getCreatorDepositSettings/);
  assert.match(updateSettings, /updateCreatorDepositSettings/);
  assert.match(updateSettings, /principal\.keyId/);
  assert.match(claim, /claimCreatorDepositJobs/);
  assert.match(claim, /claimCreatorSignupJobs/);
  assert.match(claim, /CREATOR_SETUP_GUILD_ID/);
  assert.match(ack, /acknowledgeCreatorDepositJob/);
  assert.match(ack, /CREATOR_SETUP_GUILD_ID/);
  assert.match(signupAck, /acknowledgeCreatorSignupJob/);

  assert.match(migration, /"deposit_notifications_enabled" BOOLEAN NOT NULL DEFAULT false/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "discord_creator_deposit_jobs"/);
  assert.match(migration, /"source_deposit_id" UUID NOT NULL/);
  assert.match(migration, /discord_creator_deposit_scan_state/);
  assert.match(signupMigration, /ALTER COLUMN "deposit_notifications_enabled" SET DEFAULT true/);
  assert.match(signupMigration, /"deposit_notifications_updated_at" IS NULL/);
  assert.match(signupMigration, /CREATE TABLE IF NOT EXISTS "discord_creator_signup_jobs"/);
  assert.match(signupMigration, /discord_creator_signup_scan_state/);
  assert.match(service, /deposit\.status = 'completed'/);
  assert.match(service, /deposit\.amount::numeric > 0/);
  assert.match(service, /INTERVAL '7 days'/);
  assert.match(service, /deposit_notifications_enabled_at <= source\."occurredAt"/);
  assert.match(service, /ON CONFLICT \(source_deposit_id\) DO NOTHING/);
  assert.match(service, /FOR UPDATE OF job SKIP LOCKED/);
  assert.match(service, /event_type: input\.enabled/);
  assert.doesNotMatch(service, /getProdWrite/);
  assert.match(signupService, /usage\.usage_type::text = 'signup'/);
  assert.match(signupService, /usage\.status::text = 'completed'/);
  assert.match(signupService, /ON CONFLICT \(source_signup_id\) DO NOTHING/);
  assert.match(signupService, /FOR UPDATE OF job SKIP LOCKED/);
  assert.doesNotMatch(signupService, /getProdWrite/);

  assert.match(endpoints, /\/api\/v1\/discord\/creator-setups\/deposit-settings/);
  assert.match(endpoints, /\/api\/v1\/discord\/creator-deposits\/jobs\/claim/);
  assert.match(endpoints, /\/api\/v1\/discord\/creator-deposits\/jobs\/\[id\]\/ack/);
  assert.match(endpoints, /\/api\/v1\/discord\/creator-signups\/jobs\/\[id\]\/ack/);
});
