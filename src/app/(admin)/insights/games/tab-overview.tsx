import {
  BarChart3,
  Coins,
  Users,
  Activity,
  Package,
  Swords,
  TrendingUp,
  Percent,
  Minus,
  Equal,
} from "lucide-react";
import { FadeIn } from "@/components/fade-in";
import {
  KpiTile,
  StatPanel,
  PanelRow,
  SectionHeading,
} from "@/components/modern-panels";
import { formatCompactUsd, formatNumber } from "@/lib/utils/format";
import { getGamesOverview } from "@/lib/queries/insights-games/overview";
import type { GamesPeriod } from "@/lib/queries/insights-games/_shared";
import { labelForPeriod } from "@/lib/queries/insights-games/_shared";
import { OverviewChart } from "./overview-chart";

/**
 * Overview tab — headline KPIs + time series + per-product P&L
 * breakdown. Reads only this tab's query so deep links don't
 * trigger work for the other tabs.
 *
 * KPI strip (6 tiles):
 *   1. Total wager (borrow-corrected)        — emerald (house gain)
 *   2. Total payout (cards delivered)         — rose   (house cost)
 *   3. House P&L                              — emerald/rose based on sign
 *   4. RTP %                                  — blue (informational)
 *   5. Active customers                       — cyan
 *   6. Plays                                  — amber
 */
export async function OverviewTab({ period }: { period: GamesPeriod }) {
  const data = await getGamesOverview(period);
  const k = data.kpis;
  const pnlAccent = k.housePnl >= 0 ? "emerald" : "rose";

  return (
    <FadeIn>
      <div className="space-y-6">
        {/* KPI strip */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          {/* Wager — house collected from staking → emerald */}
          <KpiTile
            label="Wager"
            value={formatCompactUsd(k.totalWager)}
            sub={`Borrow-corrected · ${labelForPeriod(period)}`}
            icon={Coins}
            accent="emerald"
          />
          {/* Payout — house paid out to users → rose */}
          <KpiTile
            label="Payout"
            value={formatCompactUsd(k.totalPayout)}
            sub="Cards delivered + upgrader wins"
            icon={Coins}
            accent="rose"
          />
          <KpiTile
            label="House P&L"
            value={formatCompactUsd(k.housePnl)}
            sub={`${k.housePnlMarginPct.toFixed(2)}% margin`}
            icon={Activity}
            accent={pnlAccent}
          />
          <KpiTile
            label="RTP"
            value={`${k.rtpPct.toFixed(2)}%`}
            sub="Payout ÷ wager"
            icon={Percent}
            accent="blue"
          />
          <KpiTile
            label="Active Customers"
            value={formatNumber(k.activeUsers)}
            sub="Distinct wagering users"
            icon={Users}
            accent="cyan"
          />
          <KpiTile
            label="Plays"
            value={formatNumber(k.totalPlays)}
            sub="Pack opens + battles + upgrader"
            icon={BarChart3}
            accent="amber"
          />
        </div>

        {/* Time series */}
        <SectionHeading icon={BarChart3} title="Activity over time" />
        <div className="rounded-2xl border bg-card p-4 sm:p-5">
          <OverviewChart data={data.series} bucketByHour={data.bucketByHour} />
        </div>

        {/* Game-side P&L decomposition — the cleanest "are we
            making money from our games?" number, without any reward
            noise. Wager and payout sides are both gaming-only:
            packs + battles + upgrader. Nothing from
            bonuses/rakeback/affiliate/race-prizes mixes in, so the
            number is the pure game margin. */}
        <SectionHeading icon={Activity} title="Game-side P&L" />
        <div className="rounded-2xl border bg-card p-4 sm:p-5">
          <p className="mb-3 text-xs text-muted-foreground">
            Pure game economics: total wagers minus total card+upgrader
            payouts. Excludes every reward category (bonuses, rakeback,
            affiliate, race prizes) so the figure is the real margin
            our games produce before any incentive spend.
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="flex items-center gap-2 rounded-lg border bg-emerald-500/5 p-3">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-emerald-500/15">
                <Coins className="size-4 text-emerald-500" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Game wagers
                </p>
                <p className="truncate text-lg font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
                  {formatCompactUsd(k.totalWager)}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  Borrow-corrected
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 rounded-lg border bg-rose-500/5 p-3">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-rose-500/15">
                <Minus className="size-4 text-rose-500" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Game payouts
                </p>
                <p className="truncate text-lg font-bold tabular-nums text-rose-600 dark:text-rose-400">
                  {formatCompactUsd(k.totalPayout)}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  Cards + upgrader wins only
                </p>
              </div>
            </div>
            <div
              className={`flex items-center gap-2 rounded-lg border p-3 ${
                k.housePnl >= 0
                  ? "bg-emerald-500/5"
                  : "bg-rose-500/5"
              }`}
            >
              <div
                className={`flex size-8 shrink-0 items-center justify-center rounded-full ${
                  k.housePnl >= 0
                    ? "bg-emerald-500/15"
                    : "bg-rose-500/15"
                }`}
              >
                <Equal
                  className={`size-4 ${k.housePnl >= 0 ? "text-emerald-500" : "text-rose-500"}`}
                />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Game-side P&L
                </p>
                <p
                  className={`truncate text-lg font-bold tabular-nums ${
                    k.housePnl >= 0
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-rose-600 dark:text-rose-400"
                  }`}
                >
                  {formatCompactUsd(k.housePnl)}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  {k.housePnlMarginPct.toFixed(2)}% margin · RTP {k.rtpPct.toFixed(2)}%
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Per-product P&L breakdown */}
        <SectionHeading icon={Activity} title="P&L by product" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <StatPanel
            title="Packs"
            icon={Package}
            accent={k.packPnl >= 0 ? "emerald" : "rose"}
          >
            <p
              className={
                k.packPnl >= 0
                  ? "text-2xl font-bold tabular-nums text-emerald-600 dark:text-emerald-400"
                  : "text-2xl font-bold tabular-nums text-rose-600 dark:text-rose-400"
              }
            >
              {formatCompactUsd(k.packPnl)}
            </p>
            <div className="mt-2 space-y-0.5 border-t pt-2">
              <PanelRow
                label="Wager"
                value={formatCompactUsd(k.packWager)}
                valueClassName="text-emerald-600 dark:text-emerald-400"
              />
              <PanelRow
                label="Payout"
                value={formatCompactUsd(k.packPayout)}
                valueClassName="text-rose-600 dark:text-rose-400"
              />
              <PanelRow
                label="RTP"
                value={
                  k.packWager > 0
                    ? `${((k.packPayout / k.packWager) * 100).toFixed(2)}%`
                    : "—"
                }
              />
            </div>
          </StatPanel>

          <StatPanel
            title="Battles"
            icon={Swords}
            accent={k.battlePnl >= 0 ? "emerald" : "rose"}
          >
            <p
              className={
                k.battlePnl >= 0
                  ? "text-2xl font-bold tabular-nums text-emerald-600 dark:text-emerald-400"
                  : "text-2xl font-bold tabular-nums text-rose-600 dark:text-rose-400"
              }
            >
              {formatCompactUsd(k.battlePnl)}
            </p>
            <div className="mt-2 space-y-0.5 border-t pt-2">
              <PanelRow
                label="Wager"
                value={formatCompactUsd(k.battleWager)}
                valueClassName="text-emerald-600 dark:text-emerald-400"
              />
              <PanelRow
                label="Payout"
                value={formatCompactUsd(k.battlePayout)}
                valueClassName="text-rose-600 dark:text-rose-400"
              />
              <PanelRow
                label="RTP"
                value={
                  k.battleWager > 0
                    ? `${((k.battlePayout / k.battleWager) * 100).toFixed(2)}%`
                    : "—"
                }
              />
            </div>
          </StatPanel>

          <StatPanel
            title="Upgrader"
            icon={TrendingUp}
            accent={k.upgraderPnl >= 0 ? "emerald" : "rose"}
          >
            <p
              className={
                k.upgraderPnl >= 0
                  ? "text-2xl font-bold tabular-nums text-emerald-600 dark:text-emerald-400"
                  : "text-2xl font-bold tabular-nums text-rose-600 dark:text-rose-400"
              }
            >
              {formatCompactUsd(k.upgraderPnl)}
            </p>
            <div className="mt-2 space-y-0.5 border-t pt-2">
              <PanelRow
                label="Wager"
                value={formatCompactUsd(k.upgraderWager)}
                valueClassName="text-emerald-600 dark:text-emerald-400"
              />
              <PanelRow
                label="Payout"
                value={formatCompactUsd(k.upgraderPayout)}
                valueClassName="text-rose-600 dark:text-rose-400"
              />
              <PanelRow
                label="RTP"
                value={
                  k.upgraderWager > 0
                    ? `${((k.upgraderPayout / k.upgraderWager) * 100).toFixed(2)}%`
                    : "—"
                }
              />
            </div>
          </StatPanel>
        </div>
      </div>
    </FadeIn>
  );
}
