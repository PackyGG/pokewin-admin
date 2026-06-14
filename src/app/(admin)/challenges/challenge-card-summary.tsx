"use client";

import { useEffect, useState, useTransition } from "react";
import { ImageOff, Loader2 } from "lucide-react";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { getChallengeCardSummary, type ChallengeCardSummary } from "./actions";
import {
  formatDropChancePercent,
  formatExpectedOpenings,
} from "./challenge-card-math";
import { TARGET_HOUSE_EDGE } from "@/app/(admin)/insights/edge-calc/math";

/**
 * Rich odds + historical stats for the selected pack/card requirement in the
 * create-challenge dialog. Loads lazily when both ids are set.
 */
const PRIZE_PERCENT_OPTIONS = [3, 5, 10, 15, 20, 25, 50] as const;

export function ChallengeCardSummaryPanel({
  packId,
  cardId,
  activePrizePercent,
  onSelectPrizeAmount,
}: {
  packId: string | undefined;
  cardId: string | undefined;
  activePrizePercent?: number | null;
  onSelectPrizeAmount?: (amount: number, percent: number) => void;
}) {
  const [summary, setSummary] = useState<ChallengeCardSummary | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (!packId || !cardId) {
      setSummary(null);
      return;
    }
    startTransition(async () => {
      try {
        const data = await getChallengeCardSummary(packId, cardId);
        setSummary(data);
      } catch {
        setSummary(null);
      }
    });
  }, [packId, cardId]);

  if (!packId || !cardId) return null;

  if (isPending && !summary) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Loading card stats…
      </div>
    );
  }

  if (!summary) {
    return (
      <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
        Could not load stats for this card in the selected pack.
      </div>
    );
  }

  const edgePct = (TARGET_HOUSE_EDGE * 100).toFixed(2);

  return (
    <div className="overflow-hidden rounded-xl border bg-muted/15">
      <div className="flex items-center justify-between gap-2 border-b bg-muted/25 px-4 py-2.5">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Selected card summary
        </p>
        <p className="text-[10px] text-muted-foreground">
          Profit uses {edgePct}% planning edge
        </p>
      </div>

      <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-stretch sm:gap-5">
        {/* Card art — left, full bleed within column, no crop */}
        <div className="flex shrink-0 items-center justify-center self-center rounded-xl bg-gradient-to-b from-muted/50 to-muted/20 p-3 ring-1 ring-border/50 sm:self-stretch sm:px-4">
          {summary.cardImageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={summary.cardImageUrl}
              alt={summary.cardName}
              className="h-44 w-auto max-w-[9.5rem] object-contain drop-shadow-lg sm:h-52 sm:max-w-[11rem]"
            />
          ) : (
            <div className="flex h-44 w-28 flex-col items-center justify-center gap-2 rounded-lg bg-muted/60 text-muted-foreground sm:h-52 sm:w-32">
              <ImageOff className="size-8 opacity-60" />
              <span className="text-[10px]">No image</span>
            </div>
          )}
        </div>

        {/* Stats — right */}
        <div className="flex min-w-0 flex-1 flex-col justify-center gap-4">
          <div className="space-y-0.5">
            <p className="text-base font-semibold leading-snug">{summary.cardName}</p>
            <p className="text-sm text-muted-foreground">
              from{" "}
              <span className="font-medium text-foreground/80">{summary.packName}</span>
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <MetricTile
              label="Drop chance"
              value={formatDropChancePercent(summary.probabilityPercent)}
              accent="sky"
            />
            <MetricTile
              label="Card price"
              value={formatCurrency(summary.cardPriceUsd)}
              accent="rose"
            />
            <MetricTile
              label="Expected opens"
              value={formatExpectedOpenings(summary.expectedOpenings)}
              accent="violet"
            />
            <MetricTile
              label="Theoretical profit"
              value={formatCurrency(summary.theoreticalProfitUsd)}
              accent="emerald"
              hint={`${formatExpectedOpenings(summary.expectedOpenings)} × ${formatCurrency(summary.packPriceUsd)} × ${edgePct}%`}
              className="col-span-2 sm:col-span-1"
            />
            <MetricTile
              label="Times pulled"
              value={formatNumber(summary.cardPullCount)}
              accent="amber"
            />
            <MetricTile
              label="Pack opens"
              value={formatNumber(summary.packOpenCount)}
              accent="slate"
              hint="All time"
            />
          </div>
        </div>
      </div>

      {onSelectPrizeAmount ? (
        <div className="border-t bg-muted/10 px-4 py-3">
          <p className="mb-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Prize as % of theoretical profit
          </p>
          <div className="flex flex-wrap gap-1.5">
            {PRIZE_PERCENT_OPTIONS.map((percent) => {
              const amount = roundPrizeUsd(
                (summary.theoreticalProfitUsd * percent) / 100,
              );
              const isActive = activePrizePercent === percent;
              const disabled = summary.theoreticalProfitUsd <= 0;

              return (
                <button
                  key={percent}
                  type="button"
                  disabled={disabled}
                  onClick={() => onSelectPrizeAmount(amount, percent)}
                  className={`flex min-w-[3.25rem] flex-col items-center rounded-md border px-2 py-1.5 text-center transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
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
      ) : null}
    </div>
  );
}

function roundPrizeUsd(value: number): number {
  return Math.round(value * 100) / 100;
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
} as const;

function MetricTile({
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
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
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
