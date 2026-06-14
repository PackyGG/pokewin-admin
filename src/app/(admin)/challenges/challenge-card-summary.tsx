"use client";

import { useEffect, useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { CardImage } from "@/components/card-image";
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
export function ChallengeCardSummaryPanel({
  packId,
  cardId,
}: {
  packId: string | undefined;
  cardId: string | undefined;
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
    <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">Selected card summary</p>
        <p className="text-[10px] text-muted-foreground">
          Profit uses {(TARGET_HOUSE_EDGE * 100).toFixed(2)}% planning edge
        </p>
      </div>

      <div className="flex gap-3 rounded-md border bg-background/60 p-3">
        <div className="size-16 shrink-0 overflow-hidden rounded-lg bg-muted/40 ring-1 ring-border/60">
          <CardImage
            src={summary.cardImageUrl}
            alt={summary.cardName}
            className="size-full"
          />
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <div>
            <p className="truncate font-medium leading-tight">{summary.cardName}</p>
            <p className="truncate text-xs text-muted-foreground">
              from {summary.packName}
            </p>
          </div>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs sm:grid-cols-3">
            <Stat label="Drop chance" value={formatDropChancePercent(summary.probabilityPercent)} />
            <Stat label="Card price" value={formatCurrency(summary.cardPriceUsd)} houseLoss />
            <Stat
              label="Expected opens"
              value={formatExpectedOpenings(summary.expectedOpenings)}
            />
            <Stat
              label="Theoretical profit"
              value={formatCurrency(summary.theoreticalProfitUsd)}
              houseGain
              hint={`opens × ${formatCurrency(summary.packPriceUsd)} × ${edgePct}%`}
            />
            <Stat
              label="Times pulled"
              value={formatNumber(summary.cardPullCount)}
            />
            <Stat
              label="Pack opens (all time)"
              value={formatNumber(summary.packOpenCount)}
            />
          </dl>
        </div>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  houseLoss,
  houseGain,
}: {
  label: string;
  value: string;
  hint?: string;
  houseLoss?: boolean;
  houseGain?: boolean;
}) {
  const valueClass = houseLoss
    ? "text-rose-600 dark:text-rose-400"
    : houseGain
      ? "text-emerald-600 dark:text-emerald-400"
      : "text-foreground";

  return (
    <div>
      <dt className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className={`font-semibold tabular-nums ${valueClass}`}>{value}</dd>
      {hint ? (
        <dd className="mt-0.5 text-[10px] leading-snug text-muted-foreground">{hint}</dd>
      ) : null}
    </div>
  );
}
