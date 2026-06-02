import { Coins, Info } from "lucide-react";

import {
  SectionHeading,
  StatPanel,
  PanelRow,
} from "@/components/modern-panels";
import { formatCurrency, formatNumber } from "@/lib/utils/format";

import { getCreatorLeaderboardCost } from "./_queries/leaderboard-cost-by-creator";
import { getCreatorMultiplierCost } from "./_queries/multiplier-cost-by-creator";

/**
 * Per-creator "Deal Costs" panel for /creators/[userId].
 *
 * Surfaces the house-funded outflows tied to THIS creator's promo
 * programs — the money we spend ON the creator (and their leaderboards),
 * distinct from the affiliate-cohort P&L the CreatorPnlPanel shows. All
 * three buckets are House-POV costs, so every figure is rose:
 *
 *   • Leaderboard Prizes — `affiliate_leaderboard_prize` net of the
 *     creation/refund escrow lifecycle, weighted by the admin sponsored
 *     %. THIS is the metric that was previously invisible on the creator
 *     view ("on multipliers creators there is no leaderboard costs").
 *   • Multiplier Payouts  — `creator_multiplier_payout` withdrawable
 *     vouchers issued at end-of-stream settlement.
 *   • Multiplier Fill     — net `creator_fill_*` the house funded
 *     (activation credit minus the unspent refund).
 *
 * Both sub-queries are best-effort: a failure in one renders that line
 * as "—" rather than blanking the whole panel. The panel itself is
 * streamed via Suspense from the page so neither backend round-trip
 * extends the rest of the page's TTFB.
 */
export async function CreatorDealCostPanel({ userId }: { userId: string }) {
  // Independent best-effort fetches — one blowing up shouldn't sink the
  // other (or the panel). Each degrades to null → the line renders "—".
  const [leaderboard, multiplier] = await Promise.all([
    getCreatorLeaderboardCost(userId).catch((e) => {
      console.error(
        "[creator-deal-cost] leaderboard cost fetch failed (line renders '—'):",
        e,
      );
      return null;
    }),
    getCreatorMultiplierCost(userId).catch((e) => {
      console.error(
        "[creator-deal-cost] multiplier cost fetch failed (line renders '—'):",
        e,
      );
      return null;
    }),
  ]);

  const leaderboardCost = leaderboard?.costUsd ?? 0;
  const multiplierCost = multiplier?.costUsd ?? 0;
  const totalCost = leaderboardCost + multiplierCost;
  // Headline honesty: when one source failed to load, the total is a
  // LOWER BOUND (the failed bucket contributes 0). We still show the
  // figure — it's the best available — but flag it as partial so the
  // admin doesn't read an understated total as complete. Both failing
  // renders "—".
  const bothLoaded = leaderboard !== null && multiplier !== null;
  const anyLoaded = leaderboard !== null || multiplier !== null;
  const isPartial = anyLoaded && !bothLoaded;
  const hasCost = totalCost > 0;

  return (
    <div className="space-y-3">
      <SectionHeading icon={Coins} title="Deal Costs (House)" />

      <StatPanel
        title="House cost to this creator"
        icon={Coins}
        // House cost → rose when there's a real spend; muted blue when
        // everything's zero so an idle creator doesn't read as alarming.
        accent={hasCost ? "rose" : "blue"}
      >
        <div className="space-y-1">
          <div
            className={
              hasCost
                ? "text-3xl font-bold tabular-nums leading-none text-rose-600 dark:text-rose-400 sm:text-4xl"
                : "text-3xl font-bold tabular-nums leading-none text-muted-foreground sm:text-4xl"
            }
            title={
              isPartial
                ? "Partial — one cost source failed to load, so this is a lower bound"
                : "Combined house-funded cost tied to this creator — leaderboard prizes + multiplier payouts + multiplier fill"
            }
          >
            {!anyLoaded
              ? "—"
              : totalCost === 0
                ? "—"
                : `${isPartial ? "≥ " : ""}${formatCurrency(totalCost)}`}
          </div>
          <p className="text-xs text-muted-foreground">
            Leaderboard prizes + multiplier payouts + multiplier fill
            <br />
            <span className="text-[10px]">
              {isPartial
                ? "Partial — one cost source failed to load (lower bound)"
                : "House-POV cost (rose) — money we spend on this creator's promos"}
            </span>
          </p>
        </div>

        <div className="mt-3 flex items-start gap-2 rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
          <Info className="size-3.5 shrink-0 mt-0.5" />
          <span>
            Separate from the Affiliates P&amp;L above (deposits − card
            withdrawals from the cohort). This is what the house spends ON
            the creator: approved-leaderboard prizes (net of the
            creation/refund escrow, weighted by sponsored %), multiplier
            payout vouchers, and net multiplier fill. Excludes affiliate
            commission — that&apos;s on the Financials card.
          </span>
        </div>

        <div className="mt-4 space-y-0.5">
          <PanelRow
            label="Leaderboard Prizes"
            value={
              leaderboard === null
                ? "—"
                : leaderboardCost === 0
                  ? "—"
                  : formatCurrency(leaderboardCost)
            }
            valueClassName={
              leaderboardCost > 0
                ? "text-rose-600 dark:text-rose-400"
                : undefined
            }
          />
          {/* Sub-context for the leaderboard line: gross prize committed,
              refunds returned, board count — so the net cost is
              verifiable at a glance. Only shown when there's something
              to break down. */}
          {leaderboard !== null && leaderboard.leaderboardCount > 0 && (
            <div className="space-y-0.5 pb-1 pl-3 text-[11px] text-muted-foreground">
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-1.5">
                  <span aria-hidden className="opacity-60">
                    •
                  </span>
                  Gross prize · {formatNumber(leaderboard.leaderboardCount)}{" "}
                  approved
                </span>
                <span className="tabular-nums">
                  {formatCurrency(leaderboard.grossPrizeUsd)}
                </span>
              </div>
              {leaderboard.refundedUsd > 0 && (
                <div className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-1.5">
                    <span aria-hidden className="opacity-60">
                      •
                    </span>
                    Refunded (cancelled)
                  </span>
                  <span className="tabular-nums">
                    −{formatCurrency(leaderboard.refundedUsd)}
                  </span>
                </div>
              )}
            </div>
          )}
          <PanelRow
            label="Multiplier Payouts"
            value={
              multiplier === null
                ? "—"
                : multiplier.payoutUsd === 0
                  ? "—"
                  : formatCurrency(multiplier.payoutUsd)
            }
            valueClassName={
              (multiplier?.payoutUsd ?? 0) > 0
                ? "text-rose-600 dark:text-rose-400"
                : undefined
            }
          />
          <PanelRow
            label="Multiplier Fill (net)"
            value={
              multiplier === null
                ? "—"
                : multiplier.netFillUsd === 0
                  ? "—"
                  : formatCurrency(multiplier.netFillUsd)
            }
            valueClassName={
              (multiplier?.netFillUsd ?? 0) > 0
                ? "text-rose-600 dark:text-rose-400"
                : undefined
            }
          />
        </div>
      </StatPanel>
    </div>
  );
}
