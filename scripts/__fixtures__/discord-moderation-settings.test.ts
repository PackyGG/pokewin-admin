import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string) => readFile(path, "utf8");

test("PackyGG Discord workspace defaults to XP and keeps moderation operator controlled", async () => {
  const [route, service, actions, page, workspace, xpCard, commandsCard, catalog, editor, card, endpoints, nav, pages] = await Promise.all([
    read("src/app/api/v1/discord/moderation-settings/route.ts"),
    read("src/lib/discord-moderation-settings.ts"),
    read("src/app/(admin)/system/discord-moderation/actions.ts"),
    read("src/app/(admin)/system/discord-moderation/page.tsx"),
    read("src/app/(admin)/system/discord-moderation/discord-workspace.tsx"),
    read("src/app/(admin)/system/discord-moderation/discord-community-xp-card.tsx"),
    read("src/app/(admin)/system/discord-moderation/discord-commands-card.tsx"),
    read("src/lib/discord-command-catalog.ts"),
    read("src/app/(admin)/system/discord-moderation/blocked-words-editor.tsx"),
    read("src/app/(admin)/system/discord-moderation/discord-moderation-card.tsx"),
    read("src/lib/api-auth/endpoints.ts"),
    read("src/lib/nav-config.ts"),
    read("src/lib/admin-pages.ts"),
  ]);

  assert.match(route, /scopes: \["discord:message-events"\]/);
  assert.match(route, /parsed\.data\.guildId !== PACKY_DISCORD_GUILD_ID/);
  assert.match(route, /guild_not_allowed/);
  assert.match(service, /1438216946318442683/);
  assert.match(service, /PACKY_DISCORD_MODERATION/);
  assert.match(service, /blockedWords: z\.array\(NormalizedText\)\.max\(500\)/);
  assert.match(service, /allowedInviteCodes: z\.array\(NormalizedText\)\.max\(100\)/);
  assert.match(service, /exemptRoleIds: z\.array\(Snowflake\)\.max\(100\)/);
  assert.match(service, /exemptChannelIds: z\.array\(Snowflake\)\.max\(100\)/);
  assert.match(actions, /requireAdmin\(\)/);
  assert.match(actions, /createAdminAuditEvent/);
  assert.match(actions, /discord_moderation_settings_updated/);
  assert.match(page, /requirePageAccess\("\/system\/discord-moderation"\)/);
  assert.match(page, /listCommunityLevelRoles/);
  assert.match(workspace, /defaultValue="xp"/);
  assert.match(workspace, /XP &amp; ranks/);
  assert.match(workspace, /Moderation/);
  assert.match(workspace, /Commands/);
  assert.ok(workspace.indexOf('value="xp"') < workspace.indexOf('value="moderation"'));
  assert.ok(workspace.indexOf('value="moderation"') < workspace.indexOf('value="commands"'));
  assert.match(xpCard, /\["\/profile", "\/ranks", "\/lb"\]/);
  assert.match(xpCard, /updateDiscordCommunityRanksAction/);
  assert.match(actions, /discord_community_ranks_updated/);
  assert.match(actions, /replaceCommunityLevelRoles/);
  assert.match(commandsCard, /DISCORD_COMMAND_CATALOG/);
  assert.match(commandsCard, /Not available/);
  for (const command of ["check", "info", "status", "profile", "ranks", "lb", "giveaway", "commands", "dash", "link", "remind", "deal", "lastdeals", "leaderboard", "rewards", "settings", "stats", "userstats", "setup", "delete", "checkwallets"]) {
    assert.match(catalog, new RegExp(`name: "${command}"`));
  }
  for (const guildId of ["1438216946318442683", "1402743122789929022", "1505650386894327919", "1483064422778798112"]) {
    assert.match(catalog, new RegExp(guildId));
  }
  assert.match(editor, /MAX_BLOCKED_WORDS = 500/);
  assert.match(editor, /Search the blocked list/);
  assert.match(editor, /Bulk add/);
  assert.match(editor, /duplicates are removed automatically/);
  assert.match(editor, /Sort A–Z/);
  assert.match(card, /<BlockedWordsEditor/);
  assert.match(endpoints, /path: "\/api\/v1\/discord\/moderation-settings"/);
  assert.match(nav, /href: "\/system\/discord-moderation"/);
  assert.match(nav, /label: "Discord"/);
  assert.match(pages, /key: "\/system\/discord-moderation"/);
});
