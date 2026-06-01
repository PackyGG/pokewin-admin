/**
 * Shared client-safe types used by the /insights/games page +
 * its tab nav / period filter. Keeps the period + tab parsing in
 * one place so the URL contract is consistent across links.
 */

export type GamesTab =
  | "overview"
  | "packs"
  | "battles"
  | "upgrader"
  | "borrow"
  | "users";

export function parseGamesTab(value: string | undefined): GamesTab {
  switch (value) {
    case "overview":
    case "packs":
    case "battles":
    case "upgrader":
    case "borrow":
    case "users":
      return value;
    default:
      return "overview";
  }
}

export const PERIOD_OPTIONS = [
  { label: "24h", value: "24h" },
  { label: "3d", value: "3d" },
  { label: "7d", value: "7d" },
  { label: "30d", value: "30d" },
  { label: "90d", value: "90d" },
  { label: "Lifetime", value: "all" },
] as const;
