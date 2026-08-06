import { Suspense } from "react";
import Link from "next/link";
import { AlertTriangle, Package } from "lucide-react";
import {
  getTransactions,
  type TransactionSortMode,
} from "@/lib/queries/transactions";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import { TransactionsDataTable } from "../../transactions/data-table";
import { columns as packColumns } from "./pack-tx-columns";
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

const STATUS_TABS = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
];

const TYPES = ["pack_opening"];
// Whitelist of accepted `sortBy` values so a bad URL falls through
// to recency-order rather than 500'ing in the query layer.
const SORT_MODES: TransactionSortMode[] = ["recent", "pack_multiplier"];

/**
 * "Transactions" tab content for the merged Packs surface (/packs).
 * Lifted verbatim from the former standalone /transactions/packs page body
 * (only the PageHero moved up to the shared page shell; the page already
 * enforced `requirePageAccess("/transactions/packs")` before mounting this).
 *
 * This is an async server segment mounted inside a `<Suspense>` so it only
 * runs its (heavy, ledger-joining) reads when the Transactions tab is active
 * (Active-Tab-Only).
 *
 * Status sub-tabs use a `status` query param (NOT `tab` — that's the OUTER
 * Catalog/Transactions selector). The outer `tab=transactions` is carried
 * through every status link so the sub-tab switch stays on this tab.
 */
export async function PackTransactionsTab({
  searchParams,
}: {
  searchParams: Record<string, string | undefined>;
}) {
  const params = searchParams;
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;
  const status = params.status || "all";
  const rawSort = params.sortBy;
  const sortBy: TransactionSortMode = (
    rawSort && (SORT_MODES as string[]).includes(rawSort) ? rawSort : "recent"
  ) as TransactionSortMode;

  // Suspense key — flips when any query input changes so the table
  // skeleton re-shows on in-segment navigation instead of leaving a
  // stale table on screen during a slow refetch.
  const suspenseKey = `${status}|${page}|${perPage}|${sortBy}|${params.search ?? ""}`;

  function statusHref(value: string): string {
    const p = new URLSearchParams();
    p.set("tab", "transactions");
    if (value !== "all") p.set("status", value);
    if (sortBy !== "recent") p.set("sortBy", sortBy);
    if (params.search) p.set("search", params.search);
    return `/packs?${p.toString()}`;
  }

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div className="-mx-1 overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div className="inline-flex gap-1 rounded-lg border bg-muted/50 p-1">
            {STATUS_TABS.map((t) => (
              <Link
                key={t.value}
                href={statusHref(t.value)}
                className={cn(
                  "shrink-0 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  status === t.value
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <LinkPendingShell spinnerSize={13}>{t.label}</LinkPendingShell>
              </Link>
            ))}
          </div>
        </div>
        <Suspense fallback={<Skeleton className="h-10 w-full" />}>
          <DataTableToolbar
            searchPlaceholder="Search by user ID, username, or transaction ID..."
            filters={[
              {
                // Sort dropdown — "Highest Multiplier" runs an SQL
                // CTE that ranks completed pack openings by
                // `payout / bet`. Surfaces the lucky $0.10 → $1k
                // pulls at the top.
                name: "Sort",
                paramKey: "sortBy",
                allLabel: "Recent",
                options: [
                  { label: "Recent", value: "recent" },
                  {
                    label: "Highest Multiplier",
                    value: "pack_multiplier",
                  },
                ],
              },
            ]}
          />
        </Suspense>
      </div>

      <div className="space-y-3">
        <SectionHeading icon={Package} title="Pack openings" />
        {/* getTransactions joins ledger_transactions to game_sessions /
            provably_fair_results / user_inventory to compute the
            payout + multiplier columns — heavy enough to block the
            tab render on its own. Streamed inside Suspense so the
            tabs + toolbar flush immediately. */}
        <Suspense
          key={suspenseKey}
          fallback={
            <>
              <TableSkeleton rows={Math.min(perPage, 15)} columns={6} />
              <PaginationSkeleton />
            </>
          }
        >
          <PackTxTableSection
            page={page}
            perPage={perPage}
            status={status}
            sortBy={sortBy}
            search={params.search}
          />
        </Suspense>
      </div>
    </div>
  );
}

async function PackTxTableSection({
  page,
  perPage,
  status,
  sortBy,
  search,
}: {
  page: number;
  perPage: number;
  status: string;
  sortBy: TransactionSortMode;
  search: string | undefined;
}) {
  // Empty shape getTransactions returns for zero rows — the safeQuery
  // fallback, so the table + pagination still paint (degraded) on failure.
  const EMPTY_LIST: Awaited<ReturnType<typeof getTransactions>> = {
    data: [],
    total: 0,
    page,
    perPage,
    totalPages: 0,
  };

  // safeQuery (house 15s wall-clock bound) degrades a failed/hung list
  // query to an empty table + a VISIBLE amber band — tabs, toolbar
  // and pagination keep rendering so the admin can clear filters or retry.
  // Identical to the bare await on the happy path.
  const listResult = await safeQuery(
    () =>
      getTransactions({
        page,
        perPage,
        search,
        types: TYPES,
        status: status === "all" ? undefined : status,
        sortBy,
      }),
    EMPTY_LIST,
    "transactions.packs.list",
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
            Couldn&apos;t load pack transactions — the query timed out or
            failed. This is a{" "}
            <span className="font-medium">query error, not zero results</span>
            . Refresh to retry, or clear the search and sort.
          </p>
        </div>
      )}
      <FadeIn>
        <TransactionsDataTable data={result.data} columns={packColumns} />
      </FadeIn>
      <FadeIn speed="fast">
        <DataTablePagination
          page={result.page}
          totalPages={result.totalPages}
          total={result.total}
          perPage={result.perPage}
          degraded={listFailed}
        />
      </FadeIn>
    </>
  );
}
