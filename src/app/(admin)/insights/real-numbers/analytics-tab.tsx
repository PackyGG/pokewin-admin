import { Coins, Wallet } from "lucide-react";
import {
  safeQuery,
  REWARD_QUERY_TIMEOUT_MS,
} from "@/lib/errors/safe-query";
import { getDashboardKpiStats } from "@/lib/queries/dashboard";
import { KpiTile, SectionHeading } from "@/components/modern-panels";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { formatCurrency, formatNumber } from "@/lib/utils/format";

/**
 * Analytics tab — the Insights Overview LANDING view.
 *
 * Surfaces the deposit-cadence figures that used to live on the dashboard KPI
 * strip (Avg Deposit + Deposits / Hour), moved here so the dashboard stays a
 * live-ops board and the analytics cadence lives on the Insights Overview.
 *
 * Read path is REUSED verbatim, not re-derived: `getDashboardKpiStats("today")`
 * — the exact same aggregate the dashboard KPI strip used. The three figures
 * are computed the identical way the dashboard computed them (see
 * `src/app/(admin)/dashboard/page.tsx`'s `snapshot` build):
 *   • avgDeposit          ← stats.financials.avgDeposit (Σ total_deposited ÷
 *                            lifetime deposit count)
 *   • depositsPerHour 24h ← stats.depositCount24h / 24
 *   • depositsPerHour 7d  ← stats.depositCount7d / (7 · 24)
 *
 * These are lifetime / fixed-window snapshot figures (the window toggle never
 * changed them on the dashboard), so "today" is just the cheapest cached call
 * into the shared aggregate. No new MAIN query, no new money math.
 *
 * House-POV colours (CLAUDE.md): a deposit is money IN from the user → the
 * house is up → 🟢 emerald. Avg Deposit is a deposit dollar figure → emerald.
 * Deposits / Hour is a cadence RATE (a count-per-time, not a money value) →
 * neutral 🔵 blue.
 */
export async function AnalyticsTab() {
  const { data: stats, error, kind } = await safeQuery(
    () => getDashboardKpiStats("today"),
    null,
    "insights.analytics.depositCadence",
    REWARD_QUERY_TIMEOUT_MS,
  );

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
        label="Deposit cadence"
        hint="The deposit-cadence aggregate failed to load — refresh to retry."
        kind={kind ?? undefined}
        size="panel"
      />
    );
  }

  // Same derivation the dashboard used — reused, not re-computed. Read the
  // count fields defensively (`?? 0`) so a stale entry missing them degrades
  // to a 0/h cadence instead of surfacing NaN.
  const avgDeposit = stats.financials.avgDeposit ?? 0;
  const depositsPerHour24h = (stats.depositCount24h ?? 0) / 24;
  const depositsPerHour7d = (stats.depositCount7d ?? 0) / (7 * 24);

  return (
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
  );
}
