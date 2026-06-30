import {
  Dices,
  Handshake,
  Trophy,
  Coins,
  ArrowUpCircle,
  ArrowDownCircle,
  Scale,
  Percent,
} from "lucide-react";
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
  acceptedRounds: 0,
  notAcceptedRounds: 0,
  resolvedRounds: 0,
  winCount: 0,
  loseCount: 0,
  winRate: null,
  totalStaked: 0,
  totalPaidOut: 0,
  totalForfeited: 0,
  totalEdgeCut: 0,
  netHousePnl: 0,
  houseEdgePct: null,
};

function pct(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

/**
 * KPI strip for /insights/double-down. House-POV colors (CLAUDE.md):
 *   - payout to a winner = house COST → rose
 *   - forfeited winnings (a lose) = house GAIN → emerald
 *   - the 10% edge cut = house revenue → emerald
 *   - NET house P&L positive → emerald, negative → rose
 *   - win-rate / accept-rate / counts are neutral (blue).
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
  const acceptRate =
    s.totalRounds > 0 ? s.acceptedRounds / s.totalRounds : null;
  const netAccent = s.netHousePnl >= 0 ? "emerald" : "rose";

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {/* Volume + behaviour — neutral. */}
      <KpiTile
        label="Rounds"
        value={formatNumber(s.totalRounds)}
        sub={`${formatNumber(s.resolvedRounds)} resolved`}
        icon={Dices}
        accent="blue"
      />
      <KpiTile
        label="Accept rate"
        value={pct(acceptRate)}
        sub={`${formatNumber(s.acceptedRounds)} accepted · ${formatNumber(s.notAcceptedRounds)} not`}
        icon={Handshake}
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
        label="Total staked"
        value={formatCurrency(s.totalStaked)}
        sub="winnings put up (resolved)"
        icon={Coins}
        accent="blue"
      />

      {/* House-POV money. */}
      <KpiTile
        label="Paid out"
        value={formatCurrency(s.totalPaidOut)}
        sub="to winners — house cost"
        icon={ArrowUpCircle}
        accent="rose"
      />
      <KpiTile
        label="Forfeited"
        value={formatCurrency(s.totalForfeited)}
        sub="winnings lost — house gain"
        icon={ArrowDownCircle}
        accent="emerald"
      />
      <KpiTile
        label="Net house P&L"
        value={formatCurrency(s.netHousePnl)}
        sub={`incl. ${formatCurrency(s.totalEdgeCut)} edge cut`}
        icon={Scale}
        accent={netAccent}
      />
      <KpiTile
        label="House edge"
        value={pct(s.houseEdgePct)}
        sub="net P&L ÷ staked"
        icon={Percent}
        accent={netAccent}
      />
    </div>
  );
}
