import { Dices, Trophy, Coins, Scale, Swords } from "lucide-react";
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
  distinctBattlesWithDd: 0,
  totalBattles: 0,
  battleDoubleDownRate: null,
};

function pct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

/**
 * Render a count as an integer, never "NaN". `formatNumber(undefined)` (and
 * `formatNumber(NaN)`) emit the literal string "NaN", which is what surfaced as
 * "NaN of NaN battles" when a stale-shape cache hit made these fields
 * undefined. Coercing here guarantees an integer at the render boundary even if
 * an upstream value ever drifts to undefined/NaN again. `Number(undefined)` is
 * NaN so the `|| 0` catches both.
 */
function intOrZero(v: number | null | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * KPI strip for /insights/double-down — five tiles: Battles w/ Double Down ·
 * Started rounds · Win rate · Total wager · House P&L. STARTED rounds only
 * (Double Down is OPTIONAL — offered/expired offers excluded).
 *
 * "Battles w/ Double Down" = distinct battles that had a started DD round
 * (customer-scoped numerator) over ALL battles in the same window (index-served
 * denominator, battles(created_at)) — a neutral engagement % (blue), NOT a P&L
 * number. Divide-by-zero safe: renders "—" when no battles in the window. The
 * money-derivation note below (paidOut/forfeited internal) is unchanged.
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
  // Defensive coercion at the render boundary: guarantees integers (never the
  // literal "NaN" from formatNumber(undefined)) even if a value drifts.
  const distinctBattlesWithDd = intOrZero(s.distinctBattlesWithDd);
  const totalBattles = intOrZero(s.totalBattles);
  // Recompute the rate here so it's always consistent with the shown counts and
  // divide-by-zero safe (null → "—") regardless of what the aggregate returned.
  const battleDoubleDownRate =
    totalBattles > 0 ? distinctBattlesWithDd / totalBattles : null;

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-5">
      {/* Battles w/ Double Down — how many battles used the feature vs. every
          battle in the window. Neutral engagement % (blue), NOT a P&L number.
          Divide-by-zero safe: rate is null (→ "—") when no battles in window. */}
      <KpiTile
        label="Battles w/ Double Down"
        value={pct(battleDoubleDownRate)}
        sub={`${formatNumber(distinctBattlesWithDd)} of ${formatNumber(totalBattles)} battles`}
        icon={Swords}
        accent="blue"
      />
      <KpiTile
        label="Started rounds"
        value={formatNumber(intOrZero(s.totalRounds))}
        sub={`${formatNumber(intOrZero(s.resolvedRounds))} resolved`}
        icon={Dices}
        accent="blue"
      />
      <KpiTile
        label="Win rate"
        value={pct(s.winRate)}
        sub={`${formatNumber(intOrZero(s.winCount))} win · ${formatNumber(intOrZero(s.loseCount))} lose`}
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
