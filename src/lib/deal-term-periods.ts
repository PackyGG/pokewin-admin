import type { CreatorDealResponse } from "@/lib/backend-api";

const MS_PER_DAY = 86_400_000;
const MONEY_EPSILON = 0.005;

export type DealTermPeriodSummary = {
  /** Duration of one independently enforced backend deal row. */
  periodDays: number | null;
  /** Number of backend deal rows whose terms contribute to the frame. */
  periodCount: number;
  /** Uniform cap per row, or null when the rows use mixed cap amounts. */
  capPerPeriodUsd: number | null;
  /** Uniform tip/sponsor ceiling per row, or null for mixed terms. */
  tipSponsorPerPeriodUsd: number | null;
};

function finiteMoney(value: string | number | null | undefined): number {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) ? amount : 0;
}

function uniformValue(values: number[]): number | null {
  if (values.length === 0) return null;
  const first = values[0]!;
  return values.every((value) => Math.abs(value - first) < MONEY_EPSILON)
    ? first
    : null;
}

/**
 * Describe the actual recurrence represented by backend deal rows.
 *
 * A row can cover 7, 14, or the full selected number of days. Deriving this
 * from its enforced window avoids falsely labelling a two-week cap as weekly.
 * Mixed legacy rows still report the correct total cost; their per-period
 * breakdown is intentionally omitted instead of inventing an average.
 */
export function summarizeDealTermPeriods(
  deals: CreatorDealResponse[],
): DealTermPeriodSummary {
  const durations = deals.map((deal) => {
    const start = Date.parse(deal.week_start_utc);
    const end = Date.parse(deal.week_end_utc);
    const days = (end - start) / MS_PER_DAY;
    return Number.isFinite(days) && days > 0 && Number.isInteger(days)
      ? days
      : null;
  });
  const periodDays =
    durations.length > 0 &&
    durations[0] != null &&
    durations.every((days) => days === durations[0])
      ? durations[0]
      : null;

  const caps = deals.map((deal) => finiteMoney(deal.total_withdraw_cap_usd));
  const tipSponsors = deals.map((deal) => {
    const perFill =
      finiteMoney(deal.max_tip_per_stream_usd) +
      finiteMoney(deal.max_sponsorship_per_stream_usd);
    return perFill * Math.max(0, deal.fills_allowed ?? 0);
  });

  return {
    periodDays,
    periodCount: deals.length,
    capPerPeriodUsd: uniformValue(caps),
    tipSponsorPerPeriodUsd: uniformValue(tipSponsors),
  };
}

