import { TrendingUp, Target, Percent } from "lucide-react";
import { FadeIn } from "@/components/fade-in";
import { KpiTile, SectionHeading } from "@/components/modern-panels";
import { formatCompactUsd, formatNumber } from "@/lib/utils/format";
import { getUpgraderProfitability } from "@/lib/queries/insights-games/upgrader";
import type { GamesPeriod } from "@/lib/queries/insights-games/_shared";
import { labelForPeriod } from "@/lib/queries/insights-games/_shared";

/**
 * Upgrader tab — totals + per-target-multiplier bucket breakdown.
 *
 * No borrow on upgrader (verified — no field, no convention). The
 * creator-on-stream filter still applies (same session_windows CTE).
 *
 * The bucket table is the headline: admins read it as "how the
 * house edge changes with the target multiplier" (e.g. 100×+
 * tickets pay <1% of the time but the bets are tiny → the bucket
 * is small but high-margin).
 */
export async function UpgraderTab({ period }: { period: GamesPeriod }) {
  const data = await getUpgraderProfitability(period);
  const t = data.totals;
  const pnlAccent = t.pnl >= 0 ? "emerald" : "rose";
  return (
    <FadeIn>
      <div className="space-y-6">
        {/* KPI strip */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <KpiTile
            label="Bets"
            value={formatNumber(t.bets)}
            sub={labelForPeriod(period)}
            icon={TrendingUp}
            accent="blue"
          />
          <KpiTile
            label="Wager"
            value={formatCompactUsd(t.wager)}
            sub={`Avg ${formatCompactUsd(t.avgBet)} / bet`}
            icon={TrendingUp}
            accent="emerald"
          />
          <KpiTile
            label="Payout"
            value={formatCompactUsd(t.payouts)}
            sub={`Hit rate ${t.hitRatePct.toFixed(2)}%`}
            icon={Target}
            accent="rose"
          />
          <KpiTile
            label="P&L"
            value={formatCompactUsd(t.pnl)}
            sub={`${t.marginPct.toFixed(2)}% margin · RTP ${t.rtpPct.toFixed(2)}%`}
            icon={Percent}
            accent={pnlAccent}
          />
        </div>

        {/* Bucket breakdown */}
        <SectionHeading icon={Target} title="By target multiplier" />
        {t.bets === 0 ? (
          <div className="rounded-2xl border bg-card p-8 text-center text-sm text-muted-foreground">
            No upgrader plays in this period.
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border bg-card">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold">Target</th>
                    <th className="px-3 py-2 text-right font-semibold">Bets</th>
                    <th className="px-3 py-2 text-right font-semibold">Wager</th>
                    <th className="px-3 py-2 text-right font-semibold">Payout</th>
                    <th className="px-3 py-2 text-right font-semibold">P&amp;L</th>
                    <th className="px-3 py-2 text-right font-semibold">RTP</th>
                    <th className="px-3 py-2 text-right font-semibold">Hit %</th>
                  </tr>
                </thead>
                <tbody>
                  {data.buckets
                    .filter((b) => b.bets > 0)
                    .map((b) => (
                      <tr key={b.label} className="border-b last:border-0 hover:bg-muted/30">
                        <td className="px-3 py-2 font-medium">{b.label}</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {formatNumber(b.bets)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                          {formatCompactUsd(b.totalWager)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-rose-600 dark:text-rose-400">
                          {formatCompactUsd(b.totalPayout)}
                        </td>
                        <td
                          className={`px-3 py-2 text-right tabular-nums font-medium ${b.pnl >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}
                        >
                          {formatCompactUsd(b.pnl)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {b.rtpPct.toFixed(2)}%
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {b.hitRatePct.toFixed(2)}%
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
