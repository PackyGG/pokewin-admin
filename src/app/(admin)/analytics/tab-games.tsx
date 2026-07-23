import { Suspense } from "react";
import Link from "next/link";
import { Dices, LineChart, Package, Swords, ArrowUpCircle } from "lucide-react";

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
import { getUpgraderStats } from "@/lib/queries/dashboard-upgrader";
import { DoubleDownSearchForm } from "../insights/double-down/search-form";
import { DoubleDownStatsSection } from "../insights/double-down/stats-section";
import { DoubleDownLogSection } from "../insights/double-down/log-section";
import { DoubleDownChartsSection } from "../insights/double-down/charts-section";
import type { AnalyticsPeriod } from "./types";

const LOG_PER_PAGE = 25;

/**
 * The modes a player can put money into that still have a surface here.
 * Packs and battles were removed (owner, 2026-07-23) along with the Top
 * Performers tab — their tab files, query modules and ClickHouse twins went
 * with them, so `?g=packs` / `?g=battles` fall back to Upgrader.
 */
export const GAME_VIEWS = ["upgrader", "double-down"] as const;
export type GameView = (typeof GAME_VIEWS)[number];

export function parseGameView(value: string | undefined): GameView {
  return (GAME_VIEWS as readonly string[]).includes(value ?? "")
    ? (value as GameView)
    : "upgrader";
}

const VIEW_META: { value: GameView; label: string; icon: typeof Dices }[] = [
  { value: "upgrader", label: "Upgrader", icon: ArrowUpCircle },
  { value: "double-down", label: "Double Down", icon: Dices },
];

/**
 * Games — one tab for every mode a player can lose money in.
 *
 * Replaces the separate "Double Down" and "Pack & Battle" tabs (owner,
 * 2026-07-23). Upgrader had no analytics surface at all despite being
 * wagered on like the rest; packs and battles were dropped in the same
 * pass, so what's left is upgrader + double down.
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
}: {
  view: GameView;
  period: AnalyticsPeriod;
  ddPeriod: DoubleDownPeriod;
  search: string;
  page: number;
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

      {view === "upgrader" && (
        <Suspense fallback={<KpiStripSkeleton count={5} />}>
          <UpgraderSection />
        </Suspense>
      )}
      {view === "double-down" && (
        <DoubleDownSection search={search} page={page} period={ddPeriod} />
      )}
    </div>
  );
}

/**
 * Upgrader — the mode that had no analytics page at all. Lifetime figures
 * from the same cached read the dashboard's Upgrader card uses, so the two
 * can't disagree.
 *
 * House POV: `pnl` positive = the house kept it = emerald. `edge` is measured
 * hold, not the configured target.
 */
async function UpgraderSection() {
  const { data, error } = await safeQuery(
    () => getUpgraderStats(),
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
    { label: "Wagered", value: formatCurrency(data.wager), tone: "" },
    {
      label: "Paid out",
      value: formatCurrency(data.payouts),
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
      <SectionHeading icon={ArrowUpCircle} title="Upgrader — lifetime" />
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
export function GamesTabSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-10 w-full rounded-lg" />
      <KpiStripSkeleton count={5} />
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  );
}
