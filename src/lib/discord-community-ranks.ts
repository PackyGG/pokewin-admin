export const COMMUNITY_XP_GUILD_ID = "1438216946318442683";

export const COMMUNITY_RANKS = Object.freeze([
  { level: 0, name: "Newcomer", color: "#94a3b8" },
  { level: 3, name: "Member", color: "#38bdf8" },
  { level: 5, name: "Regular", color: "#22c55e" },
  { level: 8, name: "Grinder", color: "#f59e0b" },
  { level: 14, name: "Veteran", color: "#f97316" },
  { level: 20, name: "Elite", color: "#ec4899" },
  { level: 30, name: "Icon", color: "#8b5cf6" },
  { level: 50, name: "Legend", color: "#ef4444" },
  { level: 75, name: "Packy KING", color: "#facc15" },
]);

export type CommunityLevelRole = { guildId: string; level: number; roleId: string };

export type CommunityRank = (typeof COMMUNITY_RANKS)[number];

/** Highest named community rank earned at a numeric XP level. */
export function communityRankForLevel(level: number): CommunityRank {
  const safeLevel = Math.max(0, Math.trunc(level));
  return [...COMMUNITY_RANKS]
    .reverse()
    .find((rank) => rank.level <= safeLevel) ?? COMMUNITY_RANKS[0];
}
