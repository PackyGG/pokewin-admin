const DISCORD_BOT_SUPERUSER_IDS = new Set([
  "660132586630414338",
  "934854938641715240",
]);

export function isDiscordBotSuperuser(discordUserId: string): boolean {
  return DISCORD_BOT_SUPERUSER_IDS.has(discordUserId);
}
