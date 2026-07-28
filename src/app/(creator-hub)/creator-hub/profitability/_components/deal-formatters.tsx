import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils/format";

/**
 * Shared formatters for the Profitability deal rows — ONE source of truth
 * for the House-POV colour classes, the length/cost-breakdown strings and
 * the right-cluster `Metric` cell, consumed by `deal-row.tsx` (both the
 * "active" and "past" variants render through these).
 */

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Conversion colour: ≥ 1× = the deal paid for itself (house win, emerald);
 * 0.5–1× warming up (amber); > 0 under half (rose); 0 = muted.
 */
export function conversionClass(rate: number): string {
  if (rate >= 1) return "text-emerald-600 dark:text-emerald-400";
  if (rate >= 0.5) return "text-amber-600 dark:text-amber-400";
  if (rate > 0) return "text-rose-600 dark:text-rose-400";
  return "text-muted-foreground";
}

/**
 * House-POV colour for Actual PnL / Affiliates Made Us. Positive = house
 * gain → emerald; negative = house loss → rose; zero = muted.
 */
export function housePnlClass(value: number): string {
  if (value > 0) return "text-emerald-600 dark:text-emerald-400";
  if (value < 0) return "text-rose-600 dark:text-rose-400";
  return "text-muted-foreground";
}

/** Deal length as whole weeks (with a day-count fallback under a week). */
export function dealLengthLabel(args: {
  frameStartMs: number | null;
  frameEndMs: number | null;
  dealWeeks: number;
}): string {
  const { frameStartMs, frameEndMs, dealWeeks } = args;
  if (frameStartMs == null || frameEndMs == null) return "—";
  if (dealWeeks <= 1) {
    const days = Math.max(
      1,
      Math.round((frameEndMs - frameStartMs) / MS_PER_DAY),
    );
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  return `${dealWeeks} weeks`;
}

/**
 * Cost-breakdown string: Cap · LB · Tip+Sponsor — the deal-cost legs
 * (cap + leaderboard + tips; there is NO daily-fill leg). Multi-week frames
 * show the "$Y/wk × N" maths so the total is auditable.
 */
export function costBreakdown(args: {
  dealWeeks: number;
  capUsd: number;
  weeklyCapUsd: number;
  tipSponsorUsd: number;
  weeklyTipSponsorUsd: number;
  leaderboardUsd: number;
}): string {
  const capLabel =
    args.dealWeeks > 1 && args.weeklyCapUsd > 0
      ? `Cap ${formatCurrency(args.capUsd)} (${formatCurrency(
          args.weeklyCapUsd,
        )}/wk × ${args.dealWeeks})`
      : `Cap ${formatCurrency(args.capUsd)}`;
  // Tip+sponsor recurs every fill the deal grants in its weekly window, and
  // the weekly figure scales across the leaderboard frame the same way cap
  // does (owner directive 2026-06-23) — show the multiplication.
  const tipLabel =
    args.dealWeeks > 1 && args.weeklyTipSponsorUsd > 0
      ? `Tip+Sponsor ${formatCurrency(args.tipSponsorUsd)} (${formatCurrency(
          args.weeklyTipSponsorUsd,
        )}/wk × ${args.dealWeeks})`
      : `Tip+Sponsor ${formatCurrency(args.tipSponsorUsd)}`;
  return `${capLabel} · LB ${formatCurrency(
    args.leaderboardUsd,
  )} · ${tipLabel}`;
}

/** Right-cluster metric cell (label over value, right-aligned on sm+). */
export function Metric({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className="sm:w-28 sm:text-right">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className={cn("text-sm font-semibold tabular-nums", className)}>
        {value}
      </div>
    </div>
  );
}
