import { MS_PER_DAY, MS_PER_HOUR } from "@/lib/utils/time";

/**
 * Period chip set the dashboard exposes via its global period selector.
 *
 * Lives in its own client-safe module (no DB imports, no Prisma) so the
 * `<DashboardPeriodSelector>` client component can pull the type and
 * constants without dragging the entire server-only query graph into
 * the browser bundle. `dashboard.ts` re-exports these for backend call
 * sites that already import from the main query module.
 */
export const DASHBOARD_PERIODS = [
  "1h", "3h", "6h", "12h", "24h", "3d", "7d", "30d", "all",
] as const;
export type DashboardPeriod = (typeof DASHBOARD_PERIODS)[number];
export const DEFAULT_DASHBOARD_PERIOD: DashboardPeriod = "24h";

export const DASHBOARD_PERIOD_LABELS: Record<DashboardPeriod, string> = {
  "1h": "Last 1h",
  "3h": "Last 3h",
  "6h": "Last 6h",
  "12h": "Last 12h",
  "24h": "Last 24h",
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
