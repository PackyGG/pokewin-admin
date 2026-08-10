import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string) => readFile(path, "utf8");

test("giveaway account requirements are durable, compatible, and server-enforced", async () => {
  const [migration, establishedMigration, service, createRoute, entryRoute] = await Promise.all([
    read("drizzle/admin/migrations/20260809_discord_giveaway_requirements.sql"),
    read("drizzle/admin/migrations/20260809_discord_giveaway_requirements_v2.sql"),
    read("src/lib/discord-giveaways.ts"),
    read("src/app/api/v1/discord/giveaways/route.ts"),
    read("src/app/api/v1/discord/giveaways/[id]/enter/route.ts"),
  ]);

  assert.match(migration, /entry_requirement/);
  assert.match(migration, /'none', 'linked_packy_account'/);
  assert.match(establishedMigration, /'established_linked_packy_account'/);
  assert.match(createRoute, /"none",\s+"linked_packy_account",\s+"established_linked_packy_account"/);
  assert.match(service, /entry_requirement !== entryRequirement/);
  assert.match(service, /row\.entry_requirement === "linked_packy_account"/);
  assert.match(service, /row\.entry_requirement === "established_linked_packy_account"/);
  assert.match(service, /getProdReadDrizzleDb\(\)/);
  assert.match(service, /eq\(account\.providerId, "discord"\)/);
  assert.match(service, /eq\(account\.accountId, input\.discordUserId\)/);
  assert.match(service, /MINIMUM_PACKY_ACCOUNT_AGE_DAYS = 5/);
  assert.match(service, /MINIMUM_DISCORD_ACCOUNT_AGE_DAYS = 90/);
  assert.match(service, /innerJoin\(user, eq\(user\.id, account\.userId\)\)/);
  assert.match(service, /establishedEligibleDiscordUserIds/);
  assert.match(service, /"giveaway_requirement_not_met"/);
  assert.match(entryRoute, /error\.code === "giveaway_requirement_not_met"/);
});
