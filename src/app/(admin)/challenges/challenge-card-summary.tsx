"use client";

import { useEffect, useState, useTransition } from "react";
import { ImageOff, Loader2 } from "lucide-react";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { getChallengeCardSummary, type ChallengeCardSummary } from "./actions";
import {
  CARD_CHALLENGE_HOUSE_EDGE,
  formatDropChancePercent,
  formatExpectedOpenings,
} from "./challenge-card-math";
import {
  ChallengeSummaryHeader,
  MetricTile,
  PrizePercentSection,
} from "./challenge-summary-ui";

/**
 * Rich odds + historical stats for the selected pack/card requirement in the
 * create-challenge dialog. Loads lazily when both ids are set.
 */
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

  const edgePct = (CARD_CHALLENGE_HOUSE_EDGE * 100).toFixed(2);

  return (
    <div className="w-full overflow-hidden rounded-xl border bg-muted/15">
      <ChallengeSummaryHeader
        title="Selected card summary"
        edgeLabel={`Profit uses ${edgePct}% planning edge`}
      />

      <div className="flex w-full flex-col gap-4 p-4 sm:flex-row sm:items-start sm:gap-5">
        <div className="flex shrink-0 items-center justify-center self-center rounded-xl bg-gradient-to-b from-muted/50 to-muted/20 p-3 ring-1 ring-border/50 sm:w-[8.5rem]">
          {summary.cardImageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={summary.cardImageUrl}
              alt={summary.cardName}
              className="h-40 w-full object-contain drop-shadow-lg sm:h-48"
            />
          ) : (
            <div className="flex h-40 w-full flex-col items-center justify-center gap-2 rounded-lg bg-muted/60 text-muted-foreground sm:h-48">
              <ImageOff className="size-8 opacity-60" />
              <span className="text-[10px]">No image</span>
            </div>
          )}
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="space-y-0.5">
            <p className="text-base font-semibold leading-snug">{summary.cardName}</p>
            <p className="text-sm text-muted-foreground">
              from{" "}
              <span className="font-medium text-foreground/80">{summary.packName}</span>
            </p>
          </div>

          <div className="grid w-full grid-cols-2 gap-2.5">
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
              label="Times pulled"
              // `null` = the heavy historical-pull scan degraded (timed out
              // or failed); show "—" so the rest of the summary stays usable.
              value={
                summary.cardPullCount == null
                  ? "—"
                  : formatNumber(summary.cardPullCount)
              }
              accent="amber"
            />
            <MetricTile
              label="Pack opens"
              value={formatNumber(summary.packOpenCount)}
              accent="slate"
              hint="All time"
            />
            <MetricTile
              label="Theoretical profit"
              value={formatCurrency(summary.theoreticalProfitUsd)}
              accent="emerald"
              hint={`${formatExpectedOpenings(summary.expectedOpenings)} × ${formatCurrency(summary.packPriceUsd)} × ${edgePct}%`}
              className="col-span-2"
            />
          </div>
        </div>
      </div>

      <PrizePercentSection
        theoreticalProfitUsd={summary.theoreticalProfitUsd}
        activePrizePercent={activePrizePercent}
        onSelectPrizeAmount={onSelectPrizeAmount}
      />
    </div>
  );
}
