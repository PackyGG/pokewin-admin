import { Suspense } from "react";
import Link from "next/link";
import {
  getRaceLeaderboard,
  getRaceLeaderboardPeriods,
  getRacePrizeTiers,
  getRaceClaims,
  getRacePeriodsOverview,
  getRaceStandingsClaimWindow,
} from "@/lib/queries/races";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import {
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";
import { cn } from "@/lib/utils";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { PeriodSelect } from "./leaderboards/period-select";
import { RaceTiersTable } from "./leaderboards/race-tiers-table";
import { StandingsTable } from "./leaderboards/standings-table";
import { RaceClaimExpiryBanner } from "./leaderboards/race-claim-expiry-banner";
import { HistoryTable } from "./leaderboards/history-table";
import { PeriodsTable } from "./leaderboards/periods-table";
import { FadeIn } from "@/components/fade-in";
import { LinkPending } from "@/components/ux";

/**
 * Leaderboards tab of the merged /rewards page (was the standalone
 * /rewards/leaderboards page). Single entry point for everything
 * race-related. Its OWN Standings|Tiers|History|Periods inner switch is
 * namespaced to `?lbtab=` so it never collides with the top-level `?tab=`.
 * Only the active inner sub-tab awaits its data.
 */
const LB_SUBTABS = [
  { value: "standings", label: "Standings" },
  { value: "tiers", label: "Prize Tiers" },
  { value: "history", label: "History" },
  { value: "periods", label: "Periods" },
] as const;

type LbSubTab = (typeof LB_SUBTABS)[number]["value"];

const RACE_TYPE_FILTERS = ["all", "monthly", "weekly", "daily"] as const;

export function LeaderboardsTab({
  params,
}: {
  params: Record<string, string | undefined>;
}) {
  const lbtab: LbSubTab = (
    LB_SUBTABS.find((t) => t.value === params.lbtab) ?? LB_SUBTABS[0]
  ).value;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1 rounded-lg bg-muted p-1 w-fit">
        {LB_SUBTABS.map((t) => (
          <Link
            key={t.value}
            href={`/rewards?tab=leaderboards&lbtab=${t.value}`}
            className={cn(
              "inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              lbtab === t.value
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
            <LinkPending size={13} />
          </Link>
        ))}
      </div>

      {lbtab === "standings" && (
        <Suspense
          key={`standings|${params.raceType ?? ""}|${params.periodStart ?? ""}|${params.page ?? ""}|${params.perPage ?? ""}|${params.search ?? ""}`}
          fallback={
            <div className="space-y-4">
              <TableSkeleton rows={10} columns={3} />
              <PaginationSkeleton />
            </div>
          }
        >
          <StandingsSubTab params={params} />
        </Suspense>
      )}
      {lbtab === "tiers" && (
        <Suspense fallback={<TableSkeleton rows={6} columns={4} />}>
          <TiersSubTab />
        </Suspense>
      )}
      {lbtab === "history" && (
        <Suspense
          key={`history|${params.raceType ?? ""}|${params.page ?? ""}|${params.perPage ?? ""}`}
          fallback={
            <div className="space-y-4">
              <TableSkeleton rows={10} columns={6} />
              <PaginationSkeleton />
            </div>
          }
        >
          <HistorySubTab params={params} />
        </Suspense>
      )}
      {lbtab === "periods" && (
        <Suspense fallback={<TableSkeleton rows={4} columns={6} />}>
          <PeriodsSubTab />
        </Suspense>
      )}
    </div>
  );
}

async function StandingsSubTab({
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
  const [result, claimWindow] = await Promise.all([
    getRaceLeaderboard({
      raceType,
      periodStart: effectivePeriod,
      search,
      page,
      perPage,
    }),
    raceType !== "all" && effectivePeriod
      ? getRaceStandingsClaimWindow({
          raceType,
          periodStart: effectivePeriod,
        })
      : Promise.resolve(null),
  ]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <div className="flex gap-1 rounded-lg bg-muted p-1">
          {RACE_TYPE_FILTERS.map((type) => (
            <Link
              key={type}
              // Don't carry periodStart across race types — periods differ per
              // type, so the target type defaults to its own latest leaderboard.
              href={`/rewards?tab=leaderboards&lbtab=standings&raceType=${type}`}
              className={cn(
                "inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium transition-colors capitalize",
                raceType === type
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
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
      {claimWindow && (
        <RaceClaimExpiryBanner window={claimWindow} raceType={raceType} />
      )}
      <FadeIn>
        <StandingsTable
          data={result.data}
          raceType={raceType}
          periodStart={effectivePeriod}
          claimWindow={claimWindow}
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

async function TiersSubTab() {
  const tiers = await getRacePrizeTiers();
  return (
    <FadeIn>
      <RaceTiersTable tiers={tiers} />
    </FadeIn>
  );
}

async function HistorySubTab({
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
            href={`/rewards?tab=leaderboards&lbtab=history&raceType=${type}`}
            className={cn(
              "inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium transition-colors capitalize",
              (raceType || "all") === type
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
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

async function PeriodsSubTab() {
  const { active, recent } = await getRacePeriodsOverview();
  return (
    <FadeIn>
      <PeriodsTable active={active} recent={recent} />
    </FadeIn>
  );
}
