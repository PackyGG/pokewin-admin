import { Suspense } from "react";
import Link from "next/link";
import { LayoutGrid, Gift, Users } from "lucide-react";
import { ExportButton } from "@/components/export-button";
import { cn } from "@/lib/utils";
import {
  KpiStripSkeleton,
  ChartSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import { fromInsightsPeriod } from "./types";
import { RewardsOverviewView } from "./rewards/overview-view";
import { RewardsProgramsView } from "./rewards/programs-view";
import { RewardsPlayersView } from "./rewards/players-view";

/**
 * Analytics → Rewards.
 *
 * REBUILT 2026-07-23 (owner: "rewards page is ok but not clean — we only have
 * deposit bonus, rakeback, daily packs, lossback, leaderboards, races and
 * tips / sponsorships for creators").
 *
 * What was wrong:
 *   • TEN sub-tabs — Overview, Daily Packs, Categories, ROI, Retention,
 *     Stacking, Cohort, Top spenders, Forecast, Geo — most of them the same
 *     over-engineering already deleted from the outer tab bar (Cohorts,
 *     Funnel, LTV, Retention) for never being used.
 *   • The spend was bucketed by LEDGER PLUMBING ("Bonuses & Promos",
 *     "Rain / Race Prizes", "House Credits / Vouchers"), not by the programs
 *     the business actually runs — so no line on the page matched anything
 *     an operator could turn off, tune, or budget.
 *   • Lossback and creator tips/sponsorships had no line at all; leaderboards
 *     were buried inside "Affiliate Commissions"; the top-spender ranking
 *     never even scanned the leaderboard prizes, which are the single largest
 *     payout type.
 *
 * What it is now — three views, each answering one question:
 *   Overview  — what did rewards cost, which program moved, how do they rank
 *   Programs  — one program in depth: trend, composition, sub-breakdown
 *   Players   — who receives it, and whether their play covered it
 *
 * `?rw=` picks the view, namespaced so the outer tab bar and this one don't
 * fight over one key. `?p=` picks the program on the Programs view. Only the
 * ACTIVE view renders, so nothing else touches the DB.
 *
 * PERIOD: reads the page-level `?period=` (translated by `toInsightsPeriod`)
 * — one timespan control for the whole page.
 */

const VIEWS = [
  { value: "overview", label: "Overview", icon: LayoutGrid },
  { value: "programs", label: "Programs", icon: Gift },
  { value: "players", label: "Players", icon: Users },
] as const;

type RewardsView = (typeof VIEWS)[number]["value"];

function parseView(value: string | undefined): RewardsView {
  return (VIEWS.map((v) => v.value) as readonly string[]).includes(value ?? "")
    ? (value as RewardsView)
    : "overview";
}

export function RewardsTab({
  period,
  sub,
  program,
}: {
  period: InsightsRewardsPeriod;
  sub: string | undefined;
  program: string | undefined;
}) {
  const view = parseView(sub);
  const periodParam = fromInsightsPeriod(period);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* Plain links, not a client component: every view is a server
            segment and the whole tab re-renders on `?rw=` anyway. */}
        <div className="flex gap-1 overflow-x-auto overscroll-x-contain rounded-lg border bg-muted/50 p-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {VIEWS.map(({ value, label, icon: Icon }) => (
            <Link
              key={value}
              href={`/analytics?tab=rewards&rw=${value}&period=${periodParam}`}
              replace
              scroll={false}
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
        <ExportButton page="rewards" params={{ period }} />
      </div>

      {/* Keyed on (view, period, program) so flipping any of them shows the
          skeleton instead of stalling on stale numbers. */}
      <Suspense
        key={`${view}:${period}:${program ?? ""}`}
        fallback={<ViewSkeleton view={view} />}
      >
        {view === "overview" && <RewardsOverviewView period={period} />}
        {view === "programs" && (
          <RewardsProgramsView period={period} selected={program} />
        )}
        {view === "players" && <RewardsPlayersView period={period} />}
      </Suspense>
    </div>
  );
}

function ViewSkeleton({ view }: { view: RewardsView }) {
  if (view === "players") {
    return (
      <div className="space-y-6">
        <KpiStripSkeleton count={4} />
        <TableSkeleton rows={10} />
      </div>
    );
  }
  if (view === "programs") {
    return (
      <div className="space-y-5">
        <KpiStripSkeleton count={5} />
        <ChartSkeleton height={240} />
      </div>
    );
  }
  return (
    <div className="space-y-6">
      <KpiStripSkeleton count={6} />
      <ChartSkeleton height={300} />
      <KpiStripSkeleton count={4} />
    </div>
  );
}
