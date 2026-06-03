import {
  TrendingUp,
  TrendingDown,
  ArrowLeftRight,
  Hash,
  Users,
  ShieldCheck,
  Sigma,
  Scale,
  LineChart as LineChartIcon,
} from "lucide-react";
import { SectionHeading, KpiTile } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { getBalanceAdjustmentOverview } from "@/lib/queries/insights-balance-adjustments/overview";
import { BalanceAdjustmentDailyChart } from "./daily-chart";

/**
 * Overview tab on /insights/balance-adjustments.
 *
 * Headline lens on the period — total adjusted volume (credits vs debits),
 * count, net, avg/median/max size, distinct users affected, distinct
 * admins who adjusted + a daily volume chart split by direction.
 *
 * House-POV: a CREDIT to a user is a payout (house gives money) → rose.
 * A DEBIT (house takes back) → emerald. Net user gain (credits exceed
 * debits) → rose. Count / users are neutral → blue.
 */
export async function OverviewTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const overviewRes = await safeQuery(
    () => getBalanceAdjustmentOverview(period),
    null,
    "insights-balance-adjustments.overview",
    REWARD_QUERY_TIMEOUT_MS,
  );

  if (overviewRes.error || !overviewRes.data) {
    return (
      <TileErrorFallback
        label="Balance Adjustments — Overview"
        hint="The overview query failed. Check server logs."
        size="panel"
      />
    );
  }
  const overview = overviewRes.data;
  const label = insightsRewardsPeriodLabel(period);

  if (overview.count === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={Scale}
          title={`No balance adjustments in ${label.toLowerCase()}`}
          description="No admin_balance_adjustment ledger rows for this window. Try a longer period."
          compact
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <FadeIn>
        <KpiStrip overview={overview} />
      </FadeIn>

      <FadeIn>
        <div className="surface-sheen surface-raise relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-card/70 p-4 sm:p-5">
          <div
            aria-hidden
            className="pointer-events-none absolute -right-12 -top-12 size-32 rounded-full bg-rose-500/[0.08] blur-2xl"
          />
          <div className="relative">
            <SectionHeading
              icon={LineChartIcon}
              title={`Daily adjustment volume — ${label}`}
            />
            <div className="mt-3">
              <BalanceAdjustmentDailyChart
                daily={overview.daily.map((d) => ({
                  date: d.date,
                  creditVolume: d.creditVolume,
                  debitVolume: d.debitVolume,
                }))}
              />
            </div>
          </div>
        </div>
      </FadeIn>
    </div>
  );
}

// ─── KPI strip ──────────────────────────────────────────────────────

function KpiStrip({
  overview,
}: {
  overview: NonNullable<
    Awaited<ReturnType<typeof getBalanceAdjustmentOverview>>
  >;
}) {
  const prior = overview.priorWindow;
  // Net user gain > 0 ⇒ users netted money from the house ⇒ a net payout
  // ⇒ rose. Net < 0 ⇒ house clawed back more than it gave ⇒ emerald.
  const netAccent = overview.netUserGain >= 0 ? "rose" : "emerald";
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-8">
      <KpiTile
        label="Gross volume"
        value={formatCurrency(overview.grossVolume)}
        sub={formatDeltaSub(prior?.grossDelta ?? null)}
        icon={ArrowLeftRight}
        accent="purple"
      />
      <KpiTile
        label="Credits (house pays)"
        value={formatCurrency(overview.creditVolume)}
        sub={`${formatNumber(overview.creditCount)} credit rows`}
        icon={TrendingUp}
        accent="rose"
      />
      <KpiTile
        label="Debits (house takes)"
        value={formatCurrency(overview.debitVolume)}
        sub={`${formatNumber(overview.debitCount)} debit rows`}
        icon={TrendingDown}
        accent="emerald"
      />
      <KpiTile
        label="Net to users"
        value={`${overview.netUserGain >= 0 ? "+" : "−"}${formatCurrency(Math.abs(overview.netUserGain))}`}
        sub={overview.netUserGain >= 0 ? "net house payout" : "net house clawback"}
        icon={Scale}
        accent={netAccent}
      />
      <KpiTile
        label="Adjustments"
        value={formatNumber(overview.count)}
        sub={formatDeltaSub(prior?.countDelta ?? null)}
        icon={Hash}
        accent="blue"
      />
      <KpiTile
        label="Users affected"
        value={formatNumber(overview.uniqueUsers)}
        sub={formatDeltaSub(prior?.userDelta ?? null)}
        icon={Users}
        accent="blue"
      />
      <KpiTile
        label="Admins adjusting"
        value={formatNumber(overview.uniqueAdmins)}
        sub="distinct actors (audit trail)"
        icon={ShieldCheck}
        accent="cyan"
      />
      <KpiTile
        label="Avg size"
        value={formatCurrency(overview.avgSize)}
        sub={`median ${formatCurrency(overview.medianSize)} · max ${formatCurrency(overview.maxSize)}`}
        icon={Sigma}
        accent="amber"
      />
    </div>
  );
}

function formatDeltaSub(delta: number | null): string {
  if (delta === null) return "vs prior — no prior frame";
  if (delta === 0) return "no change vs prior";
  const arrow = delta > 0 ? "▲" : "▼";
  return `${arrow} ${(Math.abs(delta) * 100).toFixed(1)}% vs prior`;
}
