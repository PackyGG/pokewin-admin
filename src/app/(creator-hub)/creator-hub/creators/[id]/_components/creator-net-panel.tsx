import { Info, Scale } from "lucide-react";

import {
  StatPanel,
  PanelRow,
  type AccentColor,
} from "@/components/modern-panels";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { HubNotice } from "../../../_components/hub-notice";

import { getCreatorNetData } from "../_queries/overview-data";

/**
 * Creator Net (P&L) box — the Performance section's lead figure.
 *
 *   net = affiliatesMadeUs − houseCost
 *
 * House-POV: net > 0 → the creator is profitable for the house → emerald;
 * net < 0 → he cost more than he earned → rose. An (i) hover (native title
 * tooltip, exactly like the /dashboard tooltips) explains the math.
 *
 * Breakdown rows (owner spec): Affiliates made us / House cost / Fill-deal
 * payouts / Tips & sponsor — plus the leaderboard + multiplier cost lines
 * that make up the house cost. Reuses the EXISTING creator-net-P&L cost
 * queries via `getCreatorNetData`; nothing fabricated.
 *
 * Best-effort: a failed cost source degrades to 0 (house cost becomes a
 * LOWER bound → net an UPPER bound, flagged "≤"); a failed revenue read
 * degrades the net + revenue row to "unavailable" while the cost breakdown
 * still renders. Streamed in its own Suspense boundary from the Overview tab.
 */
export async function CreatorNetPanel({ userId }: { userId: string }) {
  const net = await getCreatorNetData(userId);

  const revenueLoaded = net.affiliatesMadeUsUsd !== null;
  const affiliatesMadeUs = net.affiliatesMadeUsUsd ?? 0;
  const houseCost = net.houseCostUsd;
  const netValue = affiliatesMadeUs - houseCost;
  const isPositive = revenueLoaded && netValue > 0;
  const isNegative = revenueLoaded && netValue < 0;

  const heroAccent: AccentColor = isPositive
    ? "emerald"
    : isNegative
      ? "rose"
      : "blue";
  const heroTextClass = isPositive
    ? "text-emerald-600 dark:text-emerald-400"
    : isNegative
      ? "text-rose-600 dark:text-rose-400"
      : "text-muted-foreground";
  const heroValue = !revenueLoaded
    ? "—"
    : netValue === 0
      ? "—"
      : `${net.partial ? "≤ " : ""}${netValue > 0 ? "+" : ""}${formatCurrency(netValue)}`;

  // Show-only-if-relevant cost lines (a creator only ever has fill OR
  // multiplier numbers, never both). Leaderboard stays visible whenever the
  // creator owns any approved board so its gross/refund context can render.
  const showLeaderboard = net.leaderboardCount > 0 || net.leaderboardCostUsd > 0;
  const showFillPayout = net.fillPayoutUsd > 0;
  const showTipsSponsor = net.tipsSponsorUsd > 0;
  const showMultiplierPayout = net.multiplierPayoutUsd > 0;
  const showMultiplierFill = net.multiplierFillUsd > 0;
  const noCostLines =
    !showLeaderboard &&
    !showFillPayout &&
    !showTipsSponsor &&
    !showMultiplierPayout &&
    !showMultiplierFill;

  // Partial-failure messaging is deliberately reduced to ONE place: the
  // small status line under the hero (plus the "≤" prefix on the hero
  // itself). The (i) hover always explains the math; the footer explainer
  // stays static. Truthful wording still distinguishes a timed-out scan
  // ("taking too long") from a thrown one ("failed").
  const revenueTimedOut = net.revenueKind === "timeout";
  const heroTitle =
    "Affiliates made us − house cost. Positive (emerald) = this creator was profitable for the house; negative (rose) = he cost more than his affiliates earned.";

  return (
    <StatPanel title="Creator Net (P&L)" icon={Scale} accent={heroAccent}>
      {/* NET hero + (i) hover */}
      <div className="space-y-1">
        <div className="flex items-baseline gap-2">
          <div
            className={cn(
              "text-3xl font-bold tabular-nums leading-none sm:text-4xl",
              heroTextClass,
            )}
            title={heroTitle}
          >
            {heroValue}
          </div>
          <span
            title={heroTitle}
            aria-label="What this metric means"
            className="cursor-help text-muted-foreground/70"
          >
            <Info className="size-4" />
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          Net P&amp;L for this creator — affiliates made us − house cost
          <br />
          <span className="text-[10px]">
            {!revenueLoaded
              ? revenueTimedOut
                ? "Net unavailable — affiliate P&L timed out, refresh to retry (cost breakdown still shown)"
                : "Net unavailable — affiliate P&L failed to load (cost breakdown still shown)"
              : net.partial
                ? "Partial — a cost source failed to load (net is an upper bound)"
                : "House-POV — emerald = profitable for the house, rose = he cost more than he earned"}
          </span>
        </p>
      </div>

      {/* Reconciliation rows: revenue + cost = net */}
      <div className="mt-4 space-y-0.5">
        <PanelRow
          label="Affiliates made us"
          value={
            !revenueLoaded
              ? "unavailable"
              : affiliatesMadeUs === 0
                ? "—"
                : `${affiliatesMadeUs > 0 ? "+" : ""}${formatCurrency(affiliatesMadeUs)}`
          }
          valueClassName={
            !revenueLoaded
              ? "text-muted-foreground"
              : affiliatesMadeUs > 0
                ? "text-emerald-600 dark:text-emerald-400"
                : affiliatesMadeUs < 0
                  ? "text-rose-600 dark:text-rose-400"
                  : undefined
          }
        />
        <PanelRow
          label="House cost"
          value={houseCost === 0 ? "—" : `−${formatCurrency(houseCost)}`}
          valueClassName={
            houseCost > 0 ? "text-rose-600 dark:text-rose-400" : undefined
          }
        />
      </div>

      {/* House-cost sub-breakdown */}
      <div className="mt-2 space-y-0.5 border-l border-border/60 pl-3">
        {showLeaderboard && (
          <>
            <PanelRow
              label="Leaderboard prizes"
              value={
                net.leaderboardCostUsd === 0
                  ? "—"
                  : formatCurrency(net.leaderboardCostUsd)
              }
              valueClassName={
                net.leaderboardCostUsd > 0
                  ? "text-rose-600 dark:text-rose-400"
                  : undefined
              }
            />
            {net.leaderboardCount > 0 && (
              <div className="space-y-0.5 pb-1 pl-3 text-[11px] text-muted-foreground">
                <div className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-1.5">
                    <span aria-hidden className="opacity-60">
                      •
                    </span>
                    Gross prize · {formatNumber(net.leaderboardCount)} approved
                  </span>
                  <span className="tabular-nums">
                    {formatCurrency(net.leaderboardGrossUsd)}
                  </span>
                </div>
                {net.leaderboardRefundedUsd > 0 && (
                  <div className="flex items-center justify-between gap-3">
                    <span className="flex items-center gap-1.5">
                      <span aria-hidden className="opacity-60">
                        •
                      </span>
                      Refunded (cancelled)
                    </span>
                    <span className="tabular-nums">
                      −{formatCurrency(net.leaderboardRefundedUsd)}
                    </span>
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {showFillPayout && (
          <PanelRow
            label="Fill-deal payouts (cashed-out vouchers)"
            value={formatCurrency(net.fillPayoutUsd)}
            valueClassName="text-rose-600 dark:text-rose-400"
          />
        )}

        {showTipsSponsor && (
          <PanelRow
            label="Tips & sponsor (house-funded)"
            value={formatCurrency(net.tipsSponsorUsd)}
            valueClassName="text-rose-600 dark:text-rose-400"
          />
        )}

        {showMultiplierPayout && (
          <PanelRow
            label="Multiplier payouts"
            value={formatCurrency(net.multiplierPayoutUsd)}
            valueClassName="text-rose-600 dark:text-rose-400"
          />
        )}
        {showMultiplierFill && (
          <PanelRow
            label="Multiplier fill (net)"
            value={formatCurrency(net.multiplierFillUsd)}
            valueClassName="text-rose-600 dark:text-rose-400"
          />
        )}

        {noCostLines && (
          <p className="py-1 text-xs text-muted-foreground">
            No house-funded deal costs recorded for this creator yet.
          </p>
        )}
      </div>

      <HubNotice tone="muted" icon={Info} dashed className="mt-4">
        Net = what this creator&apos;s affiliates earned the house (cohort
        deposits − card withdrawals, capped 365d) minus the house cost spent
        ON the creator: approved-leaderboard prizes (net of escrow, weighted
        by sponsored %), fill-deal payout vouchers, house-funded
        tips/sponsor, and — for multiplier deals — multiplier payouts + net
        multiplier fill. Excludes affiliate commission.
      </HubNotice>
    </StatPanel>
  );
}
