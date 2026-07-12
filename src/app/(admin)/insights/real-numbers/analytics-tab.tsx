import {
  Coins,
  Wallet,
  HandCoins,
  BadgeDollarSign,
  Percent,
  TrendingUp,
  TrendingDown,
} from "lucide-react";
import {
  safeQuery,
  REWARD_QUERY_TIMEOUT_MS,
} from "@/lib/errors/safe-query";
import { getDashboardKpiStats } from "@/lib/queries/dashboard";
import { getAvgPnl7d } from "@/lib/queries/dashboard-avg-pnl-7d";
import { getRealizedPnlSnapshot } from "@/lib/queries/_realized-pnl";
import { KpiTile, SectionHeading } from "@/components/modern-panels";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { formatCurrency, formatNumber } from "@/lib/utils/format";

/**
 * House-POV signed currency string, e.g. `+$1,234.56` / `−$1,234.56`.
 * Uses the en-dash minus (−) exactly like the dashboard's `SignedHero` did
 * so the moved P&L box reads identically to how it read on the dashboard.
 */
function signedCurrency(value: number): string {
  const isProfit = value >= 0;
  return `${isProfit ? "+" : "−"}${formatCurrency(Math.abs(value))}`;
}

/**
 * Analytics tab — a secondary view on the Insights Overview (Real Numbers is
 * the landing tab).
 *
 * Surfaces the lifetime / fixed-window snapshot figures that used to live on
 * the dashboard KPI strip, moved here so the dashboard stays a live-ops board
 * and the analytics cadence + aggregates live on the Insights Overview:
 *   • Total P&L — lifetime headline + Avg Daily P&L (7d) sub-line  [moved,
 *     the dashboard's standalone "Total P&L" + "Avg P&L" boxes folded into
 *     ONE box per the owner: lifetime total is the headline, avg-daily-7d is
 *     the secondary line]
 *   • FTDs (24h), Depositors (lifetime), Avg RTP (lifetime)        [moved]
 *   • Deposit cadence — Avg Deposit + Deposits / Hour (24h + 7d)   [unchanged]
 *
 * Read paths are REUSED verbatim, not re-derived, so the numbers are byte-for-
 * byte what the dashboard showed:
 *   • FTDs / Depositors / Avg RTP / Avg Deposit / Deposits per Hour come off
 *     `getDashboardKpiStats("today")` — the SAME aggregate the dashboard's
 *     snapshot build used (`stats.financials.ftds24h`, `.uniqueDepositors`, the
 *     RTP inputs `.totalWon` / `.totalWagered`, `.avgDeposit`, and
 *     `stats.depositCount24h/7d`). These are lifetime / fixed-window figures
 *     (the dashboard's window toggle never changed them), so "today" is just
 *     the cheapest cached call into the shared aggregate — no new MAIN query.
 *   • Total P&L (lifetime) ← `getRealizedPnlSnapshot()`; Avg Daily P&L (7d) ←
 *     `getAvgPnl7d()` — the SAME cached functions the dashboard called. Each
 *     read is wrapped in `safeQuery` + `REWARD_QUERY_TIMEOUT_MS`.
 *
 * House-POV colours (CLAUDE.md):
 *   • Total P&L / Avg Daily P&L — a house P&L figure → emerald when the house
 *     is up (value ≥ 0), rose when the house is down (value < 0), BOTH by sign.
 *   • FTDs / Depositors — counts (not money values) → neutral, exactly as the
 *     dashboard rendered them (FTDs amber identity, Depositors purple identity).
 *   • Avg RTP — a ratio, pink identity (matches the dashboard's treatment).
 *   • Avg Deposit — a deposit dollar figure (money IN from user → house up) →
 *     🟢 emerald.
 *   • Deposits / Hour — a cadence RATE (count per time) → neutral 🔵 blue.
 */
export async function AnalyticsTab() {
  // All three reads run in parallel. Only the snapshot aggregate (FTDs /
  // Depositors / Avg RTP / deposit cadence) is required to render the page; a
  // failed P&L read degrades ONLY the Total P&L box to a compact fallback (not
  // a misleading $0).
  const [statsResult, avgPnl7dResult, lifetimePnlResult] = await Promise.all([
    safeQuery(
      () => getDashboardKpiStats("today"),
      null,
      "insights.analytics.snapshot",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => getAvgPnl7d(),
      null,
      "insights.analytics.avgPnl7d",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => getRealizedPnlSnapshot(),
      null,
      "insights.analytics.lifetimePnl",
      REWARD_QUERY_TIMEOUT_MS,
    ),
  ]);

  const { data: stats, error, kind } = statsResult;

  // Defensive against a stale-shape `unstable_cache` entry (same failure
  // class as the recent Double Down NaN fix): a cache entry serialized before
  // the `financials` block existed deserializes with `financials === undefined`.
  // Reading `stats.financials.avgDeposit` on that shape THROWS inside this
  // Suspense boundary and collapses the whole page. So the required
  // `financials` block being absent is treated as an error (render the same
  // fallback as the `error || !stats` branch) rather than rendered as zeros.
  if (error || !stats || !stats.financials) {
    return (
      <TileErrorFallback
        label="Analytics snapshot"
        hint="The analytics aggregate failed to load — refresh to retry."
        kind={kind ?? undefined}
        size="panel"
      />
    );
  }

  // Same derivations the dashboard used — reused, not re-computed (see
  // `src/app/(admin)/dashboard/page.tsx`'s `snapshot` build). Count fields are
  // read defensively (`?? 0`) so a stale entry missing them degrades to a 0
  // figure instead of surfacing NaN.
  const avgDeposit = stats.financials.avgDeposit ?? 0;
  const depositsPerHour24h = (stats.depositCount24h ?? 0) / 24;
  const depositsPerHour7d = (stats.depositCount7d ?? 0) / (7 * 24);

  const ftds24h = stats.financials.ftds24h ?? 0;
  const ftdTotal24h = stats.financials.ftdTotal24h ?? 0;
  const ftdAvg24h = stats.financials.ftdAvg24h ?? 0;

  const uniqueDepositors = stats.financials.uniqueDepositors ?? 0;
  const usersTotal = stats.users?.total ?? 0;
  const depositorsPctOfUsers =
    usersTotal > 0 ? (uniqueDepositors / usersTotal) * 100 : null;

  const totalWagered = stats.financials.totalWagered ?? 0;
  const totalWon = stats.financials.totalWon ?? 0;
  const avgRtp = totalWagered > 0 ? (totalWon / totalWagered) * 100 : 0;

  // Combined P&L box — lifetime Total P&L headline + Avg Daily P&L (7d) sub.
  // Both come from the same cached functions the dashboard called; either read
  // failing degrades that box to a compact fallback (never a misleading $0).
  const lifetimePnl = lifetimePnlResult.data;
  const avgPnl7d = avgPnl7dResult.data;
  const pnlAvailable = lifetimePnl != null && avgPnl7d != null;
  const totalPnlLifetime = lifetimePnl?.pnl ?? 0;
  const totalPnl7d = avgPnl7d?.totalPnl7d ?? 0;
  const avgDailyPnl7d = avgPnl7d?.avgDailyPnl ?? 0;
  const pnlIsProfit = totalPnlLifetime >= 0;

  return (
    <div className="space-y-6">
      {/* Profit & loss — lifetime headline + rolling-7d cadence sub-line. */}
      <div className="space-y-5">
        <SectionHeading icon={TrendingUp} title="Profit & loss" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {pnlAvailable ? (
            // Total P&L — lifetime realized house P&L (balance-sheet snapshot)
            // as the headline, Avg Daily P&L (7d) as the sub-line. House-POV:
            // house up (≥ 0) → emerald, house down (< 0) → rose. The sign is
            // rendered in the value string (+/−); the accent carries the colour
            // for BOTH the headline and the sub (which restates the signed 7d
            // figures). Folds the dashboard's old "Avg P&L" + "Total P&L" boxes
            // into one, per the owner.
            <KpiTile
              label="Total P&L"
              value={signedCurrency(totalPnlLifetime)}
              sub={`${signedCurrency(avgDailyPnl7d)} / day · ${signedCurrency(
                totalPnl7d,
              )} rolling 7d`}
              icon={pnlIsProfit ? TrendingUp : TrendingDown}
              accent={pnlIsProfit ? "emerald" : "rose"}
            />
          ) : (
            <TileErrorFallback
              label="Total P&L"
              hint="The lifetime / 7d P&L scan timed out — refresh to retry."
              kind={
                lifetimePnlResult.kind ?? avgPnl7dResult.kind ?? undefined
              }
              size="compact"
            />
          )}
        </div>
      </div>

      {/* Acquisition & funding — FTDs, Depositors, Avg RTP. */}
      <div className="space-y-5">
        <SectionHeading icon={BadgeDollarSign} title="Acquisition & funding" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {/* FTDs (24h) — a count, neutral (amber identity as on the
              dashboard); sub restates total + avg deposit value. */}
          <KpiTile
            label="FTDs"
            value={formatNumber(ftds24h)}
            sub={`24h · ${formatCurrency(ftdTotal24h)} total · ${formatCurrency(
              ftdAvg24h,
            )} avg`}
            icon={HandCoins}
            accent="amber"
          />
          {/* Depositors (lifetime) — unique players who funded at least once;
              a count, neutral (purple identity as on the dashboard). */}
          <KpiTile
            label="Depositors"
            value={formatNumber(uniqueDepositors)}
            sub={
              depositorsPctOfUsers != null
                ? `${depositorsPctOfUsers.toFixed(1)}% of users have funded`
                : "Unique players who funded at least once"
            }
            icon={BadgeDollarSign}
            accent="purple"
          />
          {/* Avg RTP (lifetime) — a ratio, pink identity. Rendered to 2
              decimals to match the dashboard's `AnimatedNumber format="percent"`
              treatment byte-for-byte (same value, same precision). */}
          <KpiTile
            label="Avg RTP"
            value={`${avgRtp.toFixed(2)}%`}
            sub="Lifetime · payouts ÷ wagered"
            icon={Percent}
            accent="pink"
          />
        </div>
      </div>

      {/* Deposit cadence — Avg Deposit + Deposits / Hour (24h + 7d). */}
      <div className="space-y-5">
        <SectionHeading icon={Wallet} title="Deposit cadence" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {/* Avg Deposit — a deposit dollar figure → House-POV emerald. */}
          <KpiTile
            label="Avg Deposit"
            value={formatCurrency(avgDeposit)}
            sub="Σ deposited ÷ lifetime deposit count"
            icon={Wallet}
            accent="emerald"
          />
          {/* Deposits / Hour — a cadence RATE (count per time), not a money
              value → neutral blue. Rolling 24h average. */}
          <KpiTile
            label="Deposits / Hour"
            value={`${formatNumber(Math.round(depositsPerHour24h * 10) / 10)}/h`}
            sub="Rolling 24h average"
            icon={Coins}
            accent="blue"
          />
          {/* 7d baseline for the same cadence rate, so the 24h figure has a
              reference. Blue for the same reason (a rate, not a money value). */}
          <KpiTile
            label="Deposits / Hour"
            value={`${formatNumber(Math.round(depositsPerHour7d * 10) / 10)}/h`}
            sub="Rolling 7d baseline"
            icon={Coins}
            accent="blue"
          />
        </div>
      </div>
    </div>
  );
}
