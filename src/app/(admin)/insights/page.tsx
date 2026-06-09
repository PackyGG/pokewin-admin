import { Suspense } from "react";
import Link from "next/link";
import {
  Compass,
  Coins,
  TrendingUp,
  TrendingDown,
  Scale,
  Gift,
  LineChart,
  Sparkles,
  Gauge,
  ArrowRight,
  Activity,
} from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
  KpiTile,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { safeQuery } from "@/lib/errors/safe-query";
import { formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import {
  parseInsightsPeriod,
  INSIGHTS_PERIOD_LABELS,
  type InsightsPeriod,
} from "./analytics/types";
import { CostBreakdownPeriodFilter } from "./cost-breakdown/period-filter";
import { getCostBreakdown } from "@/lib/queries/insights-analytics/cost-breakdown";

export const metadata = { title: "Insights" };

/**
 * /insights — the Insights hub. Lands admins on a single page that
 * answers two questions:
 *
 *   1. "How is the business doing right now?" — a 6-tile headline KPI
 *      strip (wager → GGR → reward cost → NGR → realized P&L → cost%
 *      of GGR) for the active period, all sourced from the SAME
 *      `getCostBreakdown` helper Cost Breakdown / Dashboard already
 *      use (no new math, no drift).
 *
 *   2. "Where do I drill in next?" — a quick-link grid of every
 *      sub-area (Cost Breakdown, Analytics, GGR, Games, Rewards,
 *      Balance Adjustments, Forecast, System Edge Plan), each card
 *      mirroring the sidebar label + icon so the entry point is
 *      discoverable from one screen.
 *
 * House-POV throughout: GGR/NGR/P&L positive → emerald (we keep);
 * negative → rose (we owe). Reward cost is always rose (we paid out).
 * Cost% of GGR is informational (cyan) — it's a ratio, not a flow.
 *
 * Active-timeframe-only: the KPI strip is the only data fetch the page
 * runs, wrapped in `<Suspense key={period}>` so swapping `?period=`
 * scopes a fresh fetch and never preloads other windows. The quick-link
 * grid is static markup. Total query work per render = ONE call to
 * `getCostBreakdown`, which is exactly what /insights/cost-breakdown
 * already runs.
 */
export default async function InsightsHubPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/insights");
  const params = await searchParams;
  const period = parseInsightsPeriod(params.period);
  const periodLabel = INSIGHTS_PERIOD_LABELS[period];

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <PageHeroIdentity
            icon={Compass}
            accent="cyan"
            title="Insights"
            subtitle="Headline platform margin + the entry point to every analytical surface"
          />
          <div className="flex flex-wrap items-center gap-2">
            <CostBreakdownPeriodFilter />
          </div>
        </div>
      </PageHero>

      {/* KPI strip — the only data fetch on the page. Suspense keyed on
          `period` so swapping the chip mounts a fresh fetch (and unmounts
          the previous one) — no other windows preload. */}
      <section className="space-y-3">
        <SectionHeading
          icon={Activity}
          title={`Headline margin · ${periodLabel}`}
        />
        <Suspense key={period} fallback={<HeadlineKpiSkeleton />}>
          <HeadlineKpiStrip period={period} periodLabel={periodLabel} />
        </Suspense>
      </section>

      <section className="space-y-3">
        <SectionHeading icon={Compass} title="Drill in" />
        <FadeIn>
          <QuickLinkGrid />
        </FadeIn>
      </section>
    </div>
  );
}

// ─── Headline KPI strip ─────────────────────────────────────────────

/**
 * The 6 headline numbers, sourced from the canonical
 * `getCostBreakdown(period, …)` helper — the SAME helper
 * `/insights/cost-breakdown` calls. This keeps the hub reconciled with
 * Cost Breakdown / Dashboard / GGR by construction (one source of
 * truth, no parallel math).
 *
 * Color rules (house-POV, strict):
 *   • Total wager      — base / informational (blue)
 *   • GGR              — emerald when ≥ 0, rose when < 0 (house keeps / owes)
 *   • Reward cost      — always rose (every reward dollar is a house outflow)
 *   • NGR              — emerald when ≥ 0, rose when < 0
 *   • Realized P&L     — emerald when ≥ 0, rose when < 0 (the true bottom line)
 *   • Cost % of GGR    — cyan (a ratio, not a flow; informational)
 */
async function HeadlineKpiStrip({
  period,
  periodLabel,
}: {
  period: InsightsPeriod;
  periodLabel: string;
}) {
  const { data, error } = await safeQuery(
    () => getCostBreakdown(period, periodLabel, 0),
    null,
    "insights.hub.kpi",
  );

  if (error || !data) {
    return (
      <TileErrorFallback
        label="Headline margin"
        hint="The canonical cost-breakdown helper failed. Server logs hold the digest."
        size="panel"
      />
    );
  }

  const ggrPos = data.ggr >= 0;
  const ngrPos = data.ngr >= 0;
  const pnlPos = data.pnl >= 0;
  const costPctOfGgr = data.margin.costPctOfGgr;

  // Reward cost as % of GGR — the "how much of the gross margin did we
  // give back?" ratio. Falls back to a dash when GGR is non-positive
  // (the division is undefined / inverted-sign).
  const rewardPctOfGgrLabel =
    data.ggr > 0
      ? `${((data.rewardPayouts / data.ggr) * 100).toFixed(1)}% of GGR`
      : "no positive GGR";

  return (
    <FadeIn>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        <KpiTile
          label="Total wager"
          icon={Coins}
          accent="blue"
          value={formatCurrency(data.totalWager)}
          sub={`${periodLabel} · customer stake`}
        />
        <KpiTile
          label="GGR"
          icon={ggrPos ? TrendingUp : TrendingDown}
          accent={ggrPos ? "emerald" : "rose"}
          value={`${ggrPos ? "+" : "−"}${formatCurrency(Math.abs(data.ggr))}`}
          sub={
            data.margin.ggrPctOfWager !== null
              ? `${data.margin.ggrPctOfWager.toFixed(1)}% of wager · house edge`
              : "wager − gameplay winnings"
          }
        />
        <KpiTile
          label="Reward cost"
          icon={Gift}
          accent="rose"
          value={`−${formatCurrency(data.rewardPayouts)}`}
          sub={`${rewardPctOfGgrLabel} · house-funded giveaways`}
        />
        <KpiTile
          label="NGR"
          icon={Scale}
          accent={ngrPos ? "emerald" : "rose"}
          value={`${ngrPos ? "+" : "−"}${formatCurrency(Math.abs(data.ngr))}`}
          sub={
            data.margin.ngrPctOfWager !== null
              ? `${data.margin.ngrPctOfWager.toFixed(1)}% of wager · after rewards`
              : "GGR − reward cost"
          }
        />
        <KpiTile
          label="Realized P&L"
          icon={pnlPos ? TrendingUp : TrendingDown}
          accent={pnlPos ? "emerald" : "rose"}
          value={`${pnlPos ? "+" : "−"}${formatCurrency(Math.abs(data.pnl))}`}
          sub={
            data.margin.pnlPctOfWager !== null
              ? `${data.margin.pnlPctOfWager.toFixed(1)}% of wager · bottom line`
              : "deposits − withdrawals − holdings"
          }
        />
        <KpiTile
          label="Cost % of GGR"
          icon={TrendingDown}
          accent="cyan"
          value={costPctOfGgr !== null ? `${costPctOfGgr.toFixed(1)}%` : "—"}
          sub="Gross margin consumed"
        />
      </div>
    </FadeIn>
  );
}

function HeadlineKpiSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="h-[88px] animate-pulse rounded-xl border bg-card"
        />
      ))}
    </div>
  );
}

// ─── Quick-link grid ────────────────────────────────────────────────

type QuickLink = {
  href: string;
  label: string;
  description: string;
  icon: React.ElementType;
  accent: "blue" | "emerald" | "rose" | "cyan" | "amber" | "purple";
};

// Ordered to match the sidebar's Insights group reading order. Each
// entry mirrors its sidebar counterpart's label + lucide icon so the
// quick-link reads as the same destination an admin would click in the
// sidebar. Accents pulled from TILE_COLORS — rose for cost-leaning
// pages, emerald for margin-leaning, cyan/blue for analytical, amber
// for adjustments, purple for planning.
const QUICK_LINKS: ReadonlyArray<QuickLink> = [
  {
    href: "/insights/cost-breakdown",
    label: "Cost Breakdown",
    description: "Every wager → P&L leakage itemized",
    icon: TrendingDown,
    accent: "rose",
  },
  {
    href: "/insights/analytics",
    label: "Analytics",
    description: "Cohorts, retention, LTV, funnel, geo, money flow",
    icon: LineChart,
    accent: "cyan",
  },
  {
    href: "/ggr",
    label: "GGR",
    description: "Long-form GGR breakdown — windows, types, contributors",
    icon: TrendingUp,
    accent: "emerald",
  },
  {
    href: "/insights/rewards",
    label: "Rewards",
    description: "Cross-category reward spend, ROI, retention, forecast",
    icon: Gift,
    accent: "rose",
  },
  {
    href: "/insights/forecast",
    label: "Forecast",
    description: "Model reward programs before shipping a change",
    icon: Gauge,
    accent: "purple",
  },
  {
    href: "/insights/edge-plan-2",
    label: "Edge Plan 2.0",
    description: "Shards economy, balance withdrawals, full-width planner",
    icon: Sparkles,
    accent: "cyan",
  },
];

const QUICK_LINK_ACCENT: Record<
  QuickLink["accent"],
  { bg: string; ring: string; icon: string; hoverRing: string }
> = {
  blue: {
    bg: "bg-blue-500/10",
    ring: "ring-blue-500/20",
    icon: "text-blue-500",
    hoverRing: "hover:ring-blue-500/40",
  },
  emerald: {
    bg: "bg-emerald-500/10",
    ring: "ring-emerald-500/20",
    icon: "text-emerald-500",
    hoverRing: "hover:ring-emerald-500/40",
  },
  rose: {
    bg: "bg-rose-500/10",
    ring: "ring-rose-500/20",
    icon: "text-rose-500",
    hoverRing: "hover:ring-rose-500/40",
  },
  cyan: {
    bg: "bg-cyan-500/10",
    ring: "ring-cyan-500/20",
    icon: "text-cyan-500",
    hoverRing: "hover:ring-cyan-500/40",
  },
  amber: {
    bg: "bg-amber-500/10",
    ring: "ring-amber-500/20",
    icon: "text-amber-500",
    hoverRing: "hover:ring-amber-500/40",
  },
  purple: {
    bg: "bg-purple-500/10",
    ring: "ring-purple-500/20",
    icon: "text-purple-500",
    hoverRing: "hover:ring-purple-500/40",
  },
};

function QuickLinkGrid() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {QUICK_LINKS.map((link) => {
        const accent = QUICK_LINK_ACCENT[link.accent];
        const Icon = link.icon;
        return (
          <Link
            key={link.href}
            href={link.href}
            className={cn(
              "hover-raise surface-sheen group relative flex items-start gap-3 overflow-hidden rounded-xl border bg-card p-4 ring-1 ring-foreground/10 transition-shadow",
              accent.hoverRing,
            )}
          >
            <div
              className={cn(
                "flex size-10 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset",
                accent.bg,
                accent.ring,
              )}
            >
              <Icon className={cn("size-5", accent.icon)} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <h4 className="truncate text-sm font-semibold tracking-tight">
                  {link.label}
                </h4>
                <ArrowRight
                  aria-hidden
                  className="size-3.5 shrink-0 text-muted-foreground transition-transform motion-safe:group-hover:translate-x-0.5"
                />
              </div>
              <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                {link.description}
              </p>
            </div>
          </Link>
        );
      })}
    </div>
  );
}
