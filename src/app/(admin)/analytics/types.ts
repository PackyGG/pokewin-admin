/**
 * Shared types used by /analytics tabs.
 */

export type AnalyticsPeriod = "today" | "7d" | "30d" | "90d" | "all";

/**
 * The page-level `?period=` is the ONE timespan control for /analytics, so
 * every tab has to speak it — including the ones absorbed from the old
 * /insights tree, which carry their own period vocabularies.
 *
 * The vocabularies overlap almost exactly (`7d` / `30d` / `90d` / `all` are
 * identical strings); the only real difference is that analytics calls the
 * shortest window `today` while the insights layers call it `24h`. These
 * mappers exist so that difference is translated in ONE place instead of
 * every tab inventing its own conversion.
 */
export function toInsightsPeriod(
  p: AnalyticsPeriod,
): "24h" | "3d" | "7d" | "30d" | "90d" | "all" {
  return p === "today" ? "24h" : p;
}

/**
 * Double Down's own window set has no `3d`, but it does not need one — the
 * analytics vocabulary maps onto it exactly once `today` becomes `24h`.
 */
export function toDoubleDownPeriod(
  p: AnalyticsPeriod,
): "24h" | "7d" | "30d" | "90d" | "all" {
  return p === "today" ? "24h" : p;
}

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
