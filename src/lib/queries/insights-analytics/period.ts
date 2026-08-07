/**
 * Shared types for /insights/analytics — the deep-dive variant of the
 * legacy /analytics page. Period chip set is wider here (adds 24h / 3d
 * up front, drops "today") so admins can zoom right in to a rolling
 * window. The all-time bucket is the canonical `"all"` token (matches
 * the dashboard's `DASHBOARD_PERIODS` set in
 * `src/lib/queries/dashboard-period.ts`). The legacy `"lifetime"` value
 * that this surface used to write into the URL is still accepted as an
 * alias on read so existing bookmarks/screenshots keep working — see
 * {@link parseInsightsPeriod}. The UI label can still surface "Lifetime"
 * as a display string (it reads better next to "Last N days"); only the
 * URL token + the internal value are unified on `"all"`.
 */

const INSIGHTS_PERIODS = [
  "24h",
  "3d",
  "7d",
  "30d",
  "90d",
  "all",
] as const;

export type InsightsPeriod = (typeof INSIGHTS_PERIODS)[number];

const DEFAULT_INSIGHTS_PERIOD: InsightsPeriod = "30d";

export const INSIGHTS_PERIOD_LABELS: Record<InsightsPeriod, string> = {
  "24h": "Last 24h",
  "3d": "Last 3 days",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  // Display string kept as "Lifetime" — admins read this next to "Last
  // N days" and "All time" would be a worse label here. The TOKEN is
  // `"all"`; only the human-readable label says "Lifetime".
  all: "Lifetime",
};

/**
 * Parse the URL `?period=` value to an {@link InsightsPeriod}. Accepts
 * the legacy `"lifetime"` token as an alias for `"all"` so bookmarks /
 * screenshots written before the canonical-token unification still land
 * on the same all-time bucket — old links never break. Any unknown value
 * falls back to {@link DEFAULT_INSIGHTS_PERIOD}.
 */
export function parseInsightsPeriod(value: string | undefined): InsightsPeriod {
  if (!value) return DEFAULT_INSIGHTS_PERIOD;
  // Legacy alias: pre-unification this surface wrote "lifetime" into the
  // URL. Normalise to the canonical `"all"` before the membership check
  // so the downstream switches (which only know the canonical set) see
  // the standard token. Do NOT touch
  // `src/lib/queries/dashboard-period.ts` parsing — that surface always
  // used "all" and has no legacy aliases to honour.
  const normalized = value === "lifetime" ? "all" : value;
  return (INSIGHTS_PERIODS as readonly string[]).includes(normalized)
    ? (normalized as InsightsPeriod)
    : DEFAULT_INSIGHTS_PERIOD;
}

/**
 * Period → days (used by helpers that count back N days). The all-time
 * bucket (`"all"`) returns null so callers can branch on it;
 * alternatively callers can pass `new Date(0)` as the cutoff via
 * {@link periodToCutoff}.
 */
function periodToDays(period: InsightsPeriod): number | null {
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
    case "all":
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
function previousPeriodCutoff(
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

const INSIGHTS_TABS = [
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

type InsightsTab = (typeof INSIGHTS_TABS)[number];

function parseInsightsTab(value: string | undefined): InsightsTab {
  if (!value) return "overview";
  return (INSIGHTS_TABS as readonly string[]).includes(value)
    ? (value as InsightsTab)
    : "overview";
}
