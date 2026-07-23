import { Suspense } from "react";
import { Dices, LineChart } from "lucide-react";

import { SectionHeading } from "@/components/modern-panels";
import {
  KpiStripSkeleton,
  TableSkeleton,
  ChartSkeleton,
} from "@/components/loading-skeletons";
import {
  doubleDownPeriodLabel,
  type DoubleDownPeriod,
} from "@/lib/queries/double-down";
import { DoubleDownSearchForm } from "../insights/double-down/search-form";
import { DoubleDownStatsSection } from "../insights/double-down/stats-section";
import { DoubleDownLogSection } from "../insights/double-down/log-section";
import { DoubleDownChartsSection } from "../insights/double-down/charts-section";

const LOG_PER_PAGE = 25;



/**
 * Double Down as an /analytics tab.
 *
 * Was the standalone page `/insights/double-down` (owner, 2026-07-23: the
 * insights section shouldn't be its own place). Same sections, same queries,
 * same Suspense keying — the only thing dropped is its PageHero, because
 * /analytics already renders one; the period line moved into the section
 * heading instead.
 *
 * Its section components still live under `insights/double-down/` — they are
 * plain components, not routes, so nothing about them was route-specific.
 * The old URL 308-redirects here (see insights/double-down/page.tsx).
 *
 * Params come from the analytics page's own searchParams: `?q=` for the log
 * search, `?page=` for its pagination. Both are namespaced by the tab being
 * active, so they can't collide with another tab's params.
 *
 * PERIOD: this was pinned to 30d (owner rule, 2026-07-01) back when it was a
 * standalone page with no filter of its own. Now that it is an /analytics tab
 * it reads the page-level timespan like every other tab (owner, 2026-07-23) —
 * the query module was always period-parametrized, so this only stops the
 * surface throwing that parameter away.
 */
export function DoubleDownTab({
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

      {/* KPI strip (5 tiles) — keyed ONLY on period so it never re-skeletons
          when the log paginates or the search changes. */}
      <Suspense key={`kpi-${period}`} fallback={<KpiStripSkeleton count={5} />}>
        <DoubleDownStatsSection period={period} />
      </Suspense>

      {/* 2-col: LEFT the round-by-round audit log, RIGHT the two stacked
          charts. Stacks single-column on mobile, side-by-side at lg. */}
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
