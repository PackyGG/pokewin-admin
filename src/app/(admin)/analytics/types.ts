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
 * The inverse of {@link toInsightsPeriod} — turns an insights window back
 * into the page-level `?period=` value.
 *
 * Needed because tabs absorbed from the /insights tree build their OWN links
 * (sub-nav, program pickers) and have to hand the page vocabulary back. Emit
 * `3d` and `parsePeriod` rejects it, silently resetting the operator's window
 * to the 30d default — so the one window the two sets don't share resolves to
 * its nearest page-level neighbour instead of falling through.
 */
export function fromInsightsPeriod(
  p: "24h" | "3d" | "7d" | "30d" | "90d" | "all",
): AnalyticsPeriod {
  if (p === "24h") return "today";
  if (p === "3d") return "7d";
  return p;
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

/**
 * Window vocabulary for the daily series on the overview (acquisition trend,
 * money-flow chart). Daily buckets stay bounded: `today` widens to the 7d
 * chart (a one-bucket chart is useless) and `all` caps at 90d so neither
 * series ever becomes an unbounded lifetime day-scan. Sections label the
 * divergence when it happens ("showing last 90 days").
 */
export type AcquisitionWindow = "7d" | "30d" | "90d";

export function toAcquisitionWindow(p: AnalyticsPeriod): AcquisitionWindow {
  if (p === "today") return "7d";
  if (p === "all") return "90d";
  return p;
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
