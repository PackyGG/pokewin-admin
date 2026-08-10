import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string) => readFile(path, "utf8");

test("community XP is durable, combined, anti-spam protected, and role-enabled", async () => {
  const [migration, service, ranks, scopes, endpoints, awardRoute, syncRoute, messageRoute, leaderboardRoute] = await Promise.all([
    read("drizzle/admin/migrations/20260810_discord_community_xp.sql"),
    read("src/lib/discord-community-xp.ts"),
    read("src/lib/discord-community-ranks.ts"),
    read("src/lib/api-auth/scopes.ts"),
    read("src/lib/api-auth/endpoints.ts"),
    read("src/app/api/v1/discord/community-xp/award/route.ts"),
    read("src/app/api/v1/discord/community-xp/sync-site-chat/route.ts"),
    read("src/app/api/v1/discord/message-events/route.ts"),
    read("src/app/api/v1/discord/community-xp/leaderboard/route.ts"),
  ]);
  assert.match(migration, /discord_community_xp_profiles/);
  assert.match(migration, /UNIQUE \(source, source_event_id\)/);
  assert.match(migration, /discord_community_level_roles/);
  assert.match(migration, /level BETWEEN 0 AND 100/);
  assert.match(migration, /created_by_admin_user_id uuid REFERENCES admin_users/);
  assert.match(migration, /'discord:community-xp'/);
  assert.match(service, /COMMUNITY_XP_PER_MESSAGE = 15/);
  assert.match(service, /COMMUNITY_XP_MIN_CHARS = 3/);
  assert.match(service, /COMMUNITY_XP_COOLDOWN_MIN_SECONDS = 3/);
  assert.match(service, /COMMUNITY_XP_COOLDOWN_MAX_SECONDS = 10/);
  assert.match(service, /communityXpCooldownSeconds/);
  assert.match(service, /isLowQualityContent/);
  assert.match(service, /new Set\(lettersAndNumbers\)\.size < 2/);
  assert.match(migration, /'low_quality'/);
  assert.match(service, /COMMUNITY_XP_DUPLICATE_MINUTES = 3/);
  assert.doesNotMatch(service, /COMMUNITY_XP_DAILY_CAP/);
  assert.match(service, /source: "site_chat"/);
  assert.match(service, /discord\."accountId"/);
  assert.match(service, /discord\."providerId" = 'discord'/);
  assert.match(service, /communityLevelForXp/);
  assert.match(service, /getCommunityRoleSync/);
  assert.match(service, /replaceCommunityLevelRoles/);
  assert.match(service, /Math\.min\(30, Math\.trunc\(limit\)\)/);
  assert.match(leaderboardRoute, /max\(30\)/);
  for (const [level, name] of [[0, "Newcomer"], [3, "Member"], [5, "Regular"], [8, "Grinder"], [14, "Veteran"], [20, "Elite"], [30, "Icon"], [50, "Legend"], [75, "Packy KING"]] as const) {
    assert.match(ranks, new RegExp(`level: ${level}, name: "${name}"`));
  }
  assert.match(scopes, /"discord:community-xp"/);
  assert.match(endpoints, /\/api\/v1\/discord\/community-xp\/role-sync/);
  const rolesRoute = await read("src/app/api/v1/discord/community-xp/roles/route.ts");
  assert.match(rolesRoute, /level: z\.number\(\)\.int\(\)\.min\(0\)/);
  assert.match(awardRoute, /COMMUNITY_XP_GUILD_ID/);
  assert.match(syncRoute, /syncSiteChatXp/);
  assert.match(messageRoute, /awardCommunityMessageXp/);
  assert.match(messageRoute, /event\.eventType !== "create"/);
});
