"use client";

import { useMemo } from "react";
import { formatCurrency } from "@/lib/utils/format";
import {
  formatExpectedOpenings,
  expectedAttemptsFromMultiplier,
  theoreticalHouseProfitUsd,
  UPGRADER_CHALLENGE_HOUSE_EDGE,
  winChancePercentFromMultiplier,
} from "./challenge-card-math";
import {
  ChallengeSummaryHeader,
  MetricTile,
  PrizePercentSection,
} from "./challenge-summary-ui";
import {
  formatUpgraderChance,
  formatUpgraderMultiplier,
} from "@/lib/utils/upgrader-metadata";

/**
 * Planning profit summary for upgrader-hit requirements in the create dialog.
 * Derived client-side from min bet + min multiplier (10% house edge).
 */
export function ChallengeUpgraderSummaryPanel({
  minBetUsd,
  minMultiplier,
  activePrizePercent,
  onSelectPrizeAmount,
}: {
  minBetUsd: string;
  minMultiplier: string;
  activePrizePercent?: number | null;
  onSelectPrizeAmount?: (amount: number, percent: number) => void;
}) {
  const summary = useMemo(() => {
    const bet = parseFloat(minBetUsd);
    const mult = parseFloat(minMultiplier);
    if (!Number.isFinite(bet) || bet <= 0 || !Number.isFinite(mult) || mult <= 1) {
      return null;
    }

    const winChancePercent = winChancePercentFromMultiplier(mult);
    const expectedAttempts = expectedAttemptsFromMultiplier(mult);
    const theoreticalProfitUsd =
      expectedAttempts != null
        ? theoreticalHouseProfitUsd(
            expectedAttempts,
            bet,
            UPGRADER_CHALLENGE_HOUSE_EDGE,
          )
        : 0;

    return {
      bet,
      mult,
      winChancePercent,
      expectedAttempts,
      theoreticalProfitUsd,
    };
  }, [minBetUsd, minMultiplier]);

  if (!summary) return null;

  const edgePct = (UPGRADER_CHALLENGE_HOUSE_EDGE * 100).toFixed(0);

  return (
    <div className="w-full overflow-hidden rounded-xl border bg-muted/15">
      <ChallengeSummaryHeader
        title="Upgrader requirement summary"
        edgeLabel={`Profit uses ${edgePct}% planning edge`}
      />

      <div className="p-4">
        <div className="mb-3 space-y-0.5">
          <p className="text-base font-semibold leading-snug">
            Land {formatUpgraderMultiplier(summary.mult)} or higher
          </p>
          <p className="text-sm text-muted-foreground">
            Min bet{" "}
            <span className="font-medium text-foreground/80">
              {formatCurrency(summary.bet)}
            </span>
          </p>
        </div>

        <div className="grid w-full grid-cols-2 gap-2.5">
          <MetricTile
            label="Win chance"
            value={formatUpgraderChance(summary.winChancePercent)}
            accent="sky"
          />
          <MetricTile
            label="Min multiplier"
            value={formatUpgraderMultiplier(summary.mult)}
            accent="purple"
          />
          <MetricTile
            label="Min bet"
            value={formatCurrency(summary.bet)}
            accent="rose"
          />
          <MetricTile
            label="Expected attempts"
            value={formatExpectedOpenings(summary.expectedAttempts)}
            accent="violet"
          />
          <MetricTile
            label="Theoretical profit"
            value={formatCurrency(summary.theoreticalProfitUsd)}
            accent="emerald"
            hint={`${formatExpectedOpenings(summary.expectedAttempts)} × ${formatCurrency(summary.bet)} × ${edgePct}%`}
            className="col-span-2"
          />
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
