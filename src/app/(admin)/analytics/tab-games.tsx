import { Suspense } from "react";
import Link from "next/link";
import {
  Dices,
  LineChart,
  Package,
  Swords,
  ArrowUpCircle,
  Grid3X3,
} from "lucide-react";

import { SectionHeading } from "@/components/modern-panels";
import {
  KpiStripSkeleton,
  TableSkeleton,
  ChartSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import {
  doubleDownPeriodLabel,
  type DoubleDownPeriod,
} from "@/lib/queries/double-down";
import {
  getUpgraderAnalytics,
  upgraderPeriodLabel,
} from "@/lib/queries/analytics-upgrader";
import { DoubleDownSearchForm } from "../insights/double-down/search-form";
import { DoubleDownStatsSection } from "../insights/double-down/stats-section";
import { DoubleDownLogSection } from "../insights/double-down/log-section";
import { DoubleDownChartsSection } from "../insights/double-down/charts-section";
import { PacksBattlesTab } from "./tab-packs";
import { UpgraderCharts } from "./upgrader-charts";
import type { AnalyticsPeriod } from "./types";
import { KenoTabNav } from "../keno/_components/keno-tab-nav";
import { KenoOverviewTab } from "../keno/_components/overview-tab";
import { KenoConfigurationTab } from "../keno/_components/configuration-tab";
import { KenoOddsTab } from "../keno/_components/odds-tab";
import type { KenoTab } from "../keno/tabs";

const LOG_PER_PAGE = 25;

/**
 * The five things a player can actually put money into.
 *
 * Packs and battles were briefly dropped here (2026-07-23) alongside the Top
 * Performers tab and restored the same day — they are the two biggest modes
 * on the site, so a "Games" tab without them answered almost nothing.
 */
const GAME_VIEWS = [
  "packs",
  "battles",
  "upgrader",
  "double-down",
  "keno",
] as const;
export type GameView = (typeof GAME_VIEWS)[number];

export function parseGameView(value: string | undefined): GameView {
  return (GAME_VIEWS as readonly string[]).includes(value ?? "")
    ? (value as GameView)
    : "packs";
}

const VIEW_META: { value: GameView; label: string; icon: typeof Dices }[] = [
  { value: "packs", label: "Packs", icon: Package },
  { value: "battles", label: "Battles", icon: Swords },
  { value: "upgrader", label: "Upgrader", icon: ArrowUpCircle },
  { value: "double-down", label: "Double Down", icon: Dices },
  { value: "keno", label: "Keno", icon: Grid3X3 },
];

/**
 * Games — one tab for every mode a player can lose money in.
 *
 * Replaces the separate "Double Down" and "Pack & Battle" tabs (owner,
 * 2026-07-23). Upgrader had no analytics surface at all despite being
 * wagered on like the rest, so it gained one here.
 *
 * The sub-nav is plain links, not a client component: each view is a server
 * segment and the whole tab re-renders on `?g=` anyway, so there is nothing
 * for client JS to do here. Only the ACTIVE view's queries run — the others
 * aren't rendered, so they never touch the DB (active-tab-only).
 */
export function GamesTab({
  view,
  period,
  ddPeriod,
  search,
  page,
  packsSort,
  kenoTab,
  canEditKeno,
}: {
  view: GameView;
  period: AnalyticsPeriod;
  ddPeriod: DoubleDownPeriod;
  search: string;
  page: number;
  packsSort: string | undefined;
  kenoTab: KenoTab;
  canEditKeno: boolean;
}) {
  return (
    <div className="space-y-6">
      {/* Sub-nav. Carries the page-level period through so switching modes
          doesn't silently reset the window the operator picked. */}
      <div className="flex gap-1 overflow-x-auto overscroll-x-contain rounded-lg border bg-muted/50 p-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {VIEW_META.map(({ value, label, icon: Icon }) => (
          <Link
            key={value}
            href={`/analytics?tab=games&g=${value}&period=${period}`}
            replace
            prefetch={false}
            aria-current={view === value ? "page" : undefined}
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              view === value
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-3.5" />
            {label}
          </Link>
        ))}
      </div>

      {view === "packs" && (
        <PacksBattlesTab period={period} sortKey={packsSort} view="packs" />
      )}
      {view === "battles" && (
        <PacksBattlesTab period={period} sortKey={packsSort} view="battles" />
      )}
      {view === "upgrader" && (
        <Suspense
          key={`upgrader-${period}`}
          fallback={
            <div className="space-y-4">
              <KpiStripSkeleton count={5} />
              <div className="grid gap-4 xl:grid-cols-2">
                <ChartSkeleton height={220} />
                <ChartSkeleton height={220} />
              </div>
            </div>
          }
        >
          <UpgraderSection period={period} />
        </Suspense>
      )}
      {view === "double-down" && (
        <DoubleDownSection search={search} page={page} period={ddPeriod} />
      )}
      {view === "keno" && (
        <KenoSection tab={kenoTab} canEdit={canEditKeno} period={period} />
      )}
    </div>
  );
}

function KenoSection({
  tab,
  canEdit,
  period,
}: {
  tab: KenoTab;
  canEdit: boolean;
  period: AnalyticsPeriod;
}) {
  return (
    <div className="space-y-6">
      <KenoTabNav current={tab} period={period} />
      <Suspense
        key={tab}
        fallback={
          <div className="space-y-6">
            <KpiStripSkeleton count={6} />
            <TableSkeleton rows={8} columns={6} />
          </div>
        }
      >
        {tab === "configuration" ? (
          <KenoConfigurationTab canEdit={canEdit} />
        ) : tab === "odds" ? (
          <KenoOddsTab />
        ) : (
          <KenoOverviewTab />
        )}
      </Suspense>
    </div>
  );
}

/**
 * Upgrader — the mode that had no analytics page at all.
 *
 * Was lifetime-only, reading the DASHBOARD's card query: the page's period
 * chip did nothing here and there was no trend at all, just nine static
 * numbers. It now reads the period-aware `getUpgraderAnalytics`, which
 * returns the same primitives over the selected window PLUS the per-day
 * series the charts below draw — from one scan, so the trend is free.
 *
 * House POV: `pnl` positive = the house kept it = emerald; `payout` is money
 * back to the player = rose. `edge` is MEASURED hold, not the configured
 * target, and arrives as a fraction (the dashboard read returns it
 * pre-multiplied by 100 — rendering that one with a second ×100 is what made
 * this strip print a 10% hold as "1000.00%").
 */
async function UpgraderSection({ period }: { period: AnalyticsPeriod }) {
  const { data, error } = await safeQuery(
    // No cast: AnalyticsPeriod and UpgraderPeriod carry the same members, so
    // if either ever gains one the mismatch surfaces here instead of being
    // silently swallowed.
    () => getUpgraderAnalytics(period),
    null,
    "analytics.games.upgrader",
    REWARD_QUERY_TIMEOUT_MS,
  );
  if (error || !data) {
    return (
      <TileErrorFallback
        label="Upgrader stats"
        hint="The upgrader aggregate failed — refresh to retry."
        size="panel"
      />
    );
  }

  const tiles = [
    {
      label: "Wagered",
      value: formatCurrency(data.wager),
      tone: "text-emerald-500",
    },
    {
      label: "Paid out",
      value: formatCurrency(data.payout),
      tone: "text-rose-500",
    },
    {
      label: "House P&L",
      value: `${data.pnl >= 0 ? "+" : ""}${formatCurrency(data.pnl)}`,
      tone: data.pnl >= 0 ? "text-emerald-500" : "text-rose-500",
    },
    {
      label: "Measured hold",
      value: `${(data.edge * 100).toFixed(2)}%`,
      tone: data.edge >= 0 ? "text-emerald-500" : "text-rose-500",
    },
    { label: "Players", value: formatNumber(data.uniquePlayers), tone: "" },
  ];

  return (
    <div className="space-y-4">
      <SectionHeading
        icon={ArrowUpCircle}
        title={`Upgrader — ${upgraderPeriodLabel(data.period).toLowerCase()}`}
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {tiles.map((t) => (
          <div
            key={t.label}
            className="h-full rounded-lg border bg-card px-3 py-2.5"
          >
            <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              {t.label}
            </p>
            <p className={cn("mt-1 text-xl font-bold tabular-nums", t.tone)}>
              {t.value}
            </p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          { label: "Bets", value: formatNumber(data.bets) },
          { label: "Avg bet", value: formatCurrency(data.avgBet) },
          {
            label: "Wins / losses",
            value: `${formatNumber(data.wins)} / ${formatNumber(data.losses)}`,
          },
          { label: "Hit rate", value: `${(data.hitRate * 100).toFixed(1)}%` },
        ].map((t) => (
          <div
            key={t.label}
            className="h-full rounded-lg border bg-card px-3 py-2.5"
          >
            <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              {t.label}
            </p>
            <p className="mt-1 text-lg font-semibold tabular-nums">{t.value}</p>
          </div>
        ))}
      </div>

      {/* Trend. Same scan as the tiles above — the query returns the daily
          series alongside the totals, so the charts cost no extra read. */}
      <UpgraderCharts data={data.daily} />
    </div>
  );
}

/** Double Down — the former standalone page, unchanged apart from its hero. */
function DoubleDownSection({
  search,
  page,
  period,
}: {
  search: string;
  page: number;
  period: DoubleDownPeriod;
}) {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Gamble-your-battle-winnings tracking — win/lose, total wager, and
          House-POV P&amp;L over every started round.
        </p>
        <span className="text-xs text-muted-foreground">
          {doubleDownPeriodLabel(period)}
        </span>
      </div>

      {/* Keyed ONLY on period so the KPI strip never re-skeletons when the log
          paginates or the search changes. */}
      <Suspense
        key={`kpi-${period}`}
        fallback={<KpiStripSkeleton count={5} />}
      >
        <DoubleDownStatsSection period={period} />
      </Suspense>

      <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
        <section className="space-y-3">
          <SectionHeading icon={Dices} title="Audit log" />
          <DoubleDownSearchForm />
          <Suspense
            key={`log-${period}-${page}-${search}`}
            fallback={<TableSkeleton rows={8} />}
          >
            <DoubleDownLogSection
              period={period}
              page={page}
              perPage={LOG_PER_PAGE}
              search={search}
            />
          </Suspense>
        </section>

        <section className="space-y-3">
          <SectionHeading icon={LineChart} title="Trends" />
          <Suspense
            key={`charts-${period}`}
            fallback={
              <div className="flex flex-col gap-4">
                <ChartSkeleton height={200} />
                <ChartSkeleton height={200} />
              </div>
            }
          >
            <DoubleDownChartsSection period={period} />
          </Suspense>
        </section>
      </div>
    </div>
  );
}

/** Kept so the tab file owns its own loading shape. */
function GamesTabSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-10 w-full rounded-lg" />
      <KpiStripSkeleton count={5} />
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  );
}
