import { Swords, Trophy, Users as UsersIcon } from "lucide-react";
import { FadeIn } from "@/components/fade-in";
import {
  KpiTile,
  SectionHeading,
} from "@/components/modern-panels";
import { formatCompactUsd, formatNumber } from "@/lib/utils/format";
import { getBattlesProfitability } from "@/lib/queries/insights-games/battles";
import type { GamesPeriod } from "@/lib/queries/insights-games/_shared";
import { labelForPeriod } from "@/lib/queries/insights-games/_shared";
import { BattleDrilldownPopover } from "./battle-drilldown-popover";
import { safeQuery } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";

/**
 * Battles tab — total + per-mode breakdown + top hits table.
 *
 * Borrow-funded battles are excluded entirely (drops both wager
 * and payout sides), matching the rest of the page.
 *
 * The biggest-payouts table ranks by absolute realised payout
 * DESC so an admin scanning the list sees the actual house-pain
 * events first.
 */
export async function BattlesTab({ period }: { period: GamesPeriod }) {
  const { data, error } = await safeQuery(
    () => getBattlesProfitability(period),
    null,
    "insights-games.battles",
  );
  if (error || !data) {
    return (
      <TileErrorFallback
        label="Games — Battles"
        hint="The battles profitability query failed. Server logs hold the digest."
        size="panel"
      />
    );
  }
  const t = data.totals;
  const pnlAccent = t.pnl >= 0 ? "emerald" : "rose";
  return (
    <FadeIn>
      <div className="space-y-6">
        {/* KPI strip */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <KpiTile
            label="Battles"
            value={formatNumber(t.battles)}
            sub={labelForPeriod(period)}
            icon={Swords}
            accent="blue"
          />
          <KpiTile
            label="Wager (paid)"
            value={formatCompactUsd(t.wager)}
            sub="Borrow-corrected"
            icon={Trophy}
            accent="emerald"
          />
          <KpiTile
            label="Payout"
            value={formatCompactUsd(t.payouts)}
            sub="Cards delivered"
            icon={Trophy}
            accent="rose"
          />
          <KpiTile
            label="P&L"
            value={formatCompactUsd(t.pnl)}
            sub={`${t.marginPct.toFixed(2)}% margin`}
            icon={Trophy}
            accent={pnlAccent}
          />
        </div>

        {/* Per-mode table */}
        <SectionHeading icon={Swords} title="By mode" />
        {data.byMode.length === 0 ? (
          <div className="rounded-2xl border bg-card p-8 text-center text-sm text-muted-foreground">
            No completed battles in this period.
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border bg-card">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold">Mode</th>
                    <th className="px-3 py-2 text-right font-semibold">Battles</th>
                    <th className="px-3 py-2 text-right font-semibold">Avg pot</th>
                    <th className="px-3 py-2 text-right font-semibold">Wager</th>
                    <th className="px-3 py-2 text-right font-semibold">Payout</th>
                    <th className="px-3 py-2 text-right font-semibold">P&amp;L</th>
                    <th className="px-3 py-2 text-right font-semibold">Margin</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byMode.map((m) => (
                    <tr key={m.mode} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="px-3 py-2 font-medium">{m.mode}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatNumber(m.battles)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatCompactUsd(m.avgPotUsd)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                        {formatCompactUsd(m.totalWager)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-rose-600 dark:text-rose-400">
                        {formatCompactUsd(m.totalPayout)}
                      </td>
                      <td
                        className={`px-3 py-2 text-right tabular-nums font-medium ${m.pnl >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}
                      >
                        {formatCompactUsd(m.pnl)}
                      </td>
                      <td
                        className={`px-3 py-2 text-right tabular-nums ${m.marginPct >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}
                      >
                        {m.marginPct.toFixed(2)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Top battles by payout */}
        <SectionHeading icon={UsersIcon} title="Biggest payouts" />
        {data.topBattles.length === 0 ? (
          <div className="rounded-2xl border bg-card p-8 text-center text-sm text-muted-foreground">
            No payouts in this period.
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border bg-card">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold">Battle</th>
                    <th className="px-3 py-2 text-left font-semibold">Mode</th>
                    <th className="px-3 py-2 text-right font-semibold">Players</th>
                    <th className="px-3 py-2 text-right font-semibold">Bet</th>
                    <th className="px-3 py-2 text-right font-semibold">Pot</th>
                    <th className="px-3 py-2 text-right font-semibold">Payout</th>
                    <th className="px-3 py-2 text-right font-semibold">House P&amp;L</th>
                    <th className="px-3 py-2 text-right font-semibold">Hit ×</th>
                  </tr>
                </thead>
                <tbody>
                  {data.topBattles.map((b) => (
                    <tr key={b.battleId} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="px-3 py-2">
                        <BattleDrilldownPopover
                          battleId={b.battleId}
                          createdAt={b.createdAt}
                        />
                      </td>
                      <td className="px-3 py-2">{b.mode}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {b.playersTotal}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatCompactUsd(b.betAmount)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatCompactUsd(b.totalPot)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-rose-600 dark:text-rose-400">
                        {formatCompactUsd(b.totalPayout)}
                      </td>
                      <td
                        className={`px-3 py-2 text-right tabular-nums font-medium ${b.housePnl >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}
                      >
                        {formatCompactUsd(b.housePnl)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {b.hitMultiplier != null
                          ? `${b.hitMultiplier.toFixed(2)}×`
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </FadeIn>
  );
}
