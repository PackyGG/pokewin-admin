/**
 * Top Creators list window — independent from the Overview `?period=` chip.
 * Default 3d; ranked by code-cohort deposits in the active window.
 */

export const TOP_CREATORS_PERIODS = ["3d", "7d", "14d"] as const;
export type TopCreatorsPeriod = (typeof TOP_CREATORS_PERIODS)[number];
const DEFAULT_TOP_CREATORS_PERIOD: TopCreatorsPeriod = "3d";

export const TOP_CREATORS_PERIOD_LABELS: Record<TopCreatorsPeriod, string> = {
  "3d": "3d",
  "7d": "7d",
  "14d": "14d",
};

export function parseTopCreatorsPeriod(
  value: string | undefined | null,
): TopCreatorsPeriod {
  if (!value) return DEFAULT_TOP_CREATORS_PERIOD;
  return (TOP_CREATORS_PERIODS as readonly string[]).includes(value)
    ? (value as TopCreatorsPeriod)
    : DEFAULT_TOP_CREATORS_PERIOD;
}

function topCreatorsPeriodToInterval(period: TopCreatorsPeriod): string {
  switch (period) {
    case "3d":
      return "3 days";
    case "7d":
      return "7 days";
    case "14d":
      return "14 days";
  }
}

export function topCreatorsSinceClause(
  col: string,
  period: TopCreatorsPeriod,
): string {
  return `AND ${col} >= NOW() - INTERVAL '${topCreatorsPeriodToInterval(period)}'`;
}

export function topCreatorsSinceDate(
  period: TopCreatorsPeriod,
  now: Date = new Date(),
): Date {
  const days = period === "3d" ? 3 : period === "7d" ? 7 : 14;
  return new Date(now.getTime() - days * 86_400_000);
}
