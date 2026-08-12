import { MS_PER_DAY, MS_PER_HOUR } from "@/lib/utils/time";

/**
 * Period chip set the dashboard exposes via its global period selector.
 *
 * Lives in its own client-safe module (no DB imports) so the
 * `<DashboardPeriodSelector>` client component can pull the type and
 * constants without dragging the entire server-only query graph into
 * the browser bundle. `dashboard.ts` re-exports these for backend call
 * sites that already import from the main query module.
 */
export const DASHBOARD_PERIODS = [
  "1h", "3h", "6h", "12h", "24h", "48h", "3d", "7d", "30d", "all",
] as const;
export type DashboardPeriod = (typeof DASHBOARD_PERIODS)[number];
export const DEFAULT_DASHBOARD_PERIOD: DashboardPeriod = "24h";

export const DASHBOARD_PERIOD_LABELS: Record<DashboardPeriod, string> = {
  "1h": "Last 1h",
  "3h": "Last 3h",
  "6h": "Last 6h",
  "12h": "Last 12h",
  "24h": "Last 24h",
  "48h": "Last 48h",
  "3d": "Last 3 days",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  all: "All time",
};

/**
 * Resolve a `?period=` chip to the SQL cutoff used by every period-bound
 * aggregate. The "all" sentinel maps to the unix epoch so the
 * `created_at >= cutoff` filter degrades to a no-op (every real
 * timestamp is after 1970). Keeps the SQL identical across the chip
 * set — no special "all" branch.
 */
export function periodToCutoff(period: DashboardPeriod, now: Date): Date {
  switch (period) {
    case "1h":  return new Date(now.getTime() - 1 * MS_PER_HOUR);
    case "3h":  return new Date(now.getTime() - 3 * MS_PER_HOUR);
    case "6h":  return new Date(now.getTime() - 6 * MS_PER_HOUR);
    case "12h": return new Date(now.getTime() - 12 * MS_PER_HOUR);
    case "24h": return new Date(now.getTime() - 1 * MS_PER_DAY);
    case "48h": return new Date(now.getTime() - 2 * MS_PER_DAY);
    case "3d":  return new Date(now.getTime() - 3 * MS_PER_DAY);
    case "7d":  return new Date(now.getTime() - 7 * MS_PER_DAY);
    case "30d": return new Date(now.getTime() - 30 * MS_PER_DAY);
    case "all": return new Date(0);
  }
}

/**
 * Sanitize an arbitrary URL/search-param value to a real DashboardPeriod
 * — anything we don't recognise falls back to the default. Used by the
 * server component reading `searchParams.period`.
 */
export function parseDashboardPeriod(
  value: string | undefined | null,
): DashboardPeriod {
  if (!value) return DEFAULT_DASHBOARD_PERIOD;
  return (DASHBOARD_PERIODS as readonly string[]).includes(value)
    ? (value as DashboardPeriod)
    : DEFAULT_DASHBOARD_PERIOD;
}

// ============================================================
// Dashboard KPI window — "today" vs "24h" (dashboard-local).
//
// The dashboard's KPI boxes (P&L, GGR, Wager, Deposits, …) default to
// the CURRENT CALENDAR DAY since 00:00 UTC ("today"), with a one-click
// "24h" rolling-window toggle next to each box's title. This is a
// SEPARATE concept from the `DashboardPeriod` chip enum above (1h … all):
// it is NOT added to `DASHBOARD_PERIODS` so the `/creators` surfaces that
// consume that enum (`z.enum(DASHBOARD_PERIODS)`) are untouched. The KPI
// window only drives the dashboard's headline boxes.
//
// • "today" — [today 00:00 UTC, now). The same UTC-midnight boundary the
//   P&L Today / Reward Costs / Creators Costs cards already use
//   (utcStartOfDay), so all boxes reconcile to one calendar day. This is
//   the DEFAULT (loaded eagerly on a cold dashboard render).
// • "24h"   — rolling [now − 24h, now). The previous default; offered as
//   the secondary toggle, LAZY-loaded on first click (active-timeframe-
//   only — we never eager-compute both windows).
// ============================================================
export const DASHBOARD_KPI_WINDOWS = ["today", "24h"] as const;
export type DashboardKpiWindow = (typeof DASHBOARD_KPI_WINDOWS)[number];
export const DEFAULT_DASHBOARD_KPI_WINDOW: DashboardKpiWindow = "today";

/** Short toggle labels for the per-box today/24h switch. */
export const DASHBOARD_KPI_WINDOW_LABELS: Record<DashboardKpiWindow, string> = {
  today: "today",
  "24h": "24h",
};

/** Friendly label surfaced on each box's title (e.g. "GGR · Today"). */
export const DASHBOARD_KPI_WINDOW_TITLE: Record<DashboardKpiWindow, string> = {
  today: "Today",
  "24h": "Last 24h",
};

/**
 * UTC start-of-day for the instant `now` (today 00:00 UTC). Mirrors the
 * boundary used by `getTodayPnl` / the Reward-Costs / Creators-Costs cards
 * so every dashboard "today" figure agrees to the same calendar day no
 * matter which region the serverless function runs in.
 */
export function utcStartOfDay(now: Date): Date {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Resolve a dashboard KPI window to its SQL cutoff:
 *   • "today" → today 00:00 UTC (reuses {@link utcStartOfDay}).
 *   • "24h"   → rolling now − 24h.
 * The single value drives every period-bound dashboard aggregate the same
 * way `periodToCutoff` does for the chip enum.
 */
export function kpiWindowToCutoff(
  window: DashboardKpiWindow,
  now: Date,
): Date {
  return window === "today"
    ? utcStartOfDay(now)
    : new Date(now.getTime() - MS_PER_DAY);
}

/**
 * Stable cutoff for cross-request KPI caches.
 *
 * "today" already has a stable UTC-midnight boundary. A raw rolling-24h
 * cutoff contains the current millisecond, however, so using it as a cache
 * argument mints a different entry on every request and defeats a 60-second
 * cache. Floor the observation time to the cache cadence before subtracting
 * 24 hours. The resulting window can lag real time by at most 59.999 seconds,
 * which is already inside the dashboard's 60-second freshness contract.
 */
export function kpiWindowToCacheCutoff(
  window: DashboardKpiWindow,
  now: Date,
): Date {
  if (window === "today") return utcStartOfDay(now);
  const minuteStart = Math.floor(now.getTime() / 60_000) * 60_000;
  return new Date(minuteStart - MS_PER_DAY);
}

/**
 * Sanitize a free-string (URL param / client value) to a real
 * DashboardKpiWindow — unknown values fall back to the default ("today").
 */
export function parseDashboardKpiWindow(
  value: string | undefined | null,
): DashboardKpiWindow {
  if (!value) return DEFAULT_DASHBOARD_KPI_WINDOW;
  return (DASHBOARD_KPI_WINDOWS as readonly string[]).includes(value)
    ? (value as DashboardKpiWindow)
    : DEFAULT_DASHBOARD_KPI_WINDOW;
}
