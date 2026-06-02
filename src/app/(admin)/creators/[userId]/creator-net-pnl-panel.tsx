import { Suspense } from "react";
import Link from "next/link";
import {
  ArrowRight,
  BadgeDollarSign,
  Coins,
  Flame,
  HandCoins,
  Info,
  LineChart,
  ShieldAlert,
  TrendingDown,
  TrendingUp,
  Wallet,
} from "lucide-react";

import {
  SectionHeading,
  StatPanel,
  PanelRow,
  KpiTile,
  type AccentColor,
} from "@/components/modern-panels";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { type DashboardPeriod } from "@/lib/queries/dashboard-period";
import { cn } from "@/lib/utils";
import { safeQueryOrNull } from "@/lib/errors/safe-query";

import { getCreatorNetPnl } from "./_queries/creator-net-pnl";
import { getCodeHopperSummary } from "./_queries/code-hopper-summary";
import {
  CreatorWindowedGgrTile,
  CreatorWindowedGgrSkeleton,
} from "./creator-windowed-ggr-tile";
import { NetPnlPeriodSelector } from "./_components/net-pnl-period-selector";
import { InfoHint } from "../_components/info-hint";

/**
 * The single coherent financial story for /creators/[userId] — replaces
 * the three previously-disconnected panels (the gross "Affiliates PnL",
 * the separate "Deal Costs", and the commission line buried on the
 * Financials card) with ONE Net Creator P&L + a complete cost breakdown.
 *
 *   netPnl = codeUserGgr − totalCost          (House POV)
 *
 * Consumes the canonical foundation:
 *   • getCreatorNetPnl(userId, "all")              — the LIFETIME net,
 *     cost total, cost breakdown, commission, partial flag, AND the
 *     lifetime code-user GGR. The HEADLINE net uses this lifetime figure
 *     because `totalCost` is a lifetime aggregate (the backend has no
 *     per-window cost slice) — lifetime GGR − lifetime cost is the only
 *     apples-to-apples net. A "windowed GGR − lifetime cost" net would
 *     be misleading, so we never present one. Timeout-bounded via
 *     `safeQueryOrNull` so a slow lifetime scan degrades to a partial
 *     placeholder instead of hanging this Suspense segment.
 *   • getCodeHopperSummary(code)                   — aggregate code-hop
 *     risk for the small amber tile (drill-down lives on /…/users).
 *
 * The WINDOWED code-user GGR trend (the `?period=`-driven secondary view)
 * is split into its OWN async child — `CreatorWindowedGgrTile` — behind an
 * inner `<Suspense key={period}>`. A chip switch re-streams ONLY that
 * single cohort-GGR read; the lifetime net + 4-source cost above are NOT
 * re-fetched (they don't depend on the chip). Active-timeframe-only — one
 * window per render. The tile is mounted only when the chip isn't "all"
 * (windowed == lifetime there, so we never fire a redundant read).
 *
 * House POV (per CLAUDE.md), strict, no exceptions:
 *   • Net PnL  > 0 → cohort margin covered creator spend → 🟢 emerald
 *                < 0 → we spent more than the cohort returned → 🔴 rose
 *   • Code-User GGR / Wager / FTD volume → 🟢 emerald (user lost / paid in)
 *   • Creator Cost (every sub-line) → 🔴 rose (house outflow)
 *   • Active code-users → 🟠 amber (engaged cohort, neutral count)
 *
 * Streamed via Suspense from the page so its DB / backend round-trips
 * don't extend the rest of the page's TTFB.
 */
export async function CreatorNetPnlPanel({
  userId,
  period,
  code,
  ftdCount,
  activeReferrals7d,
  activeReferrals24h,
  wagerVolumeUsd,
}: {
  userId: string;
  period: DashboardPeriod;
  code: string | null;
  /** All-time FTDs on this creator's code (from the profile aggregate). */
  ftdCount: number;
  /** Distinct referrals active in the last 7d (the affiliate "active" window). */
  activeReferrals7d: number;
  /** Distinct referrals active in the last 24h — momentum sub-line. */
  activeReferrals24h: number;
  /** All-time real-customer wager volume on this code (profile aggregate). */
  wagerVolumeUsd: number;
}) {
  // Lifetime net + cost are always needed (headline). The WINDOWED GGR
  // trend is a SECONDARY, period-driven view rendered by its own streamed
  // child (CreatorWindowedGgrTile) so a chip switch never re-fetches this
  // lifetime block. The hopper summary is best-effort and only when the
  // creator has a code. Both lifetime reads are timeout-bounded so a slow
  // scan degrades to a placeholder instead of hanging this segment.
  const [lifetimeResult, hopper] = await Promise.all([
    safeQueryOrNull(
      () => getCreatorNetPnl(userId, "all"),
      "creators.netPnl.lifetime",
      15_000,
    ),
    code
      ? getCodeHopperSummary(code).catch(() => null)
      : Promise.resolve(null),
  ]);

  // Degrade to a zero-valued lifetime shape (flagged partial) when the
  // lifetime read failed / timed out, so the panel renders a sensible
  // placeholder rather than crashing the whole financial band.
  const lifetime = lifetimeResult.data ?? {
    period: "all" as DashboardPeriod,
    netPnl: 0,
    netPnlWithCommission: 0,
    codeUserGgr: {
      ggr: 0,
      wager: 0,
      gamingPayout: 0,
      inventoryPayout: 0,
      ledgerGamingPayout: 0,
      upgraderWager: 0,
      upgraderPayout: 0,
    },
    totalCost: {
      total: 0,
      totalWithCommission: 0,
      breakdown: {
        fillPayouts: 0,
        fillConversionPayouts: 0,
        netFill: 0,
        leaderboardCost: 0,
        commission: null,
      },
      partial: true,
    },
  };

  const { netPnl, netPnlWithCommission, codeUserGgr, totalCost } = lifetime;
  const { breakdown } = totalCost;
  // Mark partial when a cost source failed OR the whole lifetime read
  // degraded — the headline figures are then a lower bound / placeholder.
  const partial = totalCost.partial || lifetimeResult.data == null;

  // ── House-POV accents ──────────────────────────────────────────────
  const netWin = netPnl > 0;
  const netLoss = netPnl < 0;
  const netAccent: AccentColor = netWin ? "emerald" : netLoss ? "rose" : "blue";
  const netTextClass = netWin
    ? "text-emerald-600 dark:text-emerald-400"
    : netLoss
      ? "text-rose-600 dark:text-rose-400"
      : "text-muted-foreground";

  const ggrPositive = codeUserGgr.ggr > 0;
  const hasCost = totalCost.total > 0;
  const hasCommission = breakdown.commission != null && breakdown.commission > 0;

  const fmtSigned = (n: number): string =>
    n === 0 ? "—" : `${n > 0 ? "+" : ""}${formatCurrency(n)}`;

  return (
    <div className="space-y-4 sm:space-y-5">
      <SectionHeading
        icon={LineChart}
        title="Net Creator P&L"
        action={<NetPnlPeriodSelector />}
      />

      {/* ── KPI strip — the financial headline row. Net Creator PnL leads
          (lifetime, house-POV), then the two terms (GGR emerald, Cost
          rose), then acquisition context (FTDs purple, active code-users
          amber, wager volume emerald). 2 cols phone / 3 tablet / 6
          desktop. ───────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <KpiTile
          label="Net Creator PnL"
          value={netPnl === 0 ? "—" : fmtSigned(netPnl)}
          sub={`Lifetime${partial ? " · cost partial" : ""}`}
          icon={netWin ? TrendingUp : netLoss ? TrendingDown : LineChart}
          accent={netAccent}
          action={
            <InfoHint
              text="Lifetime code-user GGR minus everything we paid this creator (fill-deal + multiplier payouts + funded tips/sponsors + leaderboard share + commission). House POV — emerald = house up, rose = house down."
              side="bottom"
            />
          }
        />
        <KpiTile
          label="Code-User GGR"
          value={codeUserGgr.ggr === 0 ? "—" : formatCurrency(codeUserGgr.ggr)}
          sub="Lifetime · wager − payout"
          icon={Coins}
          accent="emerald"
          action={
            <InfoHint
              text="Gross gaming revenue (wager − payout) from players who used this creator's code, counted only during the 7-day attribution windows their code was active. Lifetime here; the trend panel below is windowed."
              side="bottom"
            />
          }
        />
        <KpiTile
          label="Creator Cost"
          value={
            totalCost.total === 0
              ? "—"
              : `${partial ? "≥ " : ""}${formatCurrency(totalCost.total)}`
          }
          sub={`Lifetime${partial ? " · lower bound" : ""}`}
          icon={HandCoins}
          accent="rose"
          action={
            <InfoHint
              text="Total the house paid this creator (lifetime): fill-deal payouts (converted vouchers) + multiplier-deal payouts + net fill + leaderboard sponsor share. Referral commission is shown separately in the breakdown below, not in this total."
              side="bottom"
            />
          }
        />
        {/* FTDs — distinct referrals on this code who actually deposited.
            All-time. Neutral funnel milestone → purple. */}
        <KpiTile
          label="FTDs"
          value={formatNumber(ftdCount)}
          sub="All-time depositors"
          icon={BadgeDollarSign}
          accent="purple"
          action={
            <InfoHint
              text="First-time depositors — distinct players who used this creator's code and deposited at least once (all-time)."
              side="bottom"
            />
          }
        />
        {/* Active code-users — distinct referrals with deposit/wager
            activity in the 7d affiliate window; 24h momentum in the sub.
            Engaged-cohort count → amber. */}
        <KpiTile
          label="Active code-users"
          value={formatNumber(activeReferrals7d)}
          sub={`${formatNumber(activeReferrals24h)} in 24h · 7d window`}
          icon={Flame}
          accent="amber"
          action={
            <InfoHint
              text="Distinct players on this creator's code with deposit or wager activity in the last 7 days. The sub-line shows the 24-hour count for momentum."
              side="bottom"
            />
          }
        />
        {/* Wager Volume — real-customer wager booked on this code,
            all-time. Money users risked → emerald (house POV). */}
        <KpiTile
          label="Wager Volume"
          value={wagerVolumeUsd === 0 ? "—" : formatCurrency(wagerVolumeUsd)}
          sub="All-time on this code"
          icon={Wallet}
          accent="emerald"
          action={
            <InfoHint
              text="All-time wager volume booked by real players on this creator's code (staff excluded). Money players risked = house income (emerald)."
              side="bottom"
            />
          }
        />
      </div>

      {/* ── Net Creator P&L hero — the headline net, decomposed into its
          two sides (Revenue = code-user GGR, emerald; Creator Cost =
          breakdown total, rose). Lifetime, apples-to-apples. ───────── */}
      <StatPanel
        title="Net Creator P&L · lifetime"
        icon={netWin ? TrendingUp : netLoss ? TrendingDown : LineChart}
        accent={netAccent}
        action={
          <InfoHint
            text="The headline net is lifetime: lifetime code-user GGR minus lifetime creator cost. The cost side is always lifetime (there's no per-window cost), so a windowed GGR is never netted against it — the period chip only drives the GGR trend panel below."
            side="left"
          />
        }
      >
        <div className="space-y-1">
          <div
            className={cn(
              "text-3xl font-bold tabular-nums leading-none sm:text-4xl",
              netTextClass,
            )}
            title="Net Creator P&L — lifetime code-user GGR minus lifetime creator cost (House POV)"
          >
            {netPnl === 0 ? "—" : fmtSigned(netPnl)}
          </div>
          <p className="text-xs text-muted-foreground">
            Lifetime code-user GGR − lifetime creator cost
            <br />
            <span className="text-[10px]">
              Positive (emerald) = the cohort&apos;s gaming margin covered
              what we spent on this creator · Negative (rose) = we spent
              more than the cohort returned
            </span>
          </p>
        </div>

        {/* Two-sided decomposition: Revenue (GGR, emerald) vs Creator
            Cost (the breakdown total, rose). Each carries a sub-row so
            the net is verifiable at a glance. */}
        <div className="mt-4 grid grid-cols-1 gap-x-6 gap-y-0.5 sm:grid-cols-2">
          <div>
            <PanelRow
              label="Revenue — Code-User GGR"
              value={
                codeUserGgr.ggr === 0 ? "—" : formatCurrency(codeUserGgr.ggr)
              }
              valueClassName={
                ggrPositive ? "text-emerald-600 dark:text-emerald-400" : ""
              }
            />
            <div className="space-y-0.5 pb-1 pl-3 text-[11px] text-muted-foreground">
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-1.5">
                  <span aria-hidden className="opacity-60">
                    •
                  </span>
                  Wager
                </span>
                <span className="tabular-nums">
                  {formatCurrency(codeUserGgr.wager)}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-1.5">
                  <span aria-hidden className="opacity-60">
                    •
                  </span>
                  Gaming payout
                </span>
                <span className="tabular-nums">
                  −{formatCurrency(codeUserGgr.gamingPayout)}
                </span>
              </div>
            </div>
          </div>
          <div>
            <PanelRow
              label="Creator Cost (lifetime)"
              value={
                totalCost.total === 0
                  ? "—"
                  : `${partial ? "≥ " : ""}${formatCurrency(totalCost.total)}`
              }
              valueClassName={
                hasCost ? "text-rose-600 dark:text-rose-400" : ""
              }
            />
            <div className="space-y-0.5 pb-1 pl-3 text-[11px] text-muted-foreground">
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-1.5">
                  <span aria-hidden className="opacity-60">
                    •
                  </span>
                  Fill + multiplier payouts + net fill + leaderboard
                </span>
                <span className="tabular-nums">see breakdown ↓</span>
              </div>
              {hasCommission && (
                <div className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-1.5">
                    <span aria-hidden className="opacity-60">
                      •
                    </span>
                    Commission (separate)
                  </span>
                  <span className="tabular-nums">
                    {formatCurrency(breakdown.commission ?? 0)}
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="mt-3 flex items-start gap-2 rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
          <Info className="size-3.5 shrink-0 mt-0.5" />
          <span>
            Lifetime net (House POV). The <strong>cost side is lifetime</strong>{" "}
            (the backend exposes no per-window cost slice), so the headline
            is lifetime GGR − lifetime cost — a true apples-to-apples net.
            The <code className="font-mono">?period=</code> chip drives the
            windowed GGR trend below; a windowed GGR is never netted against
            the lifetime cost.
            {partial && (
              <>
                {" "}
                One cost source failed to load — the cost (and the net) is a{" "}
                <strong>lower bound</strong>.
              </>
            )}
          </span>
        </div>
      </StatPanel>

      {/* ── Creator Cost breakdown — every house outflow tied to this
          creator, all rose. Commission is a SEPARATE line (not in the
          default total) + a "Net incl. commission" figure so the owner
          sees both. ──────────────────────────────────────────────── */}
      <StatPanel
        title="Creator Cost breakdown · lifetime"
        icon={Coins}
        accent={hasCost ? "rose" : "blue"}
        action={
          <InfoHint
            text="Every house outflow tied to this creator, lifetime (rose): fill-deal payouts (converted vouchers), multiplier-deal payouts, net fill (incl. funded tips/sponsors), and leaderboard sponsor share. Referral commission sits below the total as a separate line — the owner decides whether it counts as creator cost."
            side="left"
          />
        }
      >
        <div className="space-y-1">
          <div
            className={cn(
              "text-3xl font-bold tabular-nums leading-none sm:text-4xl",
              hasCost
                ? "text-rose-600 dark:text-rose-400"
                : "text-muted-foreground",
            )}
            title={
              partial
                ? "Partial — one cost source failed to load, so this is a lower bound"
                : "Total lifetime house cost on this creator (commission excluded — shown as a separate line)"
            }
          >
            {totalCost.total === 0
              ? "—"
              : `${partial ? "≥ " : ""}${formatCurrency(totalCost.total)}`}
          </div>
          <p className="text-xs text-muted-foreground">
            Fill + multiplier payouts + net fill + leaderboard cost
            <br />
            <span className="text-[10px]">
              House-POV cost (rose) — commission excluded from this total
              (separate line below)
              {partial && " · partial (lower bound)"}
            </span>
          </p>
        </div>

        <div className="mt-4 space-y-0.5">
          <PanelRow
            label="Fill-deal payouts (converted vouchers)"
            value={
              breakdown.fillConversionPayouts === 0
                ? "—"
                : formatCurrency(breakdown.fillConversionPayouts)
            }
            valueClassName={
              breakdown.fillConversionPayouts > 0
                ? "text-rose-600 dark:text-rose-400"
                : undefined
            }
          />
          <PanelRow
            label="Multiplier-deal payouts"
            value={
              breakdown.fillPayouts === 0
                ? "—"
                : formatCurrency(breakdown.fillPayouts)
            }
            valueClassName={
              breakdown.fillPayouts > 0
                ? "text-rose-600 dark:text-rose-400"
                : undefined
            }
          />
          <PanelRow
            label="Net fill (incl. funded tips / sponsors)"
            value={
              breakdown.netFill === 0 ? "—" : formatCurrency(breakdown.netFill)
            }
            valueClassName={
              breakdown.netFill > 0
                ? "text-rose-600 dark:text-rose-400"
                : undefined
            }
          />
          <PanelRow
            label="Leaderboard cost"
            value={
              breakdown.leaderboardCost === 0
                ? "—"
                : formatCurrency(breakdown.leaderboardCost)
            }
            valueClassName={
              breakdown.leaderboardCost > 0
                ? "text-rose-600 dark:text-rose-400"
                : undefined
            }
          />

          {/* Hairline separator — commission sits BELOW the default total
              line so it reads as an "owner's-call" add-on, not part of the
              core cost. */}
          <div aria-hidden className="my-1.5 h-px bg-border/60" />

          <PanelRow
            label="Referral commission (separate)"
            value={
              breakdown.commission == null
                ? "n/a"
                : breakdown.commission === 0
                  ? "—"
                  : formatCurrency(breakdown.commission)
            }
            valueClassName={
              hasCommission ? "text-rose-600 dark:text-rose-400" : undefined
            }
          />
          <PanelRow
            label="Net incl. commission"
            value={
              netPnlWithCommission === 0
                ? "—"
                : fmtSigned(netPnlWithCommission)
            }
            valueClassName={
              netPnlWithCommission > 0
                ? "text-emerald-600 dark:text-emerald-400"
                : netPnlWithCommission < 0
                  ? "text-rose-600 dark:text-rose-400"
                  : "text-muted-foreground"
            }
          />
        </div>

        <div className="mt-3 flex items-start gap-2 rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
          <Info className="size-3.5 shrink-0 mt-0.5" />
          <span>
            The default Creator Cost <strong>excludes</strong> referral
            commission — the owner decides whether commission counts as
            creator cost. The <strong>Net incl. commission</strong> figure
            folds it in (lifetime GGR − lifetime cost − commission) so both
            reads are visible. Net fill already absorbs the house-funded
            tips / battle sponsorships; pure user→user tips are a $0
            pass-through and not counted.
            {partial && (
              <>
                {" "}
                One cost source failed to load — the total is a lower bound.
              </>
            )}
          </span>
        </div>
      </StatPanel>

      {/* ── Windowed Code-User GGR trend — the SECONDARY, period-driven
          view, split into its own streamed child behind a `?period=`-keyed
          Suspense so a chip switch re-streams ONLY this single cohort-GGR
          read (the lifetime net + cost above are NOT re-fetched). Passes
          the already-resolved lifetime GGR as the fallback for a
          timed-out / "all" render. ─────────────────────────────────── */}
      <Suspense
        key={`windowed-ggr-${period}`}
        fallback={<CreatorWindowedGgrSkeleton />}
      >
        <CreatorWindowedGgrTile
          userId={userId}
          period={period}
          lifetimeGgr={codeUserGgr}
        />
      </Suspense>

      {/* Code-hopper risk callout — when the cohort has hoppers, a small
          amber strip with a deep-link to the per-user badges on /…/users.
          Kept compact (the headline count is already on the KPI tile). */}
      {code && hopper && hopper.hopperCount > 0 && (
        <Link
          href={`/creators/${userId}/users`}
          className="group flex items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 transition-colors hover:bg-amber-500/10"
        >
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-500">
            <ShieldAlert className="size-4.5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-amber-600 dark:text-amber-400">
              {formatNumber(hopper.hopperCount)} of{" "}
              {formatNumber(hopper.activeCount)} code-users are code-hoppers
            </div>
            <div className="truncate text-xs text-muted-foreground">
              Used 2+ distinct affiliate codes (deposit / wager) — may
              inflate this creator&apos;s headline numbers. View per-user
              flags.
            </div>
          </div>
          <ArrowRight className="size-4 shrink-0 text-amber-500 transition-transform group-hover:translate-x-0.5" />
        </Link>
      )}
    </div>
  );
}
