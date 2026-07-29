import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string) => readFile(path, "utf8");

test("creator setup API is guild-pinned, scoped, and transactionally idempotent", async () => {
  const [service, prepare, complete, cancel, link, migration, linkMigration, scopes, endpoints] =
    await Promise.all([
      read("src/lib/discord-creator-setups.ts"),
      read("src/app/api/v1/discord/creator-setups/prepare/route.ts"),
      read("src/app/api/v1/discord/creator-setups/complete/route.ts"),
      read("src/app/api/v1/discord/creator-setups/cancel/route.ts"),
      read("src/app/api/v1/discord/creator-setups/link/route.ts"),
      read(
        "drizzle/admin/migrations/20260729_discord_creator_setups.sql",
      ),
      read(
        "drizzle/admin/migrations/20260729_link_discord_creator_setups.sql",
      ),
      read("src/lib/api-auth/scopes.ts"),
      read("src/lib/api-auth/endpoints.ts"),
    ]);

  assert.match(service, /CREATOR_SETUP_GUILD_ID = "1402743122789929022"/);
  assert.match(service, /getProdReadDrizzleDb\(\)/);
  assert.match(service, /linked\.role !== "creator"/);
  assert.match(service, /pg_advisory_xact_lock/);
  assert.match(service, /INTERVAL '15 minutes'/);
  assert.match(service, /FOR UPDATE/);
  assert.match(service, /status = 'active'/);
  assert.match(service, /status = 'pending'/);

  for (const route of [prepare, complete, cancel, link]) {
    assert.match(route, /scopes: \["discord:creator:setup"\]/);
  }
  assert.match(prepare, /rejectWrongGuild/);
  assert.match(complete, /rejectWrongGuild/);
  assert.match(cancel, /cancelCreatorSetup/);
  assert.match(link, /rejectWrongGuild/);
  assert.match(link, /creatorUserId[\s\S]*\^\[A-Za-z0-9_-\]\+\$/);
  assert.match(link, /actorDiscordUserId: DiscordIdSchema/);
  assert.match(link, /principal\.keyId/);

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
  assert.match(service, /requireLinkedCreator\(\s*setup\.creator_discord_user_id,\s*input\.creatorUserId/s);
  assert.doesNotMatch(service, /eq\(user\.id,\s*creatorUserId\)/);
  assert.match(service, /"creator_mismatch"/);
  assert.match(service, /"setup_actor_forbidden"/);
  assert.match(service, /"setup_link_conflict"/);
  assert.match(service, /"idempotency_conflict"/);
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
  assert.match(endpoints, /\/api\/v1\/discord\/creator-setups\/cancel/);
  assert.match(endpoints, /\/api\/v1\/discord\/creator-setups\/link/);
});
