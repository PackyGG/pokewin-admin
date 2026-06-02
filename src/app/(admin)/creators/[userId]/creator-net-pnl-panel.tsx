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
import {
  DASHBOARD_PERIOD_LABELS,
  type DashboardPeriod,
} from "@/lib/queries/dashboard-period";
import { cn } from "@/lib/utils";

import {
  getCreatorNetPnl,
  getCreatorCodeUserGgrForPeriod,
  type CreatorCodeUserGgr,
} from "./_queries/creator-net-pnl";
import { getCodeHopperSummary } from "./_queries/code-hopper-summary";
import { NetPnlPeriodSelector } from "./_components/net-pnl-period-selector";

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
 *     be misleading, so we never present one.
 *   • getCreatorCodeUserGgrForPeriod(userId, period) — the WINDOWED
 *     code-user GGR ONLY, driving the secondary "GGR trend" tile under
 *     the `?period=` chip. Skipped when the active period is "all" (the
 *     windowed GGR == the lifetime GGR we already have), so we never
 *     fire a redundant read — active-timeframe-only.
 *   • getCodeHopperSummary(code)                   — aggregate code-hop
 *     risk for the small amber tile (drill-down lives on /…/users).
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
  const isAll = period === "all";

  // Lifetime net is always needed (headline + cost). The windowed GGR is
  // a SECONDARY trend view; only fetch it when the active chip isn't
  // "all" (otherwise it equals the lifetime GGR we already have). The
  // hopper summary is best-effort and only when the creator has a code.
  const [lifetime, windowedGgrRaw, hopper] = await Promise.all([
    getCreatorNetPnl(userId, "all"),
    isAll
      ? Promise.resolve<CreatorCodeUserGgr | null>(null)
      : getCreatorCodeUserGgrForPeriod(userId, period).catch((e) => {
          console.error(
            "[creator-net-pnl-panel] windowed GGR fetch failed (trend tile renders lifetime fallback):",
            e,
          );
          return null;
        }),
    code
      ? getCodeHopperSummary(code).catch(() => null)
      : Promise.resolve(null),
  ]);

  const { netPnl, netPnlWithCommission, codeUserGgr, totalCost } = lifetime;
  const { breakdown, partial } = totalCost;

  // Windowed GGR for the trend tile — falls back to the lifetime GGR when
  // the chip is "all" or the windowed read failed (labelled accordingly).
  const windowedGgr = windowedGgrRaw ?? codeUserGgr;
  const windowLabel = DASHBOARD_PERIOD_LABELS[period];

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
        />
        <KpiTile
          label="Code-User GGR"
          value={codeUserGgr.ggr === 0 ? "—" : formatCurrency(codeUserGgr.ggr)}
          sub="Lifetime · wager − payout"
          icon={Coins}
          accent="emerald"
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
        />
        {/* FTDs — distinct referrals on this code who actually deposited.
            All-time. Neutral funnel milestone → purple. */}
        <KpiTile
          label="FTDs"
          value={formatNumber(ftdCount)}
          sub="All-time depositors"
          icon={BadgeDollarSign}
          accent="purple"
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
        />
        {/* Wager Volume — real-customer wager booked on this code,
            all-time. Money users risked → emerald (house POV). */}
        <KpiTile
          label="Wager Volume"
          value={wagerVolumeUsd === 0 ? "—" : formatCurrency(wagerVolumeUsd)}
          sub="All-time on this code"
          icon={Wallet}
          accent="emerald"
        />
      </div>

      {/* ── Net Creator P&L hero — the headline net, decomposed into its
          two sides (Revenue = code-user GGR, emerald; Creator Cost =
          breakdown total, rose). Lifetime, apples-to-apples. ───────── */}
      <StatPanel
        title="Net Creator P&L · lifetime"
        icon={netWin ? TrendingUp : netLoss ? TrendingDown : LineChart}
        accent={netAccent}
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
                  Fill payouts + net fill + leaderboard
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
            Fill payouts + net fill + leaderboard cost
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
            label="Fill payouts"
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
          view. Clearly labelled windowed (vs the lifetime headline). The
          chip lives in the section heading above. ─────────────────── */}
      <StatPanel
        title={`Code-User GGR · ${windowLabel}`}
        icon={Coins}
        accent={windowedGgr.ggr > 0 ? "emerald" : windowedGgr.ggr < 0 ? "rose" : "blue"}
      >
        <div className="space-y-1">
          <div
            className={cn(
              "text-2xl font-bold tabular-nums leading-none sm:text-3xl",
              windowedGgr.ggr > 0
                ? "text-emerald-600 dark:text-emerald-400"
                : windowedGgr.ggr < 0
                  ? "text-rose-600 dark:text-rose-400"
                  : "text-muted-foreground",
            )}
            title={`Code-User GGR over ${windowLabel} — wager minus gaming payout (House POV)`}
          >
            {windowedGgr.ggr === 0 ? "—" : formatCurrency(windowedGgr.ggr)}
          </div>
          <p className="text-[11px] text-muted-foreground">
            Windowed ({windowLabel}) cohort gaming margin — wager − payout.
            {windowedGgrRaw == null && !isAll && (
              <span className="text-rose-500"> (windowed read failed — showing lifetime)</span>
            )}
          </p>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-0.5">
          <PanelRow
            label="Wager"
            value={
              windowedGgr.wager === 0 ? "—" : formatCurrency(windowedGgr.wager)
            }
            valueClassName={
              windowedGgr.wager > 0
                ? "text-emerald-600 dark:text-emerald-400"
                : ""
            }
          />
          <PanelRow
            label="Gaming payout"
            value={
              windowedGgr.gamingPayout === 0
                ? "—"
                : formatCurrency(windowedGgr.gamingPayout)
            }
            valueClassName="text-muted-foreground"
          />
        </div>
        <p className="mt-3 text-[10px] text-muted-foreground">
          GGR is window-scoped (driven by the chip above). Creator Cost is
          always lifetime, so this windowed GGR is a trend signal — not
          netted against the lifetime cost. Same canonical attribution +
          staff/blacklist scope as the dashboard / /ggr GGR, narrowed to
          this creator&apos;s code cohort.
        </p>
      </StatPanel>

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
