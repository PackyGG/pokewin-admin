import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string) => readFile(path, "utf8");

test("creator setup API is guild-pinned, scoped, and transactionally idempotent", async () => {
  const [service, prepare, complete, cancel, migration, scopes, endpoints] =
    await Promise.all([
      read("src/lib/discord-creator-setups.ts"),
      read("src/app/api/v1/discord/creator-setups/prepare/route.ts"),
      read("src/app/api/v1/discord/creator-setups/complete/route.ts"),
      read("src/app/api/v1/discord/creator-setups/cancel/route.ts"),
      read(
        "drizzle/admin/migrations/20260729_discord_creator_setups.sql",
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

  for (const route of [prepare, complete, cancel]) {
    assert.match(route, /scopes: \["discord:creator:setup"\]/);
  }
  assert.match(prepare, /rejectWrongGuild/);
  assert.match(complete, /rejectWrongGuild/);
  assert.match(cancel, /cancelCreatorSetup/);

  assert.match(migration, /CREATE TABLE IF NOT EXISTS "discord_creator_setups"/);
  assert.match(migration, /UNIQUE \("guild_id", "creator_discord_user_id"\)/);
  assert.match(migration, /"interaction_id" TEXT NOT NULL UNIQUE/);
  assert.match(migration, /discord_creator_setups_active_shape_check/);
  assert.match(scopes, /"discord:creator:setup"/);
  assert.match(endpoints, /\/api\/v1\/discord\/creator-setups\/prepare/);
  assert.match(endpoints, /\/api\/v1\/discord\/creator-setups\/complete/);
  assert.match(endpoints, /\/api\/v1\/discord\/creator-setups\/cancel/);
});
