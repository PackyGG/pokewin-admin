import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string) => readFile(path, "utf8");

test("creator setup API is guild-pinned, scoped, and transactionally idempotent", async () => {
  const [service, standings, superusers, operators, prepare, complete, repair, cancel, deletePreview, deleteSetup, link, stats, userStats, dashboardContext, deal, leaderboard, rewards, migration, linkMigration, deleteMigration, scopes, endpoints] =
    await Promise.all([
      read("src/lib/discord-creator-setups.ts"),
      read("src/lib/queries/creators-leaderboards.ts"),
      read("src/lib/discord-bot-superusers.ts"),
      read("src/lib/discord-dashboard-operators.ts"),
      read("src/app/api/v1/discord/creator-setups/prepare/route.ts"),
      read("src/app/api/v1/discord/creator-setups/complete/route.ts"),
      read("src/app/api/v1/discord/creator-setups/repair/route.ts"),
      read("src/app/api/v1/discord/creator-setups/cancel/route.ts"),
      read("src/app/api/v1/discord/creator-setups/delete-preview/route.ts"),
      read("src/app/api/v1/discord/creator-setups/delete/route.ts"),
      read("src/app/api/v1/discord/creator-setups/link/route.ts"),
      read("src/app/api/v1/discord/creator-setups/stats/route.ts"),
      read("src/app/api/v1/discord/creator-setups/user-stats/route.ts"),
      read("src/app/api/v1/discord/creator-setups/dashboard-context/route.ts"),
      read("src/app/api/v1/discord/creator-setups/deal/route.ts"),
      read("src/app/api/v1/discord/creator-setups/leaderboard/route.ts"),
      read("src/app/api/v1/discord/creator-setups/rewards/route.ts"),
      read(
        "drizzle/admin/migrations/20260729_discord_creator_setups.sql",
      ),
      read(
        "drizzle/admin/migrations/20260729_link_discord_creator_setups.sql",
      ),
      read(
        "drizzle/admin/migrations/20260809_discord_creator_setup_deletion.sql",
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

  for (const route of [prepare, complete, repair, cancel, deletePreview, deleteSetup, link, stats, userStats, dashboardContext, deal, leaderboard, rewards]) {
    assert.match(route, /scopes: \["discord:creator:setup"\]/);
  }
  assert.match(prepare, /rejectWrongGuild/);
  assert.match(complete, /rejectWrongGuild/);
  assert.match(repair, /rejectWrongGuild/);
  assert.match(repair, /principal\.keyId/);
  assert.match(repair, /previousCategoryId: DiscordIdSchema/);
  assert.match(cancel, /cancelCreatorSetup/);
  assert.match(deletePreview, /previewCreatorSetupDelete/);
  assert.match(deletePreview, /rejectWrongGuild/);
  assert.match(deleteSetup, /deleteCreatorSetup/);
  assert.match(deleteSetup, /rejectWrongGuild/);
  assert.match(deleteSetup, /principal\.keyId/);
  assert.match(service, /export async function previewCreatorSetupDelete/);
  assert.match(service, /export async function deleteCreatorSetup/);
  assert.match(service, /requireCreatorSetupDeleteActor/);
  assert.match(service, /isDiscordDashboardOperator\(actorDiscordUserId\)/);
  assert.match(service, /delete_interaction_id = \$\{input\.interactionId\}/);
  assert.match(service, /status = 'deleted'/);
  assert.match(service, /creator_user_id = NULL/);
  assert.match(service, /category_id = \$\{input\.categoryId\}/);
  assert.match(service, /chat_channel_id = \$\{input\.chatChannelId\}/);
  assert.match(service, /logs_channel_id = \$\{input\.logsChannelId\}/);
  assert.match(service, /event_type: "discord_creator_setup_deleted"/);
  assert.match(link, /rejectWrongGuild/);
  assert.match(link, /creatorUserId[\s\S]*\^\[A-Za-z0-9_-\]\+\$/);
  assert.match(link, /actorDiscordUserId: DiscordIdSchema/);
  assert.match(link, /principal\.keyId/);
  assert.match(stats, /getCreatorSetupStats/);
  assert.match(stats, /rejectWrongGuild/);
  const statsService = service.slice(
    service.indexOf("export async function getCreatorSetupStats"),
    service.indexOf("Poll-safe stream lifecycle snapshot"),
  );
  assert.match(
    statsService,
    /SUM\(acu\.weighted_wager_amount_usd::numeric\)/,
  );
  assert.doesNotMatch(
    statsService,
    /COALESCE\(\s*acu\.weighted_wager_amount_usd,\s*acu\.wager_amount_usd/,
  );
  assert.match(userStats, /getCreatorSetupUserStats/);
  assert.match(userStats, /username: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(64\)/);
  assert.match(userStats, /rejectWrongGuild/);
  assert.match(service, /export async function getCreatorSetupUserStats/);
  assert.match(
    service,
    /getCreatorSetupUserStats[\s\S]*requireLinkedSetupActor\(input, \{\s*allowDashboardOperator: true,/,
  );
  assert.match(service, /LOWER\(candidate\.username\) = LOWER\(\$\{input\.username\}\)/);
  assert.match(service, /candidate\.affiliate_code_active = true/);
  assert.match(service, /candidate\.affiliate_code_expires_at > NOW\(\)/);
  assert.match(service, /owned\.user_id = \$\{setup\.creator_user_id\}/);
  assert.match(service, /creator_user_not_active/);
  assert.match(service, /weighted_wager_amount_usd/);
  assert.match(service, /lt\.type = 'deposit'/);
  assert.match(service, /calculateWindowedPnl\(\{/);
  assert.match(service, /pnlUsd: money\(-windowedPnl\.pnl\)/);
  assert.match(service, /const activeRecheck = await db\.execute/);
  assert.match(dashboardContext, /getCreatorDashboardContext/);
  assert.match(dashboardContext, /rejectWrongGuild/);
  assert.match(service, /isDiscordDashboardOperator\(input\.actorDiscordUserId\)/);
  assert.match(operators, /"660132586630414338"/);
  assert.match(operators, /"934854938641715240"/);
  assert.match(operators, /"188051599099297802"/);
  assert.match(deal, /getCreatorSetupDeal/);
  assert.match(deal, /rejectWrongGuild/);
  assert.match(service, /creatorsApi\.listDeals\(setup\.creator_user_id/);
  assert.match(service, /deal\.status === "active"/);
  assert.match(service, /deal\.status === "scheduled"/);
  assert.match(service, /total_withdraw_cap_usd/);
  assert.match(service, /max_sponsorship_per_stream_usd/);
  assert.match(service, /affiliateLeaderboardsApi\.list/);
  assert.match(service, /creator_user_id: creatorUserId/);
  assert.match(service, /status: "approved"/);
  assert.match(service, /time_status === "active"/);
  assert.match(service, /admin_leaderboard_sponsorship/);
  assert.match(service, /sponsored_percentage/);
  assert.match(service, /leaderboardPrizePoolUsd/);
  assert.match(service, /leaderboardPackySharePercent/);
  assert.match(leaderboard, /getCreatorSetupLeaderboard/);
  assert.match(leaderboard, /pageSize: z\.literal\(10\)/);
  assert.match(leaderboard, /rejectWrongGuild/);
  assert.match(service, /getCurrentCreatorLeaderboard/);
  assert.match(service, /getAffiliateLeaderboardPage/);
  assert.match(service, /username: entry\.username\?\.trim\(\) \|\| "Anonymous player"/);
  assert.match(standings, /affiliate_leaderboard_snapshots/);
  assert.match(standings, /weighted_wager_amount_usd/);
  assert.match(standings, /COUNT\(\*\) OVER\(\)/);
  assert.match(standings, /u\.role::text NOT IN \('admin', 'support'\)/);
  const leaderboardPageQuery = standings.slice(
    standings.indexOf("export async function getAffiliateLeaderboardPage"),
    standings.indexOf("Compute the live standings"),
  );
  assert.doesNotMatch(leaderboardPageQuery, /email/);
  assert.match(rewards, /getCreatorSetupRewards/);
  assert.match(rewards, /rejectWrongGuild/);
  assert.match(service, /creator_reward_programs/);
  assert.match(service, /creator_reward_programs\.is_active, true/);
  assert.match(service, /endsAt: creator_reward_programs\.ends_at/);
  assert.match(service, /isNull\(creator_reward_programs\.ends_at\)/);
  assert.match(
    service,
    /gt\(creator_reward_programs\.ends_at, sql`now\(\)`\)/,
  );
  assert.match(
    service,
    /endsAt: program\.endsAt \? new Date\(program\.endsAt\)\.toISOString\(\) : null/,
  );
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
  assert.match(deleteMigration, /'pending', 'active', 'deleted'/);
  assert.match(deleteMigration, /discord_creator_setups_live_creator_unique/);
  assert.match(deleteMigration, /WHERE "status" IN \('pending', 'active'\)/);
  assert.match(deleteMigration, /discord_creator_setups_deletion_shape_check/);
  assert.match(deleteMigration, /"creator_user_id" IS NULL/);
  assert.doesNotMatch(deleteMigration, /ON DELETE CASCADE/);
  assert.match(service, /chat_channel_id = \$\{input\.channelId\}/);
  assert.match(service, /logs_channel_id = \$\{input\.channelId\}/);
  assert.match(service, /input\.actorDiscordUserId !== setup\.creator_discord_user_id/);
  assert.match(service, /input\.actorDiscordUserId !== setup\.created_by_discord_user_id/);
  assert.match(service, /await creatorsApi\.promote\(creatorUserId\)/);
  assert.match(service, /if \(!allowGrant\)/);
  assert.match(
    service,
    /const actorIsSuperuser = isDiscordBotSuperuser\(input\.actorDiscordUserId\)/,
  );
  assert.match(
    service,
    /promoted\.user_id !== creatorUserId[\s\S]*promoted\.role !== "creator"/,
  );
  assert.match(service, /event_type: "discord_creator_role_granted"/);
  assert.match(service, /eq\(user\.id,\s*creatorUserId\)/);
  assert.doesNotMatch(service, /requireDiscordOwnership/);
  assert.doesNotMatch(service, /discord_link_missing/);
  assert.doesNotMatch(service, /account\.providerId/);
  assert.match(
    service,
    /if \(!actorIsSuperuser\) \{\s*throw new CreatorSetupError\(\s*403,\s*"setup_actor_forbidden",\s*"Only authorized Packy staff can link a new Packy account to this section\."/s,
  );
  assert.match(
    service,
    /const \{ roleGranted \} = await ensureActiveCreator\(input\.creatorUserId, true\)/,
  );
  assert.match(service, /creatorRoleGranted: roleGranted/);
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
  assert.match(endpoints, /\/api\/v1\/discord\/creator-setups\/delete-preview/);
  assert.match(endpoints, /\/api\/v1\/discord\/creator-setups\/delete/);
  assert.match(endpoints, /\/api\/v1\/discord\/creator-setups\/link/);
  assert.match(endpoints, /does not require or change the account's on-site Discord OAuth link/);
  assert.match(endpoints, /\/api\/v1\/discord\/creator-setups\/stats/);
  assert.match(endpoints, /\/api\/v1\/discord\/creator-setups\/user-stats/);
  assert.match(endpoints, /\/api\/v1\/discord\/creator-setups\/dashboard-context/);
  assert.match(endpoints, /\/api\/v1\/discord\/creator-setups\/deal/);
  assert.match(endpoints, /\/api\/v1\/discord\/creator-setups\/leaderboard/);
  assert.match(endpoints, /\/api\/v1\/discord\/creator-setups\/rewards/);
});

test("creator last-deals API uses complete leaderboard frames and actual support", async () => {
  const [route, service, standings, endpoints] = await Promise.all([
    read("src/app/api/v1/discord/creator-setups/last-deals/route.ts"),
    read("src/lib/discord-creator-last-deals.ts"),
    read("src/lib/queries/creators-leaderboards.ts"),
    read("src/lib/api-auth/endpoints.ts"),
  ]);

  assert.match(route, /scopes: \["discord:creator:setup"\]/);
  assert.match(route, /rejectWrongGuild/);
  assert.match(route, /Response\.json\(\{ data: await getCreatorLastDeals/);
  assert.match(service, /requireLinkedSetupActor\(input, \{\s*allowDashboardOperator: true/);
  assert.match(service, /setup\.creator_discord_user_id/);
  assert.match(service, /isDiscordDashboardOperator\(input\.actorDiscordUserId\)/);
  assert.match(service, /Date\.parse\(leaderboard\.start_date\) <= now/);
  assert.match(service, /\.slice\(0, DEAL_LIMIT\)/);
  assert.match(service, /frame\.affiliate_codes\.length > 0/);
  assert.match(
    service,
    /usage\.usage_type::text = 'signup'/,
  );
  assert.match(service, /usage\.usage_type::text = 'deposit'/);
  assert.match(service, /weightedWagerUsd: leaderboard\.weightedWagerUsd/);
  assert.match(service, /usage\.status::text = 'completed'/);
  assert.match(service, /deposit\.status = 'completed'/);
  assert.match(service, /deposit\.created_at - INTERVAL '7 days'/);
  assert.match(service, /ORDER BY usage\.created_at DESC, usage\.id DESC/);
  assert.match(service, /referred\.role::text NOT IN \('admin', 'support', 'creator'\)/);
  assert.match(service, /getExcludedUserIds\(\)/);
  assert.match(service, /status: "approved"/);
  assert.match(service, /include_cancelled: false/);
  assert.match(service, /getAffiliateLeaderboardPage/);
  assert.match(service, /pageSize: TOP_ENTRY_LIMIT/);
  assert.match(service, /session\.activated_at >= deal\.start_at/);
  assert.match(service, /SUM\(session\.fill_loaded_usd::numeric\)/);
  assert.match(service, /SUM\(session\.converted_to_raw_usd::numeric\)/);
  assert.match(service, /SUM\(session\.tips_spent_this_session_usd::numeric\)/);
  assert.match(service, /SUM\(session\.sponsorship_spent_this_session_usd::numeric\)/);
  assert.match(standings, /SUM\(als\.total_wagered_usd\) OVER\(\)/);
  assert.match(
    standings,
    /SUM\(SUM\(COALESCE\(acu\.weighted_wager_amount_usd, acu\.wager_amount_usd\)::numeric\)\)/,
  );
  assert.match(endpoints, /\/api\/v1\/discord\/creator-setups\/last-deals/);
  assert.match(endpoints, /latest one or two started leaderboard deal frames/);
});

test("creator activity notifications are independently controlled, durable, and creator-guild pinned", async () => {
  const [service, signupService, readSettings, updateSettings, claim, ack, signupAck,
    migration, signupMigration, controlsMigration, endpoints] =
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
      read("drizzle/admin/migrations/20260806_creator_activity_notification_controls.sql"),
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
  assert.match(controlsMigration, /"signup_notifications_enabled" BOOLEAN/);
  assert.match(controlsMigration, /"signup_notifications_enabled_at" TIMESTAMPTZ/);
  assert.match(controlsMigration, /"signup_notifications_enabled" = "deposit_notifications_enabled"/);
  assert.match(controlsMigration, /discord_creator_setups_signup_notifications_idx/);
  assert.match(service, /deposit\.status = 'completed'/);
  assert.match(service, /deposit\.amount::numeric > 0/);
  assert.match(service, /INTERVAL '7 days'/);
  assert.match(service, /deposit_notifications_enabled_at <= source\."occurredAt"/);
  assert.match(service, /ON CONFLICT \(source_deposit_id\) DO NOTHING/);
  assert.match(service, /FOR UPDATE OF job SKIP LOCKED/);
  assert.match(service, /target\?: CreatorNotificationTarget/);
  assert.match(service, /target === "signups"/);
  assert.match(service, /target === "deposits"/);
  assert.match(service, /UPDATE discord_creator_deposit_jobs/);
  assert.match(service, /UPDATE discord_creator_signup_jobs/);
  assert.doesNotMatch(service, /getProdWrite/);
  assert.match(signupService, /usage\.usage_type::text = 'signup'/);
  assert.match(signupService, /usage\.status::text = 'completed'/);
  assert.match(signupService, /setup\.signup_notifications_enabled = true/);
  assert.match(signupService, /setup\.signup_notifications_enabled = false/);
  assert.doesNotMatch(signupService, /setup\.deposit_notifications_enabled/);
  assert.match(signupService, /ON CONFLICT \(source_signup_id\) DO NOTHING/);
  assert.match(signupService, /FOR UPDATE OF job SKIP LOCKED/);
  assert.doesNotMatch(signupService, /getProdWrite/);

  assert.match(endpoints, /\/api\/v1\/discord\/creator-setups\/deposit-settings/);
  assert.match(endpoints, /\/api\/v1\/discord\/creator-deposits\/jobs\/claim/);
  assert.match(endpoints, /\/api\/v1\/discord\/creator-deposits\/jobs\/\[id\]\/ack/);
  assert.match(endpoints, /\/api\/v1\/discord\/creator-signups\/jobs\/\[id\]\/ack/);
});
