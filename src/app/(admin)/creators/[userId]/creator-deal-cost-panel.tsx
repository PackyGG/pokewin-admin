import { Coins, Info } from "lucide-react";

import {
  SectionHeading,
  StatPanel,
  PanelRow,
} from "@/components/modern-panels";
import { safeQuery } from "@/lib/errors/safe-query";
import { formatCurrency, formatNumber } from "@/lib/utils/format";

import { getCreatorLeaderboardCost } from "./_queries/leaderboard-cost-by-creator";
import { getCreatorMultiplierCost } from "./_queries/multiplier-cost-by-creator";
import { getCreatorFillConversionCost } from "./_queries/fill-conversion-cost-by-creator";
import { getCreatorTipsSponsorCost } from "./_queries/tips-sponsor-cost-by-creator";

/**
 * Per-creator "Deal Costs" panel for /creators/[userId].
 *
 * Surfaces the house-funded outflows tied to THIS creator's promo
 * programs — the money we spend ON the creator (and their leaderboards),
 * distinct from the affiliate-cohort P&L the CreatorPnlPanel shows. Every
 * figure is a House-POV cost, so all are rose. The panel covers BOTH deal
 * shapes — a creator only ever has fill OR multiplier numbers, never both,
 * so each cost line renders only when it actually applies:
 *
 *   • Leaderboard Prizes — `affiliate_leaderboard_prize` net of the
 *     creation/refund escrow lifecycle, weighted by the admin sponsored
 *     %. Shown whenever the creator owns any approved leaderboard.
 *   • Fill-deal payouts  — the `creator_fill_conversion` "stream payout"
 *     vouchers this creator cashed out of the WEEKLY FILL program (the
 *     withdrawal cap they realized). The common fill-deal creator's main
 *     payout — previously invisible on this panel.
 *   • Tips & sponsor     — the house-funded tips / battle sponsors the
 *     creator handed out of their fill pool, summed from the per-session
 *     spend counters (`tips_spent_this_session_usd` +
 *     `sponsorship_spent_this_session_usd`) across ALL the creator's
 *     sessions, so it reconciles with the per-session figures on the
 *     Sessions tab.
 *   • Multiplier Payouts — `creator_multiplier_payout` withdrawable
 *     vouchers issued at end-of-stream settlement. MULTIPLIER deals only.
 *   • Multiplier Fill (net) — net `creator_fill_*` the house funded
 *     (activation credit minus the unspent refund). MULTIPLIER deals only.
 *
 * Show-only-if-relevant: a fill-deal creator sees Leaderboard + Fill
 * payout + Tips/sponsor; a multiplier-deal creator sees Leaderboard +
 * Multiplier payout + Multiplier fill. A zero line is hidden rather than
 * rendered as a useless "—" (the leaderboard line is the one exception —
 * it stays visible whenever the creator owns any approved board, so its
 * gross/refund context can show).
 *
 * Every sub-query is best-effort: a failure in one degrades that line to
 * 0 rather than blanking the whole panel. The tips/sponsor sum runs
 * through `safeQuery → 0` (and is derived from the backend's per-session
 * spend counters, walking every session page) so a backend outage or a
 * 404 (user isn't a creator on the backend) degrades it to 0 instead of
 * throwing the panel down. The panel itself is streamed via Suspense from
 * the page so none of these backend round-trips extends the rest of the
 * page's TTFB.
 */
export async function CreatorDealCostPanel({ userId }: { userId: string }) {
  // Independent best-effort fetches — one blowing up shouldn't sink the
  // others (or the panel). The leaderboard / multiplier / fill-conversion
  // fetches degrade to null → their lines hide; the tips/sponsor sum
  // (derived from the backend per-session spend counters) runs through
  // safeQuery → 0 so a backend outage or a non-creator 404 returns 0
  // instead of throwing.
  const [leaderboard, multiplier, fillConversion, tipsSponsorResult] =
    await Promise.all([
      getCreatorLeaderboardCost(userId).catch((e) => {
        console.error(
          "[creator-deal-cost] leaderboard cost fetch failed (line hidden):",
          e,
        );
        return null;
      }),
      getCreatorMultiplierCost(userId).catch((e) => {
        console.error(
          "[creator-deal-cost] multiplier cost fetch failed (lines hidden):",
          e,
        );
        return null;
      }),
      getCreatorFillConversionCost(userId).catch((e) => {
        console.error(
          "[creator-deal-cost] fill-conversion cost fetch failed (line hidden):",
          e,
        );
        return null;
      }),
      safeQuery(
        () => getCreatorTipsSponsorCost(userId),
        { costUsd: 0, eventCount: 0 },
        "creators.detail.tipsSponsorCost",
      ),
    ]);

  const leaderboardCost = leaderboard?.costUsd ?? 0;
  const multiplierPayoutCost = multiplier?.payoutUsd ?? 0;
  const multiplierFillCost = multiplier?.netFillUsd ?? 0;
  const fillPayoutCost = fillConversion?.payoutUsd ?? 0;
  const tipsSponsorCost = tipsSponsorResult.data.costUsd;

  // Total = sum of every cost actually tied to this creator. A fill-deal
  // creator's total is leaderboard + fill payout + tips/sponsor; a
  // multiplier creator's is leaderboard + multiplier payout + multiplier
  // fill. The disjoint ledger origins mean summing all five never
  // double-counts.
  const totalCost =
    leaderboardCost +
    fillPayoutCost +
    tipsSponsorCost +
    multiplierPayoutCost +
    multiplierFillCost;

  // Headline honesty: when one of the best-effort sources failed to load
  // (degraded to null), its contribution is 0, so the total is a LOWER
  // BOUND. We still show the figure — it's the best available — but flag
  // it as partial so an understated total doesn't read as complete. The
  // tips/sponsor source degrades to 0 in-band via safeQuery, so a failure
  // there is also reflected here.
  const anyFetchFailed =
    leaderboard === null ||
    multiplier === null ||
    fillConversion === null ||
    tipsSponsorResult.error !== null;
  const isPartial = anyFetchFailed;
  const hasCost = totalCost > 0;

  // Show-only-if-relevant. Leaderboard stays visible whenever the creator
  // owns any approved board (so its gross/refund context can render even
  // at $0); every other line renders only when its value is non-zero, so
  // a fill creator never sees empty multiplier rows and vice-versa.
  const showLeaderboard =
    (leaderboard?.leaderboardCount ?? 0) > 0 || leaderboardCost > 0;
  const showFillPayout = fillPayoutCost > 0;
  const showTipsSponsor = tipsSponsorCost > 0;
  const showMultiplierPayout = multiplierPayoutCost > 0;
  const showMultiplierFill = multiplierFillCost > 0;

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
                ? "Partial — a cost source failed to load, so this is a lower bound"
                : "Combined house-funded cost tied to this creator — leaderboard prizes, fill-deal payouts, house-funded tips/sponsor, and (for multiplier deals) multiplier payouts + fill"
            }
          >
            {totalCost === 0
              ? "—"
              : `${isPartial ? "≥ " : ""}${formatCurrency(totalCost)}`}
          </div>
          <p className="text-xs text-muted-foreground">
            Leaderboard prizes + fill-deal payouts + tips/sponsor (+
            multiplier payouts + fill)
            <br />
            <span className="text-[10px]">
              {isPartial
                ? "Partial — a cost source failed to load (lower bound)"
                : "House-POV cost (rose) — money we spend on this creator's promos"}
            </span>
          </p>
        </div>

        <div className="mt-3 flex items-start gap-2 rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
          <Info className="size-3.5 shrink-0 mt-0.5" />
          <span>
            Separate from the Affiliates P&amp;L above (deposits − card
            withdrawals from the cohort). This is what the house spends ON
            the creator across BOTH deal shapes: approved-leaderboard prizes
            (net of the creation/refund escrow, weighted by sponsored %),
            fill-deal payout vouchers the creator cashed out, house-funded
            tips/sponsor, and — for multiplier deals — multiplier payout
            vouchers + net multiplier fill. Excludes affiliate commission —
            that&apos;s on the Financials card.
          </span>
        </div>

        <div className="mt-4 space-y-0.5">
          {showLeaderboard && (
            <>
              <PanelRow
                label="Leaderboard Prizes"
                value={
                  leaderboardCost === 0 ? "—" : formatCurrency(leaderboardCost)
                }
                valueClassName={
                  leaderboardCost > 0
                    ? "text-rose-600 dark:text-rose-400"
                    : undefined
                }
              />
              {/* Sub-context for the leaderboard line: gross prize
                  committed, refunds returned, board count — so the net
                  cost is verifiable at a glance. */}
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
            </>
          )}

          {/* Fill-deal payout — the `creator_fill_conversion` "stream
              payout" vouchers this creator cashed out (the withdrawal cap
              they realized). The common fill-deal creator's main house
              cost. Shown only when non-zero. */}
          {showFillPayout && (
            <PanelRow
              label="Fill-deal payouts (cashed-out vouchers)"
              value={formatCurrency(fillPayoutCost)}
              valueClassName="text-rose-600 dark:text-rose-400"
            />
          )}

          {/* Tips & sponsor — house-funded tips / battle sponsors the
              creator handed out of their fill pool, summed across ALL
              sessions from the per-session spend counters (matches the
              Sessions tab's per-row "Spent on community"). Shown only when
              non-zero. */}
          {showTipsSponsor && (
            <PanelRow
              label="Tips & sponsor (house-funded)"
              value={formatCurrency(tipsSponsorCost)}
              valueClassName="text-rose-600 dark:text-rose-400"
            />
          )}

          {/* Multiplier rows — only a multiplier-deal creator has these;
              hidden for a fill-only creator rather than shown as "—". */}
          {showMultiplierPayout && (
            <PanelRow
              label="Multiplier Payouts"
              value={formatCurrency(multiplierPayoutCost)}
              valueClassName="text-rose-600 dark:text-rose-400"
            />
          )}
          {showMultiplierFill && (
            <PanelRow
              label="Multiplier Fill (net)"
              value={formatCurrency(multiplierFillCost)}
              valueClassName="text-rose-600 dark:text-rose-400"
            />
          )}

          {/* All five lines hidden (a creator with no leaderboard, no fill
              payout, no tips, no multiplier) → make the empty state
              explicit instead of an apparently-truncated panel. */}
          {!showLeaderboard &&
            !showFillPayout &&
            !showTipsSponsor &&
            !showMultiplierPayout &&
            !showMultiplierFill && (
              <p className="py-1 text-xs text-muted-foreground">
                No house-funded deal costs recorded for this creator yet.
              </p>
            )}
        </div>
      </StatPanel>
    </div>
  );
}
