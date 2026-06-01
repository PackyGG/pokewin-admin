/**
 * /insights/streamers — shared parsers & period definitions.
 *
 * Periods are intentionally split from the main /analytics page so the
 * streamer view can offer the finer-grained 24h / 3d windows that the
 * abuse / wager-spike detection actually needs. Lifetime is the catch-all
 * "since signup" view.
 */

export type StreamerPeriod = "24h" | "3d" | "7d" | "30d" | "90d" | "lifetime";

export type StreamerTab =
  | "overview"
  | "money-makers"
  | "sus"
  | "code-switching"
  | "leaderboard-snipers"
  | "roi";

export function parsePeriod(value: string | undefined): StreamerPeriod {
  switch (value) {
    case "24h":
    case "3d":
    case "7d":
    case "30d":
    case "90d":
    case "lifetime":
      return value;
    default:
      return "7d";
  }
}

export function parseTab(value: string | undefined): StreamerTab {
  switch (value) {
    case "overview":
    case "money-makers":
    case "sus":
    case "code-switching":
    case "leaderboard-snipers":
    case "roi":
      return value;
    default:
      return "overview";
  }
}

/**
 * Postgres INTERVAL fragment for the period. Used inline in SQL — the
 * value is one of a fixed set of literal strings (typed above), so it's
 * safe to interpolate. Lifetime returns the empty string so callers can
 * omit the WHERE clause entirely.
 */
export function periodSqlInterval(period: StreamerPeriod): string {
  switch (period) {
    case "24h":
      return "INTERVAL '24 hours'";
    case "3d":
      return "INTERVAL '3 days'";
    case "7d":
      return "INTERVAL '7 days'";
    case "30d":
      return "INTERVAL '30 days'";
    case "90d":
      return "INTERVAL '90 days'";
    case "lifetime":
      return "";
  }
}

export function periodLabel(period: StreamerPeriod): string {
  switch (period) {
    case "24h":
      return "Last 24h";
    case "3d":
      return "Last 3 days";
    case "7d":
      return "Last 7 days";
    case "30d":
      return "Last 30 days";
    case "90d":
      return "Last 90 days";
    case "lifetime":
      return "Lifetime";
  }
}
