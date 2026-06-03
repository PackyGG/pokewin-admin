import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Coins,
  DollarSign,
  Eye,
  TrendingUp,
  UserPlus,
  BarChart3,
  Sparkles,
  Megaphone,
} from "lucide-react";
import { FadeIn } from "@/components/fade-in";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  SectionHeading,
  TILE_COLORS,
  type AccentColor,
} from "@/components/modern-panels";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { getInsightsOverview } from "@/lib/queries/insights-analytics/overview";
import {
  INSIGHTS_PERIOD_LABELS,
  type InsightsPeriod,
} from "./types";
import { DeltaChip } from "./delta-chip";
import { KpiSparkline } from "./kpi-sparkline";
import { OverviewChart } from "./overview-chart";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";

/**
 * Overview tab — top-line KPIs (deposits, withdrawals, wager, GGR, NGR,
 * signups, unique active) for the selected period, each with a sparkline
 * and a delta chip vs the previous comparable period (e.g. 7d vs the
 * previous 7d). House-POV color rule applies throughout.
 *
 * The lifetime period skips the previous-period comparison (no
 * meaningful prior window).
 */
export async function OverviewInsightsTab({ period }: { period: InsightsPeriod }) {
  const { data, error } = await safeQuery(
    () => getInsightsOverview(period),
    null,
    "insights-analytics.overview",
    REWARD_QUERY_TIMEOUT_MS,
  );
  if (error || !data) {
    return (
      <TileErrorFallback
        label="Analytics — Overview"
        hint="The overview query failed. Server logs hold the digest."
        size="panel"
      />
    );
  }
  const { current, previous, daily } = data;

  // Helper to slice the daily series into a sparkline array for one metric.
  const spark = (key: keyof (typeof daily)[number]) =>
    daily.map((d) => (typeof d[key] === "number" ? (d[key] as number) : 0));

  return (
    <FadeIn>
      <div className="space-y-6">
        <Intro period={period} />

        <div className="grid gap-3 grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4">
          <BigKpi
            label="Deposits"
            value={formatCurrency(current.deposits)}
            sub={`${formatNumber(current.depositCount)} txns`}
            icon={ArrowDownToLine}
            accent="emerald"
            delta={previous?.deposits ?? null}
            currentRaw={current.deposits}
            spark={spark("deposits")}
            sparkAccent="emerald"
            // Deposits = money flowing TO house, but the user hasn't lost
            // it yet — emerald per CLAUDE.md mapping. Up = good for house.
            houseFavorable="up"
          />
          <BigKpi
            label="Withdrawals"
            value={formatCurrency(current.withdrawals)}
            sub="Card withdrawals · completed/shipped"
            icon={ArrowUpFromLine}
            accent="rose"
            delta={previous?.withdrawals ?? null}
            currentRaw={current.withdrawals}
            spark={spark("withdrawals")}
            sparkAccent="rose"
            // Withdrawals = user pulling money out → user wins → rose.
            // Up = worse for house.
            houseFavorable="down"
          />
          <BigKpi
            label="Wager"
            value={formatCurrency(current.wager)}
            sub="Customer wager, ex creator on-stream"
            icon={Coins}
            accent="emerald"
            delta={previous?.wager ?? null}
            currentRaw={current.wager}
            spark={spark("wager")}
            sparkAccent="emerald"
            houseFavorable="up"
          />
          <BigKpi
            label="Organic Wager"
            value={formatCurrency(current.wagerOrganic)}
            sub={
              current.wager > 0
                ? `${((current.wagerOrganic / current.wager) * 100).toFixed(0)}% of customer wager · no creator code`
                : "Customer wager · no creator code"
            }
            icon={Sparkles}
            accent="emerald"
            delta={previous?.wagerOrganic ?? null}
            currentRaw={current.wagerOrganic}
            spark={spark("wagerOrganic")}
            sparkAccent="emerald"
            // Organic wager is customer stake placed (house-positive on
            // entry) → emerald, up = good for house.
            houseFavorable="up"
          />
          <BigKpi
            label="Creator-Coded Wager"
            value={formatCurrency(current.wagerCreatorCoded)}
            sub={
              current.wager > 0
                ? `${((current.wagerCreatorCoded / current.wager) * 100).toFixed(0)}% of customer wager · joined under a creator`
                : "Customer wager · joined under a creator"
            }
            icon={Megaphone}
            accent="amber"
            delta={previous?.wagerCreatorCoded ?? null}
            currentRaw={current.wagerCreatorCoded}
            spark={spark("wagerCreatorCoded")}
            sparkAccent="amber"
            houseFavorable="up"
          />
          <BigKpi
            label="GGR"
            value={formatCurrency(current.ggr)}
            sub="Gross gaming revenue — wager − gaming payout (inventory-delta)"
            icon={DollarSign}
            // GGR is the headline house-POV number. positive = emerald,
            // negative would render rose via the value-tint below.
            accent={current.ggr >= 0 ? "emerald" : "rose"}
            delta={previous?.ggr ?? null}
            currentRaw={current.ggr}
            spark={spark("ggr")}
            sparkAccent={current.ggr >= 0 ? "emerald" : "rose"}
            houseFavorable="up"
          />
          <BigKpi
            label="NGR"
            value={formatCurrency(current.ngr)}
            sub="Net gaming revenue — GGR − reward cost (net rain)"
            icon={TrendingUp}
            accent={current.ngr >= 0 ? "emerald" : "rose"}
            delta={previous?.ngr ?? null}
            currentRaw={current.ngr}
            spark={spark("ngr")}
            sparkAccent={current.ngr >= 0 ? "emerald" : "rose"}
            houseFavorable="up"
          />
          <BigKpi
            label="New Signups"
            value={formatNumber(current.newSignups)}
            sub="New user accounts in period"
            icon={UserPlus}
            accent="blue"
            delta={previous?.newSignups ?? null}
            currentRaw={current.newSignups}
            spark={spark("signups")}
            sparkAccent="blue"
            // Signups are house-positive growth but stored color-neutral
            // per CLAUDE.md (signup is an info event).
            houseFavorable="up"
          />
          <BigKpi
            label="Active Users"
            value={formatNumber(current.uniqueActive)}
            sub="Distinct users with completed txn"
            icon={Eye}
            accent="cyan"
            delta={previous?.uniqueActive ?? null}
            currentRaw={current.uniqueActive}
            spark={spark("active")}
            sparkAccent="cyan"
            // Just a footprint metric — no direction is good or bad.
            houseFavorable="neutral"
          />
          <BigKpi
            label="P&L Margin"
            value={`${current.wager > 0 ? ((current.ggr / current.wager) * 100).toFixed(2) : "0"}%`}
            sub="GGR / Wager (house hold rate)"
            icon={BarChart3}
            accent={current.ggr >= 0 ? "emerald" : "rose"}
            // Margin doesn't have a clean previous-vs-now since wager + GGR
            // both move; just show the chip pointing at the GGR delta.
            delta={
              previous && previous.wager > 0 && current.wager > 0
                ? (previous.ggr / previous.wager) * 100
                : null
            }
            currentRaw={current.wager > 0 ? (current.ggr / current.wager) * 100 : 0}
            spark={spark("ggr")}
            sparkAccent={current.ggr >= 0 ? "emerald" : "rose"}
            houseFavorable="up"
          />
        </div>

        <FadeIn>
          <SectionHeading icon={TrendingUp} title="Daily breakdown" />
          <Card className="mt-3">
            <CardHeader>
              <CardTitle className="text-sm font-medium">
                Deposits, withdrawals, revenue & wager attribution per day
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                Series uses house-POV colors: deposits + wager + GGR are
                emerald (house-positive on entry), withdrawals are rose
                (money flowing back out); the attribution chart splits
                customer wager into organic (emerald) vs creator-coded
                (amber). Sparklines above are scoped to the period; these
                charts show the full daily series so period spikes are
                visible against trend.
              </p>
            </CardHeader>
            <CardContent>
              <OverviewChart data={daily} />
            </CardContent>
          </Card>
        </FadeIn>
      </div>
    </FadeIn>
  );
}

function Intro({ period }: { period: InsightsPeriod }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border bg-muted/20 p-4">
      <div className="rounded-md bg-primary/10 p-1.5">
        <BarChart3 className="size-4 text-primary" />
      </div>
      <div className="text-sm">
        <h3 className="font-semibold">Period overview</h3>
        <p className="text-muted-foreground">
          Top-line KPIs for {INSIGHTS_PERIOD_LABELS[period].toLowerCase()}, with
          a delta chip comparing against the previous comparable window. GGR /
          NGR use the canonical inventory-delta model (card conversions
          neutral, net-rain NGR) so they reconcile with /ggr and the dashboard.
          &quot;Organic&quot; wager is from customers who did not join under a
          creator code; the rest is creator-coded. House point-of-view: emerald
          = house up, rose = house down. Excludes staff, blacklisted users, and
          creator on-stream sponsored play.
        </p>
      </div>
    </div>
  );
}

function BigKpi({
  label,
  value,
  sub,
  icon: Icon,
  accent,
  delta,
  currentRaw,
  spark,
  sparkAccent,
  houseFavorable,
}: {
  label: string;
  value: string;
  sub: string;
  icon: React.ElementType;
  accent: AccentColor;
  delta: number | null;
  currentRaw: number;
  spark: number[];
  sparkAccent: AccentColor;
  houseFavorable: "up" | "down" | "neutral";
}) {
  const colors = TILE_COLORS[accent];
  return (
    <div
      className={cn(
        "hover-raise surface-sheen relative overflow-hidden rounded-xl border p-3 sm:p-4",
        colors.bg,
      )}
    >
      {/* Accent bar + sheen — same family as KpiTile / MetricTile so a
          mixed-tile grid reads as one set. */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 left-0 w-0.5 bg-current opacity-50",
          colors.icon,
        )}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-gradient-to-br from-white/[0.04] to-transparent"
      />
      <div className="relative flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <Icon className={cn("size-3.5 shrink-0", colors.icon)} />
          <span className="truncate text-[10px] font-semibold uppercase tracking-wider text-muted-foreground sm:text-[11px]">
            {label}
          </span>
        </div>
        <DeltaChip
          current={currentRaw}
          previous={delta}
          houseFavorable={houseFavorable}
        />
      </div>
      <p
        className={cn(
          "relative mt-1 truncate text-xl font-bold tracking-tight tabular-nums sm:text-2xl",
          colors.text,
        )}
      >
        {value}
      </p>
      <p className="relative mt-0.5 truncate text-[10px] text-muted-foreground sm:text-[11px]">
        {sub}
      </p>
      <div className="relative mt-2">
        <KpiSparkline points={spark} accent={sparkAccent} />
      </div>
    </div>
  );
}
