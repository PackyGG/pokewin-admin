"use client";

import { formatCurrency } from "@/lib/utils/format";

export const PRIZE_PERCENT_OPTIONS = [3, 5, 10, 15, 20, 25, 50] as const;

export function roundPrizeUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

export function ChallengeSummaryHeader({
  title,
  edgeLabel,
}: {
  title: string;
  edgeLabel: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b bg-muted/25 px-4 py-2.5">
      <p className="shrink-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      <p className="text-right text-[10px] text-muted-foreground">{edgeLabel}</p>
    </div>
  );
}

export function PrizePercentSection({
  theoreticalProfitUsd,
  activePrizePercent,
  onSelectPrizeAmount,
}: {
  theoreticalProfitUsd: number;
  activePrizePercent?: number | null;
  onSelectPrizeAmount?: (amount: number, percent: number) => void;
}) {
  if (!onSelectPrizeAmount) return null;

  return (
    <div className="border-t bg-muted/10 px-4 py-3">
      <p className="mb-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Prize as % of theoretical profit
      </p>
      <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
        {PRIZE_PERCENT_OPTIONS.map((percent) => {
          const amount = roundPrizeUsd((theoreticalProfitUsd * percent) / 100);
          const isActive = activePrizePercent === percent;
          const disabled = theoreticalProfitUsd <= 0;

          return (
            <button
              key={percent}
              type="button"
              disabled={disabled}
              onClick={() => onSelectPrizeAmount(amount, percent)}
              className={`flex w-full flex-col items-center rounded-md border px-2 py-1.5 text-center transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                isActive
                  ? "border-primary bg-primary/10 ring-1 ring-primary/30"
                  : "border-border/70 bg-background/80 hover:border-primary/40 hover:bg-accent/50"
              }`}
            >
              <span className="text-xs font-semibold tabular-nums">{percent}%</span>
              <span className="text-[10px] tabular-nums text-muted-foreground">
                {formatCurrency(amount)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

const ACCENT_STYLES = {
  sky: "border-sky-500/20 bg-sky-500/5 [&_[data-value]]:text-sky-700 dark:[&_[data-value]]:text-sky-300",
  rose: "border-rose-500/20 bg-rose-500/5 [&_[data-value]]:text-rose-600 dark:[&_[data-value]]:text-rose-400",
  violet:
    "border-violet-500/20 bg-violet-500/5 [&_[data-value]]:text-violet-700 dark:[&_[data-value]]:text-violet-300",
  emerald:
    "border-emerald-500/20 bg-emerald-500/5 [&_[data-value]]:text-emerald-600 dark:[&_[data-value]]:text-emerald-400",
  amber:
    "border-amber-500/20 bg-amber-500/5 [&_[data-value]]:text-amber-700 dark:[&_[data-value]]:text-amber-300",
  slate: "border-border/60 bg-background/60",
  purple:
    "border-purple-500/20 bg-purple-500/5 [&_[data-value]]:text-purple-700 dark:[&_[data-value]]:text-purple-300",
} as const;

export function MetricTile({
  label,
  value,
  hint,
  accent = "slate",
  className,
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: keyof typeof ACCENT_STYLES;
  className?: string;
}) {
  return (
    <div
      className={`rounded-lg border px-3 py-2.5 ${ACCENT_STYLES[accent]} ${className ?? ""}`}
    >
      <p className="whitespace-nowrap text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p data-value className="mt-1 text-sm font-bold tabular-nums leading-none">
        {value}
      </p>
      {hint ? (
        <p className="mt-1.5 text-[10px] leading-snug text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
