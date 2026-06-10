import { Suspense } from "react";
import Link from "next/link";
import { Trophy } from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import {
  getRaceLeaderboard,
  getRaceLeaderboardPeriods,
  getRacePrizeTiers,
  getRaceClaims,
  getRacePeriodsOverview,
} from "@/lib/queries/races";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import {
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";
import { cn } from "@/lib/utils";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { PeriodSelect } from "./period-select";
import { RaceTiersTable } from "./race-tiers-table";
import { StandingsTable } from "./standings-table";
import { HistoryTable } from "./history-table";
import { PeriodsTable } from "./periods-table";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { LinkPending } from "@/components/ux";

export const metadata = { title: "Leaderboards" };

// Leaderboards is the single entry point for everything race-related now
// that /rewards/races is gone:
//   - Standings:  current wager standings per period (daily/weekly/monthly)
//   - Prize Tiers: admin-editable prize amounts per position and race type
//   - History:    historical claims (who won what, when)
//   - Periods:    race_periods management — start/end/auto-renew toggle.
//                 Monthly only ever runs after admin starts a period here.
const TABS = [
  { value: "standings", label: "Standings" },
  { value: "tiers", label: "Prize Tiers" },
  { value: "history", label: "History" },
  { value: "periods", label: "Periods" },
] as const;

type TabValue = (typeof TABS)[number]["value"];

const RACE_TYPE_FILTERS = ["all", "monthly", "weekly", "daily"] as const;

export default async function LeaderboardsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/rewards/leaderboards");
  const params = await searchParams;
  const tab: TabValue = (
    TABS.find((t) => t.value === params.tab) ?? TABS[0]
  ).value;

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Trophy}
          title="Leaderboards"
          subtitle="Wager standings, prize tiers, race periods, and historical claims."
        />
      </PageHero>

      <div className="space-y-4">
        <div className="flex flex-wrap gap-1 rounded-lg bg-muted p-1 w-fit">
          {TABS.map((t) => (
            <Link
              key={t.value}
              href={`/rewards/leaderboards?tab=${t.value}`}
              className={cn(
                "inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                tab === t.value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {t.label}
              <LinkPending size={13} />
            </Link>
          ))}
        </div>

        {tab === "standings" && (
          <Suspense
            key={`standings|${params.raceType ?? ""}|${params.periodStart ?? ""}|${params.page ?? ""}|${params.perPage ?? ""}|${params.search ?? ""}`}
            fallback={
              <div className="space-y-4">
                <TableSkeleton rows={10} columns={3} />
                <PaginationSkeleton />
              </div>
            }
          >
            <StandingsTab params={params} />
          </Suspense>
        )}
        {tab === "tiers" && (
          <Suspense fallback={<TableSkeleton rows={6} columns={4} />}>
            <TiersTab />
          </Suspense>
        )}
        {tab === "history" && (
          <Suspense
            key={`history|${params.raceType ?? ""}|${params.page ?? ""}|${params.perPage ?? ""}`}
            fallback={
              <div className="space-y-4">
                <TableSkeleton rows={10} columns={6} />
                <PaginationSkeleton />
              </div>
            }
          >
            <HistoryTab params={params} />
          </Suspense>
        )}
        {tab === "periods" && (
          <Suspense fallback={<TableSkeleton rows={4} columns={6} />}>
            <PeriodsTab />
          </Suspense>
        )}
      </div>
    </div>
  );
}

async function StandingsTab({
  params,
}: {
  params: Record<string, string | undefined>;
}) {
  const raceType = params.raceType || "all";
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;
  const search = params.search;

  // The selectable leaderboards come straight from the DB (the periods that
  // actually have snapshot rows for this race type) — no calendar guessing.
  // The effective period is the one in the URL when it's a real leaderboard,
  // otherwise the most recent one that exists.
  const periods =
    raceType === "all"
      ? []
      : await getRaceLeaderboardPeriods({ raceType });
  const effectivePeriod =
    raceType === "all"
      ? undefined
      : params.periodStart &&
          periods.some((p) => p.periodStart === params.periodStart)
        ? params.periodStart
        : periods[0]?.periodStart;
  const result = await getRaceLeaderboard({
    raceType,
    periodStart: effectivePeriod,
    search,
    page,
    perPage,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <div className="flex gap-1 rounded-lg bg-muted p-1">
          {RACE_TYPE_FILTERS.map((type) => (
            <Link
              key={type}
              // Don't carry periodStart across race types — periods differ per
              // type, so the target type defaults to its own latest leaderboard.
              href={`/rewards/leaderboards?tab=standings&raceType=${type}`}
              className={cn(
                "inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium transition-colors capitalize",
                raceType === type
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {type}
              <LinkPending size={13} />
            </Link>
          ))}
        </div>
        {raceType !== "all" && (
          <PeriodSelect
            raceType={raceType}
            periodStart={effectivePeriod}
            periods={periods}
          />
        )}
      </div>
      <Suspense>
        <DataTableToolbar searchPlaceholder="Search by username, email, or ID..." />
      </Suspense>
      <FadeIn>
        <StandingsTable
          data={result.data}
          raceType={raceType}
          periodStart={effectivePeriod}
        />
      </FadeIn>
      <DataTablePagination
        page={result.page}
        totalPages={result.totalPages}
        total={result.total}
        perPage={result.perPage}
      />
    </div>
  );
}

async function TiersTab() {
  const tiers = await getRacePrizeTiers();
  return (
    <FadeIn>
      <RaceTiersTable tiers={tiers} />
    </FadeIn>
  );
}

async function HistoryTab({
  params,
}: {
  params: Record<string, string | undefined>;
}) {
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;
  const raceType = params.raceType;
  const claims = await getRaceClaims({ page, perPage, raceType });

  return (
    <div className="space-y-4">
      <div className="flex gap-1 rounded-lg bg-muted p-1 w-fit">
        {RACE_TYPE_FILTERS.map((type) => (
          <Link
            key={type}
            href={`/rewards/leaderboards?tab=history&raceType=${type}`}
            className={cn(
              "inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium transition-colors capitalize",
              (raceType || "all") === type
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {type}
            <LinkPending size={13} />
          </Link>
        ))}
      </div>
      <FadeIn>
        <HistoryTable data={claims.data} />
      </FadeIn>
      <DataTablePagination
        page={claims.page}
        totalPages={claims.totalPages}
        total={claims.total}
        perPage={claims.perPage}
      />
    </div>
  );
}

async function PeriodsTab() {
  const { active, recent } = await getRacePeriodsOverview();
  return (
    <FadeIn>
      <PeriodsTable active={active} recent={recent} />
    </FadeIn>
  );
}
