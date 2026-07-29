export const ANALYTICS_2_PERIODS = ["7d", "30d", "90d"] as const;

export type Analytics2Period = (typeof ANALYTICS_2_PERIODS)[number];

export const ANALYTICS_2_PERIOD_LABELS: Record<Analytics2Period, string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
};

export const DEFAULT_ANALYTICS_2_PERIOD: Analytics2Period = "30d";

export function parseAnalytics2Period(
  value: string | undefined,
): Analytics2Period {
  return (ANALYTICS_2_PERIODS as readonly string[]).includes(value ?? "")
    ? (value as Analytics2Period)
    : DEFAULT_ANALYTICS_2_PERIOD;
}
