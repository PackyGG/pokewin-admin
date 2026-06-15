import Link from "next/link";
import {
  CircleDollarSign,
  LineChart,
  Receipt,
  Sparkles,
  Users,
} from "lucide-react";
import {
  KpiTile,
  PanelRow,
  SectionHeading,
  StatPanel,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { RelativeTime } from "@/components/relative-time";
import { EmptyState } from "@/components/empty-state";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { safeQuery } from "@/lib/errors/safe-query";
import { compareXpSales } from "@/lib/clickhouse/compare/xp-sales";
import {
  getXpSales,
  xpSalesPeriodLabel,
  type XpSalesPeriod,
} from "@/lib/queries/insights-xp-sales";
import { XpSalesPeriodFilter } from "./period-filter";
import { XpSalesTrendChart } from "./xp-sales-trend-chart";

/**
 * Global XP-sales economy — the body of /xp-sales.
 *
 * Surfaces every `xp_purchase` ledger row (the user spending withdrawable
 * USD balance to buy XP) over the active window: a KPI strip (sales, revenue,
 * buyers, avg/sale), a daily revenue trend, and a recent-sales list.
 *
 * House-POV (CLAUDE.md "Finanz-Farben"): buying XP spends the user's own
 * (withdrawable) balance — a dollar we owed them is given up → a house GAIN →
 * the revenue figure + the per-row spend read EMERALD. Counts (sales, buyers)
 * are neutral signals → cyan/blue. XP granted is a non-USD secondary unit →
 * neutral purple.
 *
 * Active-timeframe-only: fetches just the active window via the period-keyed
 * Suspense boundary in page.tsx. Customer-scoped (staff + creators dropped).
 */

export async function XpSalesSection({ period }: { period: XpSalesPeriod }) {
  const { data: stats } = await safeQuery(
    () => getXpSales(period),
    null,
    "insights.xpSales",
    15_000,
  );

  const heading = (
    <SectionHeading
      icon={Sparkles}
      title="XP sales"
      action={<XpSalesPeriodFilter />}
    />
  );

  if (!stats) {
    return (
      <div className="space-y-3">
        {heading}
        <TileErrorFallback
          label="XP sales"
          hint="The XP-sales read failed — no data was changed. Try again."
          size="panel"
        />
      </div>
    );
  }

  // Fire-and-forget CQRS comparison (no-op unless the `xp_sales` surface is in
  // comparison mode). The served Postgres payload above is the truth and is
  // never awaited on / altered by this call.
  void compareXpSales(period, stats);

  const periodLabel = xpSalesPeriodLabel(stats.period);

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        {heading}

        {/* KPI strip. House-POV: XP revenue = balance users gave up to buy XP
            (house takes in) → emerald. Sales / buyers are neutral counts. */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <KpiTile
            label="XP revenue"
            value={formatCurrency(stats.revenue)}
            sub={periodLabel}
            icon={CircleDollarSign}
            accent="emerald"
          />
          <KpiTile
            label="XP sales"
            value={formatNumber(stats.saleCount)}
            sub={`${formatNumber(stats.xpGranted)} XP granted`}
            icon={Receipt}
            accent="cyan"
          />
          <KpiTile
            label="Buyers"
            value={formatNumber(stats.buyers)}
            sub="distinct users"
            icon={Users}
            accent="blue"
          />
          <KpiTile
            label="Avg / sale"
            value={formatCurrency(stats.avgPerSale)}
            sub="balance spent per sale"
            icon={CircleDollarSign}
            accent="emerald"
          />
        </div>

        {/* Daily revenue trend. */}
        <StatPanel title="Daily XP revenue" icon={LineChart} accent="emerald">
          <XpSalesTrendChart daily={stats.daily} />
        </StatPanel>

        {/* Recent sales — newest first, user + spend + XP granted per row. */}
        <FadeIn>
          <StatPanel title="Recent XP sales" icon={Receipt} accent="cyan">
            {stats.recent.length === 0 ? (
              <EmptyState
                icon={Sparkles}
                title="No XP sales in this window"
                description={`No XP purchases landed in ${periodLabel.toLowerCase()}. Try a longer window.`}
                compact
              />
            ) : (
              <div className="space-y-0.5">
                {stats.recent.map((s) => (
                  <PanelRow
                    key={s.id}
                    label={`${s.username ?? s.userId.slice(0, 8)} · ${
                      s.xpAwarded != null
                        ? `${formatNumber(s.xpAwarded)} XP`
                        : "XP"
                    }`}
                    value={
                      <span className="flex items-center gap-3">
                        <span className="text-[11px] font-normal text-muted-foreground">
                          <RelativeTime date={s.createdAt} />
                        </span>
                        <Link
                          href={`/users/${s.userId}`}
                          className="text-emerald-600 hover:underline dark:text-emerald-400"
                        >
                          +{formatCurrency(s.amount)}
                        </Link>
                      </span>
                    }
                  />
                ))}
              </div>
            )}
          </StatPanel>
        </FadeIn>

        <p className="text-[11px] leading-relaxed text-muted-foreground">
          An XP sale is a user spending their own (withdrawable) balance to buy
          XP — from the house perspective that balance is a dollar we owed them,
          now given up, so XP revenue is a{" "}
          <span className="text-emerald-600 dark:text-emerald-400">
            house gain
          </span>
          . Figures are customer-only (staff &amp; creators excluded) and cover{" "}
          {periodLabel.toLowerCase()}.
        </p>
      </div>
    </div>
  );
}
