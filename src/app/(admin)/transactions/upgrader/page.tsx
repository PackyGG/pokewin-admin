import { Suspense } from "react";
import Link from "next/link";
import { ArrowUpCircle, AlertTriangle } from "lucide-react";
import { getUpgraderTransactions } from "@/lib/queries/upgrader-transactions";
import { requirePageAccess } from "@/lib/dal";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import { UpgraderTransactionsDataTable } from "./data-table";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { Skeleton } from "@/components/ui/skeleton";
import {
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";
import { cn } from "@/lib/utils";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { LinkPendingShell } from "@/components/ux";
import {
  SortByMultiplierButton,
  SortByWonAmountButton,
  ClearSortButton,
} from "./sort-buttons";

export const metadata = { title: "Upgrader Transactions" };

/**
 * Outcome tabs — derived from `upgrader_games.won_amount`:
 *   • all   — every game (wins + losses)
 *   • win   — won_amount > 0 (user took money out → house loss)
 *   • loss  — won_amount = 0 (player risked, house kept it all)
 *
 * Mirrors the status-tab UX of the sibling /transactions sub-pages but
 * uses outcome instead of ledger status because the upgrader_games
 * table doesn't carry a pending/completed/failed lifecycle — every
 * row is a settled game.
 */
const OUTCOME_TABS = [
  { value: "all", label: "All" },
  { value: "win", label: "Wins" },
  { value: "loss", label: "Losses" },
];

export default async function UpgraderTransactionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/transactions/upgrader");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;
  const tab = params.tab || "all";
  const sortBy = params.sortBy || "recent";

  // Suspense key — flips when any input changes so the table skeleton
  // re-shows on in-segment navigation instead of leaving stale rows on
  // screen during a slow refetch. Sort mode is part of the key so
  // clicking "Top multiplier" / "Top win $" replays the skeleton while
  // the re-ordered server query is in flight.
  const suspenseKey = `${tab}|${page}|${perPage}|${params.search ?? ""}|${sortBy}`;

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={ArrowUpCircle}
          title="Upgrader Transactions"
          subtitle="Every upgrader game — bet, payout, and house P&L."
        />
      </PageHero>

      <div className="space-y-4">
        <div className="-mx-1 overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div className="inline-flex gap-1 rounded-lg bg-muted p-1">
            {OUTCOME_TABS.map((t) => {
              // Carry the active sort through the outcome switch so
              // "Top multiplier" / "Top win $" stays active when the
              // admin pivots from All → Wins (the most common flow).
              // Pagination resets to page 1 — the sorted result set
              // shifts under the new filter and the previous offset
              // would otherwise land mid-data.
              const tabParams = new URLSearchParams();
              tabParams.set("tab", t.value);
              if (sortBy !== "recent") tabParams.set("sortBy", sortBy);
              if (params.search) tabParams.set("search", params.search);
              return (
                <Link
                  key={t.value}
                  href={`/transactions/upgrader?${tabParams.toString()}`}
                  // `prefetch={false}` is what keeps this Active-Tab-Only:
                  // without it Next prefetches the INACTIVE outcome tab's
                  // route segment on hover / viewport-enter, which runs
                  // getUpgraderTransactions for that tab BEFORE the admin
                  // ever clicks it — speculatively firing this heavy
                  // (unindexed game_sessions) query. With prefetch off the
                  // hidden tab's query only fires on the actual click, into
                  // its own <Suspense> boundary below. Mirrors the deposits
                  // tab switch in /transactions/deposits.
                  prefetch={false}
                  className={cn(
                    "shrink-0 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                    tab === t.value
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <LinkPendingShell spinnerSize={13}>{t.label}</LinkPendingShell>
                </Link>
              );
            })}
          </div>
        </div>
        {/* Sort buttons live in their OWN Suspense as a sibling of the
            toolbar — NOT as toolbar children — so the toolbar's loading
            skeleton (h-10) never blanks them and they stay mounted across
            a tab / search re-stream. Each button reads useSearchParams()
            so it still needs a boundary; an invisible fallback keeps the
            row from jumping while they hydrate. */}
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
          <div className="min-w-0 flex-1">
            <Suspense fallback={<Skeleton className="h-10 w-full" />}>
              <DataTableToolbar searchPlaceholder="Search by user ID, username, or game ID..." />
            </Suspense>
          </div>
          <Suspense fallback={null}>
            <div className="flex flex-wrap items-center gap-2">
              <SortByMultiplierButton />
              <SortByWonAmountButton />
              <ClearSortButton />
            </div>
          </Suspense>
        </div>
      </div>

      <div className="space-y-3">
        <SectionHeading icon={ArrowUpCircle} title="Upgrader plays" />
        <Suspense
          key={suspenseKey}
          fallback={
            <>
              <TableSkeleton rows={Math.min(perPage, 15)} columns={7} />
              <PaginationSkeleton />
            </>
          }
        >
          <UpgraderTxTableSection
            page={page}
            perPage={perPage}
            tab={tab}
            search={params.search}
            sortBy={sortBy}
          />
        </Suspense>
      </div>
    </div>
  );
}

async function UpgraderTxTableSection({
  page,
  perPage,
  tab,
  search,
  sortBy,
}: {
  page: number;
  perPage: number;
  tab: string;
  search: string | undefined;
  sortBy: string;
}) {
  // Empty shape getUpgraderTransactions returns for zero rows — the
  // safeQuery fallback, so the table + pagination still paint (degraded)
  // on failure instead of the whole segment crashing.
  const EMPTY_LIST: Awaited<ReturnType<typeof getUpgraderTransactions>> = {
    data: [],
    total: 0,
    page,
    perPage,
    totalPages: 0,
  };

  // safeQuery (house 15s wall-clock bound) degrades a failed/hung list
  // query to an empty table + a VISIBLE amber band — hero, tabs, toolbar
  // and pagination keep rendering so the admin can clear filters or retry.
  // This is the guard that turns the old infinite spinner (the upgrader
  // list query running against the unindexed game_sessions table) into a
  // bounded degrade. Identical to the bare await on the happy path, and
  // mirrors how /transactions/deposits wraps its list query.
  const listResult = await safeQuery(
    () =>
      getUpgraderTransactions({
        page,
        perPage,
        search,
        outcome: tab,
        sortBy,
      }),
    EMPTY_LIST,
    "transactions.upgrader.list",
    REWARD_QUERY_TIMEOUT_MS,
  );
  const result = listResult.data;
  const listFailed = listResult.error !== null;

  return (
    <>
      {listFailed && (
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
            Couldn&apos;t load upgrader plays — the query timed out or failed.
            This is a{" "}
            <span className="font-medium">query error, not zero results</span>.
            Refresh to retry, or clear the search and outcome filter.
          </p>
        </div>
      )}
      <FadeIn>
        <UpgraderTransactionsDataTable data={result.data} />
      </FadeIn>
      <DataTablePagination
        page={result.page}
        totalPages={result.totalPages}
        total={result.total}
        perPage={result.perPage}
        degraded={listFailed}
      />
    </>
  );
}
