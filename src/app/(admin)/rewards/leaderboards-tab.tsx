import { Suspense } from "react";
import Link from "next/link";
import { AlertTriangle, ShieldAlert, Trophy as TrophyIcon } from "lucide-react";
import {
  getRaceLeaderboard,
  getRaceLeaderboardPeriods,
  getRacePrizeTiers,
  getRaceClaims,
  getRacePeriodsOverview,
  getRaceStandingsClaimWindow,
  getRaceMarkedPrizeExposure,
  getRaceTotalClaimed,
  type RaceLeaderboardPeriod,
} from "@/lib/queries/races";
import { safeQuery } from "@/lib/errors/safe-query";
import { formatCurrency } from "@/lib/utils/format";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import {
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";
import { cn } from "@/lib/utils";
import { parsePagination } from "@/lib/utils/pagination";
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
 * Inline "couldn't load" band — mirrors the amber notice the Challenges tab
 * renders when its safeQuery-wrapped read fails, so a slow / failing race read
 * degrades to a per-sub-tab notice instead of throwing to the /rewards route
 * error boundary.
 */
function LeaderboardsLoadErrorBand({ what }: { what: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3"
    >
      <AlertTriangle
        aria-hidden
        className="mt-0.5 size-4 shrink-0 text-amber-500"
      />
      <p className="text-xs text-amber-700 dark:text-amber-300">
        Couldn&apos;t load {what} — the query timed out or failed. This is a{" "}
        <span className="font-medium">request error, not zero results</span>.
        Refresh to retry.
      </p>
    </div>
  );
}

/**
 * Fraud-exposure pill shown by the standings toolbar: total prize currently
 * projected for players flagged "marked by admin" (on the excluded-users list)
 * who sit in a prize-winning position on this leaderboard. Amber — a
 * review/attention signal matching the on-hold + freeze affordances in the
 * table, not a House-POV P&L figure. Their claims can be frozen row-by-row.
 */
function MarkedPrizeExposure({
  total,
  count,
}: {
  total: number;
  count: number;
}) {
  return (
    <div
      title="Total prize currently projected for players flagged “marked by admin” (on the excluded-users list) who sit in a prize-winning position on this leaderboard. Freeze individual claims from the table below."
      className="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 text-sm"
    >
      <ShieldAlert aria-hidden className="size-4 shrink-0 text-amber-500" />
      <span className="whitespace-nowrap text-amber-700 dark:text-amber-300">
        Marked prize{" "}
        <span className="font-semibold tabular-nums">
          {formatCurrency(total)}
        </span>
        {count > 0 && (
          <span className="text-amber-600/70 dark:text-amber-400/70">
            {" · "}
            {count} flagged
          </span>
        )}
      </span>
    </div>
  );
}

/**
 * Total-claimed pill shown next to the marked-prize exposure pill: how much
 * prize money winners have ALREADY been paid for this leaderboard period.
 * Rose — house-POV (money paid out to users is a house cost), distinct from
 * the amber "at risk" signal of MarkedPrizeExposure.
 */
function TotalClaimedPill({ total, count }: { total: number; count: number }) {
  return (
    <div
      title="Total prize money already claimed by winners for this leaderboard period."
      className="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 text-sm"
    >
      <TrophyIcon aria-hidden className="size-4 shrink-0 text-rose-500" />
      <span className="whitespace-nowrap text-rose-700 dark:text-rose-300">
        Total claimed{" "}
        <span className="font-semibold tabular-nums">
          {formatCurrency(total)}
        </span>
        {count > 0 && (
          <span className="text-rose-600/70 dark:text-rose-400/70">
            {" · "}
            {count} claimed
          </span>
        )}
      </span>
    </div>
  );
}

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
  const { page, perPage } = parsePagination(params);
  const search = params.search;

  // The selectable leaderboards come straight from the DB (the periods that
  // actually have snapshot rows for this race type) — no calendar guessing.
  // safeQuery so a failing periods read degrades to an empty selector instead
  // of throwing the whole /rewards page into the route error boundary.
  const { data: periods } = await safeQuery(
    () =>
      raceType === "all"
        ? Promise.resolve<RaceLeaderboardPeriod[]>([])
        : getRaceLeaderboardPeriods({ raceType }),
    [] as RaceLeaderboardPeriod[],
    "races.leaderboardPeriods",
    15_000,
  );
  const effectivePeriod =
    raceType === "all"
      ? undefined
      : params.periodStart &&
          periods.some((p) => p.periodStart === params.periodStart)
        ? params.periodStart
        : periods[0]?.periodStart;
  // Is the selected period the currently-running race? A running monthly race
  // has no snapshot rows yet (they're generated when the period ends), so its
  // standings table is empty — flagged here so it renders an honest
  // "race in progress" state instead of the generic "no data".
  const isActivePeriod =
    periods.find((p) => p.periodStart === effectivePeriod)?.isActive ?? false;
  // Wrap the standings + claim-window reads (getRaceStandingsClaimWindow also
  // fans out to the reward-expiry backend API) so a slow / failing read shows
  // the inline amber band + empty table rather than nuking the page.
  const [
    { data: result, error: standingsError },
    { data: claimWindow },
    { data: markedExposure },
    { data: totalClaimed },
  ] = await Promise.all([
    safeQuery(
      () =>
        getRaceLeaderboard({
          raceType,
          periodStart: effectivePeriod,
          search,
          page,
          perPage,
        }),
      { data: [], total: 0, page, perPage, totalPages: 1 },
      "races.leaderboard",
      15_000,
    ),
    raceType !== "all" && effectivePeriod
      ? safeQuery(
          () =>
            getRaceStandingsClaimWindow({
              raceType,
              periodStart: effectivePeriod,
            }),
          null,
          "races.standingsClaimWindow",
          15_000,
        )
      : Promise.resolve({ data: null, error: null } as const),
    // Fraud-exposure counter: prize $ currently projected for marked-by-admin
    // players in a prize position. Independent of the page/search shown.
    // safeQuery so it degrades to no-pill instead of breaking the tab.
    raceType !== "all" && effectivePeriod
      ? safeQuery(
          () =>
            getRaceMarkedPrizeExposure({
              raceType,
              periodStart: effectivePeriod,
            }),
          null,
          "races.markedPrizeExposure",
          15_000,
        )
      : Promise.resolve({ data: null, error: null } as const),
    // Total prize $ already paid out for this period, shown next to the
    // marked-prize pill. safeQuery so a failing read degrades to no-pill
    // instead of breaking the tab.
    raceType !== "all" && effectivePeriod
      ? safeQuery(
          () =>
            getRaceTotalClaimed({
              raceType,
              periodStart: effectivePeriod,
            }),
          null,
          "races.totalClaimed",
          15_000,
        )
      : Promise.resolve({ data: null, error: null } as const),
  ]);
  const standingsFailed = standingsError !== null;

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
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
        <div className="min-w-0 sm:flex-1">
          <Suspense>
            <DataTableToolbar searchPlaceholder="Search by username, email, or ID..." />
          </Suspense>
        </div>
        {(markedExposure || totalClaimed) && (
          <div className="flex flex-wrap items-center gap-2">
            {markedExposure && (
              <MarkedPrizeExposure
                total={markedExposure.total}
                count={markedExposure.count}
              />
            )}
            {totalClaimed && (
              <TotalClaimedPill
                total={totalClaimed.total}
                count={totalClaimed.count}
              />
            )}
          </div>
        )}
      </div>
      {standingsFailed && <LeaderboardsLoadErrorBand what="standings" />}
      {claimWindow && (
        <RaceClaimExpiryBanner window={claimWindow} raceType={raceType} />
      )}
      <FadeIn>
        <StandingsTable
          data={result.data}
          raceType={raceType}
          periodStart={effectivePeriod}
          claimWindow={claimWindow}
          isActivePeriod={isActivePeriod}
        />
      </FadeIn>
      <DataTablePagination
        page={result.page}
        totalPages={result.totalPages}
        total={result.total}
        perPage={result.perPage}
        degraded={standingsFailed}
      />
    </div>
  );
}

async function TiersSubTab() {
  const { data: tiers, error } = await safeQuery(
    () => getRacePrizeTiers(),
    [] as Awaited<ReturnType<typeof getRacePrizeTiers>>,
    "races.prizeTiers",
    15_000,
  );
  if (error !== null) {
    return <LeaderboardsLoadErrorBand what="prize tiers" />;
  }
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
  const { page, perPage } = parsePagination(params);
  const raceType = params.raceType;
  const { data: claims, error } = await safeQuery(
    () => getRaceClaims({ page, perPage, raceType }),
    { data: [], total: 0, page, perPage, totalPages: 1 },
    "races.claims",
    15_000,
  );
  const failed = error !== null;

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
      {failed && <LeaderboardsLoadErrorBand what="race history" />}
      <FadeIn>
        <HistoryTable data={claims.data} />
      </FadeIn>
      <DataTablePagination
        page={claims.page}
        totalPages={claims.totalPages}
        total={claims.total}
        perPage={claims.perPage}
        degraded={failed}
      />
    </div>
  );
}

async function PeriodsSubTab() {
  const { data, error } = await safeQuery(
    () => getRacePeriodsOverview(),
    { active: [], recent: [] } as Awaited<
      ReturnType<typeof getRacePeriodsOverview>
    >,
    "races.periodsOverview",
    15_000,
  );
  if (error !== null) {
    return <LeaderboardsLoadErrorBand what="race periods" />;
  }
  return (
    <FadeIn>
      <PeriodsTable active={data.active} recent={data.recent} />
    </FadeIn>
  );
}
