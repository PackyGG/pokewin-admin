const DISCORD_DASHBOARD_OPERATOR_IDS = Object.freeze([
  "660132586630414338",
  "934854938641715240",
  "188051599099297802",
]);

export function isDiscordDashboardOperator(discordUserId: string): boolean {
  return DISCORD_DASHBOARD_OPERATOR_IDS.includes(discordUserId);
}
