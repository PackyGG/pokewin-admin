/**
 * Shared types for /insights/analytics — the deep-dive variant of the
 * legacy /analytics page. Period chip set is wider here (adds 24h / 3d
 * up front, drops "today") so admins can zoom right in to a rolling
 * window. "lifetime" is the all-time bucket — kept distinct from
 * /analytics' "all" so the URL is self-documenting.
 */

export const INSIGHTS_PERIODS = [
  "24h",
  "3d",
  "7d",
  "30d",
  "90d",
  "lifetime",
] as const;

export type InsightsPeriod = (typeof INSIGHTS_PERIODS)[number];

export const DEFAULT_INSIGHTS_PERIOD: InsightsPeriod = "30d";

export const INSIGHTS_PERIOD_LABELS: Record<InsightsPeriod, string> = {
  "24h": "Last 24h",
  "3d": "Last 3 days",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  lifetime: "Lifetime",
};

export function parseInsightsPeriod(value: string | undefined): InsightsPeriod {
  if (!value) return DEFAULT_INSIGHTS_PERIOD;
  return (INSIGHTS_PERIODS as readonly string[]).includes(value)
    ? (value as InsightsPeriod)
    : DEFAULT_INSIGHTS_PERIOD;
}

/**
 * Period → days (used by helpers that count back N days). `lifetime`
 * returns null so callers can branch on it; alternatively callers can
 * pass `new Date(0)` as the cutoff via {@link periodToCutoff}.
 */
export function periodToDays(period: InsightsPeriod): number | null {
  switch (period) {
    case "24h":
      return 1;
    case "3d":
      return 3;
    case "7d":
      return 7;
    case "30d":
      return 30;
    case "90d":
      return 90;
    case "lifetime":
      return null;
  }
}

/**
 * Period → cutoff Date for `created_at >= cutoff` SQL filters. Lifetime
 * maps to the unix epoch so the predicate becomes a no-op without a
 * special branch.
 */
export function periodToCutoff(period: InsightsPeriod, now: Date = new Date()): Date {
  const days = periodToDays(period);
  if (days === null) return new Date(0);
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/**
 * The previous comparable period for trend deltas. e.g. 7d returns the
 * cutoff exactly 7 days before the current 7d cutoff. Lifetime returns
 * null (no meaningful comparison window).
 */
export function previousPeriodCutoff(
  period: InsightsPeriod,
  now: Date = new Date(),
): { start: Date; end: Date } | null {
  const days = periodToDays(period);
  if (days === null) return null;
  const ms = days * 24 * 60 * 60 * 1000;
  const end = new Date(now.getTime() - ms);
  const start = new Date(end.getTime() - ms);
  return { start, end };
}

export const INSIGHTS_TABS = [
  "overview",
  "cohorts",
  "retention",
  "ltv",
  "funnel",
  "heatmap",
  "whales",
  "geo",
  "sources",
  // Money Flow — decomposes the GGR ↔ P&L gap explicitly (card
  // withdrawals + inventory growth + voucher growth + residual). Added
  // after the v1 page landed because admins kept asking "why is GGR so
  // much bigger than P&L?" and the dashboard didn't have an answer.
  "money-flow",
] as const;

export type InsightsTab = (typeof INSIGHTS_TABS)[number];

export function parseInsightsTab(value: string | undefined): InsightsTab {
  if (!value) return "overview";
  return (INSIGHTS_TABS as readonly string[]).includes(value)
    ? (value as InsightsTab)
    : "overview";
}
