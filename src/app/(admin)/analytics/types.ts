/**
 * Shared types used by /analytics tabs.
 */

export type AnalyticsPeriod = "today" | "7d" | "30d" | "90d" | "all";

export function parsePeriod(value: string | undefined): AnalyticsPeriod {
  switch (value) {
    case "today":
    case "7d":
    case "30d":
    case "90d":
    case "all":
      return value;
    default:
      return "30d";
  }
}
