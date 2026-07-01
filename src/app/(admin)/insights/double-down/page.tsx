import { Suspense } from "react";
import { Dices, LineChart } from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { PageHero, PageHeroIdentity, SectionHeading } from "@/components/modern-panels";
import {
  KpiStripSkeleton,
  TableSkeleton,
  ChartSkeleton,
} from "@/components/loading-skeletons";
import {
  parseDoubleDownPeriod,
  doubleDownPeriodLabel,
} from "@/lib/queries/double-down";
import { DoubleDownPeriodFilter } from "./period-filter";
import { DoubleDownSearchForm } from "./search-form";
import { DoubleDownStatsSection } from "./stats-section";
import { DoubleDownLogSection } from "./log-section";
import { DoubleDownChartsSection } from "./charts-section";

export const metadata = { title: "Double Down" };

const LOG_PER_PAGE = 25;

/**
 * /insights/double-down — read-only tracking for the Double Down feature.
 *
 * Double Down lets a user gamble their battle winnings: on a WIN they are paid
 * a voucher, on a LOSE they forfeit the whole win. The house margin is in the
 * win odds (~45% player / 55% site), not a per-round cut. This page shows the
 * global picture (a House-POV KPI strip), the FULL audit log of every started
 * round (who won / lost + the stake), and two trend charts (usage + P&L).
 *
 * Backend rules (CLAUDE.md / BACKEND_QUERY_SYSTEM.md):
 *   - Reads come from ONE shared module `src/lib/queries/double-down.ts`
 *     (consumed by this page AND the /users/[id] Gaming tab). Every read is a
 *     read-only SELECT against the live prod game DB (the tables live only
 *     there; the local schema is stale).
 *   - Shell-first: this server component paints the hero + period/search
 *     controls instantly; the KPI strip, the log, and the charts each stream
 *     behind their own <Suspense> (matching loading.tsx).
 *   - Layout: below the 4 KPI tiles, a 2-col section — LEFT the round-by-round
 *     audit log (search + paginated table), RIGHT two stacked charts (Usage =
 *     started rounds per hour; House P&L per hour). Stacks on mobile.
 *   - Active-Timeframe-Only: only the active `?period=` window loads; the
 *     lifetime window is bounded (365d) so no unbounded scan ships.
 *   - The KPI + charts <Suspense> key ONLY on period (they must NOT re-skeleton
 *     when the log paginates); the log <Suspense> keys on period|page|search.
 *   - The windowed aggregate + log ORDER BY created_at seq-scan today (no
 *     created_at index, tiny table) — both are cached + timeout-wrapped in the
 *     query module, and a CREATE INDEX CONCURRENTLY on (created_at) is flagged
 *     (NOT applied) in prisma/recommended-indexes.sql.
 *
 * The whole /insights tree is owner-gated by the layout (requireInsightsOwner);
 * this page additionally gates on its own page key.
 */
export default async function DoubleDownPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/insights/double-down");
  const sp = await searchParams;
  const period = parseDoubleDownPeriod(sp.period);
  const search = (sp.q ?? "").trim();
  const pageRaw = Number.parseInt(sp.page ?? "1", 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex flex-col gap-4">
          <PageHeroIdentity
            icon={Dices}
            accent="purple"
            title="Double Down"
            subtitle="Gamble-your-battle-winnings tracking — win/lose, total wager, and House-POV P&L over every started round."
          />
          <div className="flex flex-wrap items-center gap-3">
            <DoubleDownPeriodFilter />
            <span className="text-xs text-muted-foreground">
              {doubleDownPeriodLabel(period)}
            </span>
          </div>
        </div>
      </PageHero>

      {/* KPI strip (4 tiles) — keyed ONLY on period so it never re-skeletons
          when the log paginates or the search changes. */}
      <Suspense key={`kpi-${period}`} fallback={<KpiStripSkeleton count={5} />}>
        <DoubleDownStatsSection period={period} />
      </Suspense>

      {/* 2-col: LEFT the round-by-round audit log, RIGHT the two stacked
          charts. Stacks single-column on mobile, side-by-side at lg. */}
      <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
        {/* LEFT — audit log (search + paginated table). */}
        <section className="space-y-3">
          <SectionHeading icon={Dices} title="Audit log" />
          <DoubleDownSearchForm />
          {/* Server-driven pagination + search. Keyed on the full filter set so
              a new window / page / search re-suspends to the skeleton. */}
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

        {/* RIGHT — two stacked charts (Usage + House P&L over time). Keyed
            ONLY on period so paginating the log never re-suspends them. */}
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
