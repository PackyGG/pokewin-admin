import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { communityRankForLevel } from "../../src/lib/discord-community-ranks";

const read = (path: string) => readFile(path, "utf8");

test("chat raffle uses combined Community XP and freezes level provenance", async () => {
  const [standings, actions, page, detail, migration, countMigration, profileMigration, xpService] = await Promise.all([
    read("src/lib/chat-raffle/standings.ts"),
    read("src/app/(admin)/chat-raffle/actions.ts"),
    read("src/app/(admin)/chat-raffle/page.tsx"),
    read("src/app/(admin)/chat-raffle/[id]/page.tsx"),
    read("drizzle/admin/migrations/20260812_chat_raffle_community_xp.sql"),
    read("drizzle/admin/migrations/20260812_chat_raffle_source_message_counts.sql"),
    read("drizzle/admin/migrations/20260812_discord_community_xp_source_counts.sql"),
    read("src/lib/discord-community-xp.ts"),
  ]);

  assert.match(standings, /discord_community_xp_events/);
  assert.match(standings, /event\.source = 'discord'/);
  assert.match(standings, /event\.source = 'site_chat'/);
  assert.match(standings, /event\.occurred_at >=/);
  assert.match(standings, /event\.occurred_at </);
  assert.match(standings, /account\."providerId" = 'discord'/);
  assert.match(standings, /basePoints = xp\.discord_xp \+ xp\.site_chat_xp/);
  assert.match(standings, /communityLevelForXp/);
  assert.match(standings, /timeframe === "lifetime"/);
  assert.match(standings, /discord_counted_messages/);
  assert.match(standings, /site_chat_counted_messages/);
  assert.doesNotMatch(standings, /FROM chat_messages/);

  for (const column of [
    "discord_user_id",
    "discord_xp",
    "site_chat_xp",
    "community_total_xp",
    "community_level",
  ]) {
    assert.match(migration, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`));
    assert.match(actions, new RegExp(`${column}: standing\\.`));
  }
  assert.match(actions, /discord_message_count: standing\.discordMessageCount/);
  assert.match(actions, /site_chat_message_count: standing\.siteChatMessageCount/);

  assert.match(page, /Combined Community XP/);
  assert.match(page, /Lifetime Community XP leaderboard/);
  assert.match(page, />\s*Discord\s*</);
  assert.match(page, /formatNumber\(entry\.discordMessageCount\)/);
  assert.match(page, />\s*On-site\s*</);
  assert.match(page, /formatNumber\(entry\.siteChatMessageCount\)/);
  assert.doesNotMatch(page, /D \{formatNumber\(entry\.discordXp\)\}/);
  assert.doesNotMatch(page, /\(entry\.winChance \* 100\)\.toFixed/);
  assert.match(page, /Lv \{entry\.communityLevel\}/);
  assert.match(page, /entry\.discordXp/);
  assert.match(page, /entry\.siteChatXp/);
  assert.match(detail, /communityRankForLevel/);
  assert.match(detail, /Legacy scoring/);
  assert.match(countMigration, /discord_message_count/);
  assert.match(countMigration, /site_chat_message_count/);
  assert.match(profileMigration, /discord_counted_messages/);
  assert.match(profileMigration, /site_chat_counted_messages/);
  assert.match(xpService, /discord_counted_messages = discord_counted_messages \+/);
  assert.match(xpService, /site_chat_counted_messages = site_chat_counted_messages \+/);
  assert.equal(communityRankForLevel(0).name, "Newcomer");
  assert.equal(communityRankForLevel(14).name, "Veteran");
  assert.equal(communityRankForLevel(75).name, "Packy KING");
});
