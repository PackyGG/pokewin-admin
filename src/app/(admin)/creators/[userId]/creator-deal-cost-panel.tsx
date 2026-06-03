import { Info, Scale } from "lucide-react";

import {
  SectionHeading,
  StatPanel,
  PanelRow,
  type AccentColor,
} from "@/components/modern-panels";
import { safeQuery } from "@/lib/errors/safe-query";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

import { getCreatorPnlCached } from "./_queries/_pnl-cache";
import { getCreatorLeaderboardCost } from "./_queries/leaderboard-cost-by-creator";
import { getCreatorMultiplierCost } from "./_queries/multiplier-cost-by-creator";
import { getCreatorFillConversionCost } from "./_queries/fill-conversion-cost-by-creator";
import { getCreatorTipsSponsorCost } from "./_queries/tips-sponsor-cost-by-creator";

/**
 * Per-creator "Creator Net" P&L panel for /creators/[userId].
 *
 * The panel leads with the NET this creator represents for the house —
 * what his affiliates earned us minus what the house spent on his promo
 * programs:
 *
 *   net = affiliatesMadeUs − houseCost
 *
 * The NET is the hero figure (House-POV: net > 0 → the creator is
 * profitable for the house → emerald; net < 0 → he cost more than he
 * earned → rose). Beneath it, two supporting rows reconcile to the net —
 * "Affiliates made us +$X" (cohort revenue, emerald) and "House cost −$Y"
 * (rose) — and the house cost expands into its per-bucket breakdown.
 *
 * The house cost itself is the sum of the house-funded outflows tied to
 * THIS creator's promo programs — the money we spend ON the creator (and
 * their leaderboards), distinct from the affiliate-cohort P&L the
 * CreatorPnlPanel shows. Every cost figure is a House-POV cost, so all are
 * rose. The cost breakdown covers BOTH deal shapes — a creator only ever
 * has fill OR multiplier numbers, never both, so each cost line renders
 * only when it actually applies:
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
 * `affiliatesMadeUs` (the revenue side of the net) is the SAME figure the
 * CreatorPnlPanel above renders — `getCreatorPnl(userId).lifetime.pnl`
 * (cohort deposits − card withdrawals, capped 365d) — so the two panels
 * agree. House-POV colors: cohort revenue → emerald, house cost → rose,
 * and the net → emerald when the creator was profitable for the house
 * (> 0), rose when he cost more than he earned (< 0).
 *
 * NET ALWAYS LEADS, even on a degraded P&L. The affiliate-P&L fetch is
 * best-effort: if it fails it degrades to null, but the panel does NOT
 * fall back to surfacing the bare cost as the headline. Instead the NET
 * hero structure stays — the net + the revenue row render as
 * "unavailable / —" while the cost breakdown still shows — so the panel
 * never reverts to "cost is the main thing."
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
  const [leaderboard, multiplier, fillConversion, tipsSponsorResult, pnl] =
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
      // Affiliate-cohort P&L for the "Creator Net" block — the SAME
      // getCreatorPnlCached(userId) source the CreatorPnlPanel above renders
      // (lifetime capped 365d: cohort deposits − card withdrawals), so the
      // "Affiliates made us" figure here reconciles with the Affiliates P&L
      // shown earlier on the page AND de-duplicates onto the single warmed
      // cache entry (the scan runs once per render, not twice). Best-effort:
      // a failure degrades to null → the Net block is hidden rather than
      // blanking the panel; once the cohort scan resolves (warm or cold-
      // populated), `showNet` flips true and the Net block reappears.
      getCreatorPnlCached(userId).catch((e) => {
        console.error(
          "[creator-deal-cost] affiliate P&L fetch failed (Net block hidden):",
          e,
        );
        return null;
      }),
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

  // ── Creator Net (P&L) — the panel's HERO figure ──────────────────────
  // What this creator's affiliates EARNED the house, minus what the house
  // SPENT on him. "Affiliates made us" reuses the exact Affiliates P&L the
  // CreatorPnlPanel above renders — getCreatorPnl(userId).lifetime.pnl
  // (cohort deposits − card withdrawals, capped 365d) — so the two figures
  // reconcile. House cost is this panel's totalCost.
  //
  //   net = affiliatesMadeUs − houseCost
  //
  // House-POV colors: the cohort revenue is house income → emerald; the
  // house cost → rose; the net is emerald when the creator was profitable
  // for the house (net > 0) and rose when he cost more than he earned
  // (net < 0).
  //
  // NET ALWAYS LEADS. `pnlLoaded` gates whether the revenue + net render
  // as real figures or as "unavailable / —": when the affiliate P&L
  // degrades to null we still lead with the net concept (hero shows "—",
  // revenue row shows "unavailable") rather than falling back to the bare
  // cost as the headline. The cost breakdown is shown either way.
  const pnlLoaded = pnl !== null;
  const affiliatesMadeUs = pnl?.lifetime.pnl ?? 0;
  // Net only has meaning once the revenue side loaded; otherwise it's
  // unavailable (the cost alone is NOT the net).
  const net = affiliatesMadeUs - totalCost;
  const isNetPositive = pnlLoaded && net > 0;
  const isNetNegative = pnlLoaded && net < 0;

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
  const noCostLines =
    !showLeaderboard &&
    !showFillPayout &&
    !showTipsSponsor &&
    !showMultiplierPayout &&
    !showMultiplierFill;

  // Hero accent (House-POV): the NET drives the panel tint — emerald when
  // the creator is profitable for the house (net > 0), rose when he costs
  // more than he earned (net < 0). When the affiliate P&L is unavailable
  // (or the net is exactly zero) fall back to a muted blue so a degraded /
  // idle creator doesn't read as alarming. Mirrored by `netHeroTextClass`
  // for the hero number itself.
  const heroAccent: AccentColor = isNetPositive
    ? "emerald"
    : isNetNegative
      ? "rose"
      : "blue";
  const netHeroTextClass = isNetPositive
    ? "text-emerald-600 dark:text-emerald-400"
    : isNetNegative
      ? "text-rose-600 dark:text-rose-400"
      : "text-muted-foreground";
  // The hero number: "+$X" / "−$X" once the P&L loaded; an em-dash while
  // unavailable. The "≥"/"≤" lower/upper-bound flag carries through from a
  // partial cost source (a higher cost → a lower net, so the displayed net
  // is an UPPER bound when partial).
  const netHeroValue = !pnlLoaded
    ? "—"
    : net === 0
      ? "—"
      : `${isPartial ? "≤ " : ""}${net > 0 ? "+" : ""}${formatCurrency(net)}`;

  return (
    <div className="space-y-3">
      <SectionHeading icon={Scale} title="Creator Net (P&L)" />

      <StatPanel
        title="Net P&L (this creator)"
        icon={Scale}
        accent={heroAccent}
      >
        {/* ── NET hero ─────────────────────────────────────────────────
            The panel's primary figure. Affiliates-made-us − House cost.
            House-POV: net > 0 (creator profitable for the house) → emerald,
            net < 0 → rose, unavailable/zero → muted. Leads even when the
            affiliate P&L degrades (shows "—"); never falls back to the bare
            cost as the headline. */}
        <div className="space-y-1">
          <div className="flex items-baseline gap-2">
            <div
              className={cn(
                "text-3xl font-bold tabular-nums leading-none sm:text-4xl",
                netHeroTextClass,
              )}
              title={
                !pnlLoaded
                  ? "Net unavailable — the affiliate P&L couldn't be loaded. Affiliates made us − House cost; the cost breakdown below is still shown."
                  : isPartial
                    ? "Partial — a cost source failed to load, so the cost is a lower bound and this net is an upper bound"
                    : "Affiliates made us − House cost. Positive (emerald) = this creator was profitable for the house; negative (rose) = he cost more than his affiliates earned."
              }
            >
              {netHeroValue}
            </div>
            <span
              title="What this creator's affiliates earned the house, minus what the house spent on him."
              className="cursor-help text-muted-foreground/70"
            >
              <Info className="size-4" />
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            Net P&amp;L for this creator — affiliates made us − house cost
            <br />
            <span className="text-[10px]">
              {!pnlLoaded
                ? "Net unavailable — affiliate P&L couldn't be loaded (cost breakdown still shown)"
                : isPartial
                  ? "Partial — a cost source failed to load (net is an upper bound)"
                  : "House-POV — emerald = profitable for the house, rose = he cost more than he earned"}
            </span>
          </p>
        </div>

        {/* ── Reconciliation rows: revenue + cost = net ────────────────
            The two supporting figures that net out to the hero above —
            "Affiliates made us +$X" (cohort revenue, emerald) and "House
            cost −$Y" (rose), the latter expanding into its per-bucket
            breakdown. */}
        <div className="mt-4 space-y-0.5">
          <PanelRow
            label="Affiliates made us"
            value={
              !pnlLoaded
                ? "unavailable"
                : affiliatesMadeUs === 0
                  ? "—"
                  : `${affiliatesMadeUs > 0 ? "+" : ""}${formatCurrency(affiliatesMadeUs)}`
            }
            valueClassName={
              !pnlLoaded
                ? "text-muted-foreground"
                : affiliatesMadeUs > 0
                  ? "text-emerald-600 dark:text-emerald-400"
                  : affiliatesMadeUs < 0
                    ? "text-rose-600 dark:text-rose-400"
                    : undefined
            }
          />
          <PanelRow
            label={isPartial ? "House cost (≥, partial)" : "House cost"}
            value={totalCost === 0 ? "—" : `−${formatCurrency(totalCost)}`}
            valueClassName={
              totalCost > 0 ? "text-rose-600 dark:text-rose-400" : undefined
            }
          />
        </div>

        {/* House-cost sub-breakdown — the per-bucket cost lines that make
            up the "House cost" reconciliation row above. */}
        <div className="mt-2 space-y-0.5 border-l border-border/60 pl-3">
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

          {/* No cost lines (a creator with no leaderboard, no fill payout,
              no tips, no multiplier) → make the empty cost breakdown
              explicit instead of an apparently-truncated row. The "House
              cost" reconciliation row above already reads "—". */}
          {noCostLines && (
            <p className="py-1 text-xs text-muted-foreground">
              No house-funded deal costs recorded for this creator yet.
            </p>
          )}
        </div>

        {/* Reconciliation footnote — how the net is built, House-POV color
            legend, and the partial-data / unavailable caveats. */}
        <div className="mt-4 flex items-start gap-2 rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
          <Info className="size-3.5 shrink-0 mt-0.5" />
          <span>
            Net = what this creator&apos;s affiliates earned the house
            (deposits − card withdrawals from the cohort, capped 365d —
            reconciles with the Affiliates P&amp;L panel above) minus the
            house cost we spend ON the creator across BOTH deal shapes:
            approved-leaderboard prizes (net of the creation/refund escrow,
            weighted by sponsored %), fill-deal payout vouchers the creator
            cashed out, house-funded tips/sponsor, and — for multiplier
            deals — multiplier payout vouchers + net multiplier fill.
            Excludes affiliate commission — that&apos;s on the Financials
            card.
            {!pnlLoaded && (
              <>
                {" "}
                The affiliate-P&amp;L figure couldn&apos;t be loaded right
                now, so the net is unavailable; the house-cost breakdown is
                still shown.
              </>
            )}
            {pnlLoaded && isPartial && (
              <>
                {" "}
                A cost source failed to load, so the house cost is a lower
                bound and the net shown is an upper bound.
              </>
            )}
          </span>
        </div>
      </StatPanel>
    </div>
  );
}
