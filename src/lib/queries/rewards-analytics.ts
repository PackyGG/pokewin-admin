/**
 * Shared period contract for the active reward analytics readers.
 *
 * The former overview and drilldown queries in this module had no runtime
 * consumers. Keep the type here so the category-specific readers and UI
 * components retain their existing import path.
 */
export type RewardsPeriod = "today" | "7d" | "30d" | "all";

export type RewardsDailyPoint = {
  date: string;
  bonuses: number;
  rakeback: number;
  affiliate: number;
  rainRace: number;
  signupPack: number;
  waitlist: number;
  houseCredits: number;
  total: number;
};
