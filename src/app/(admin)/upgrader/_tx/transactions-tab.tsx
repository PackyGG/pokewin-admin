import { Suspense } from "react";
import Link from "next/link";
import { ArrowUpCircle, AlertTriangle } from "lucide-react";
import { getUpgraderTransactions } from "@/lib/queries/upgrader-transactions";
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
import { SectionHeading } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { LinkPendingShell } from "@/components/ux";
import {
  SortByMultiplierButton,
  SortByWonAmountButton,
  ClearSortButton,
} from "./sort-buttons";

/**
 * Outcome sub-tabs — derived from `upgrader_games.won_amount`:
 *   • all   — every game (wins + losses)
 *   • win   — won_amount > 0 (user took money out → house loss)
 *   • loss  — won_amount = 0 (player risked, house kept it all)
 *
 * Uses an `outcome` query param (NOT `tab` — that's the OUTER
 * Catalog/Transactions selector). The outer `tab=transactions` is carried
 * through every outcome link so the sub-tab switch stays on this tab.
 */
const OUTCOME_TABS = [
  { value: "all", label: "All" },
  { value: "win", label: "Wins" },
  { value: "loss", label: "Losses" },
];

/**
 * "Transactions" tab content for the merged Upgrader surface (/upgrader).
 * Lifted verbatim from the former standalone /transactions/upgrader page body
 * (only the PageHero moved up to the shared page shell; the page already
 * enforced `requirePageAccess("/transactions/upgrader")` before mounting this).
 *
 * Mounted inside the page's `<Suspense>` so its (heavy, unindexed
 * game_sessions) reads only run when the Transactions tab is active
 * (Active-Tab-Only).
 */
export async function UpgraderTransactionsTab({
  searchParams,
}: {
  searchParams: Record<string, string | undefined>;
}) {
  const params = searchParams;
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;
  const outcome = params.outcome || "all";
  const sortBy = params.sortBy || "recent";

  // Suspense key — flips when any input changes so the table skeleton
  // re-shows on in-segment navigation instead of leaving stale rows on
  // screen during a slow refetch.
  const suspenseKey = `${outcome}|${page}|${perPage}|${params.search ?? ""}|${sortBy}`;

  function outcomeHref(value: string): string {
    // Carry the active sort through the outcome switch so "Top multiplier" /
    // "Top win $" stays active when the admin pivots from All → Wins.
    // Pagination resets to page 1 — the sorted result set shifts under the
    // new filter and the previous offset would otherwise land mid-data.
    const p = new URLSearchParams();
    p.set("tab", "transactions");
    if (value !== "all") p.set("outcome", value);
    if (sortBy !== "recent") p.set("sortBy", sortBy);
    if (params.search) p.set("search", params.search);
    return `/upgrader?${p.toString()}`;
  }

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div className="-mx-1 overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div className="inline-flex gap-1 rounded-lg border bg-muted/50 p-1">
            {OUTCOME_TABS.map((t) => (
              <Link
                key={t.value}
                href={outcomeHref(t.value)}
                // `prefetch={false}` is what keeps this Active-Tab-Only:
                // without it Next prefetches the INACTIVE outcome's route
                // segment on hover / viewport-enter, which runs
                // getUpgraderTransactions for that outcome BEFORE the admin
                // ever clicks it — speculatively firing this heavy
                // (unindexed game_sessions) query. With prefetch off the
                // hidden outcome's query only fires on the actual click.
                prefetch={false}
                className={cn(
                  "shrink-0 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  outcome === t.value
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <LinkPendingShell spinnerSize={13}>{t.label}</LinkPendingShell>
              </Link>
            ))}
          </div>
        </div>
        {/* Sort buttons live in their OWN Suspense as a sibling of the
            toolbar — NOT as toolbar children — so the toolbar's loading
            skeleton (h-10) never blanks them and they stay mounted across
            an outcome / search re-stream. Each button reads useSearchParams()
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
            outcome={outcome}
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
  outcome,
  search,
  sortBy,
}: {
  page: number;
  perPage: number;
  outcome: string;
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
  // query to an empty table + a VISIBLE amber band — tabs, toolbar
  // and pagination keep rendering so the admin can clear filters or retry.
  // This is the guard that turns the old infinite spinner (the upgrader
  // list query running against the unindexed game_sessions table) into a
  // bounded degrade.
  const listResult = await safeQuery(
    () =>
      getUpgraderTransactions({
        page,
        perPage,
        search,
        outcome,
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
