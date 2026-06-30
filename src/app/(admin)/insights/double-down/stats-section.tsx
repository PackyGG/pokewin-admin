import { Dices, Trophy, Coins, Scale } from "lucide-react";
import { KpiTile } from "@/components/modern-panels";
import { InlineError } from "@/components/entity-surface/inline-error";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import {
  getDoubleDownStats,
  type DoubleDownPeriod,
  type DoubleDownStats,
} from "@/lib/queries/double-down";

const EMPTY_STATS: DoubleDownStats = {
  totalRounds: 0,
  resolvedRounds: 0,
  winCount: 0,
  loseCount: 0,
  winRate: null,
  totalStaked: 0,
  totalPaidOut: 0,
  netHousePnl: 0,
};

function pct(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

/**
 * KPI strip for /insights/double-down — EXACTLY four tiles (owner rule,
 * 2026-06-30): Started rounds · Win rate · Total wager · House P&L. STARTED
 * rounds only (Double Down is OPTIONAL — offered/expired offers excluded).
 *
 * House P&L is the headline "did WE make money": net house P&L = forfeited −
 * payouts (paidOut/forfeited stay computed internally to derive it, but are
 * NOT shown as their own tiles). House-POV color: site PROFIT (≥0) →
 * emerald, site LOSS (<0) → rose, with a clear sign + profit/loss label.
 *
 * Streamed behind its own <Suspense> from the page; cached + timeout-wrapped.
 */
export async function DoubleDownStatsSection({
  period,
}: {
  period: DoubleDownPeriod;
}) {
  const { data, error } = await safeQuery(
    () => getDoubleDownStats(period),
    EMPTY_STATS,
    "insights.doubleDown.stats",
    REWARD_QUERY_TIMEOUT_MS,
  );

  if (error) {
    return (
      <InlineError
        title="Couldn't load Double Down stats"
        hint="This is a load failure, not an empty window — retry to re-run the aggregate."
      />
    );
  }

  const s = data;
  const houseProfit = s.netHousePnl >= 0;

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <KpiTile
        label="Started rounds"
        value={formatNumber(s.totalRounds)}
        sub={`${formatNumber(s.resolvedRounds)} resolved`}
        icon={Dices}
        accent="blue"
      />
      <KpiTile
        label="Win rate"
        value={pct(s.winRate)}
        sub={`${formatNumber(s.winCount)} win · ${formatNumber(s.loseCount)} lose`}
        icon={Trophy}
        accent="blue"
      />
      <KpiTile
        label="Total wager"
        value={formatCurrency(s.totalStaked)}
        sub="winnings staked"
        icon={Coins}
        accent="blue"
      />
      {/* House P&L — did WE make money? Positive = house profit (emerald),
          negative = house loss (rose), with sign + label. */}
      <KpiTile
        label="House P&L"
        value={`${houseProfit ? "+" : "−"}${formatCurrency(Math.abs(s.netHousePnl))}`}
        sub={houseProfit ? "house profit" : "house loss"}
        icon={Scale}
        accent={houseProfit ? "emerald" : "rose"}
      />
    </div>
  );
}
