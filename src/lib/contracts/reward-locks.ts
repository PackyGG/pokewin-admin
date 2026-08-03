export const REWARD_LOCK_CATEGORIES = [
  "tips",
  "rain",
  "daily_packs",
  "sponsored_battles",
  "rakeback",
  "leaderboards",
] as const;

export type RewardLockCategory = (typeof REWARD_LOCK_CATEGORIES)[number];
