import { Suspense } from "react";
import Link from "next/link";
import { Package } from "lucide-react";
import {
  getTransactions,
  type TransactionSortMode,
} from "@/lib/queries/transactions";
import { requirePageAccess } from "@/lib/dal";
import { TransactionsDataTable } from "../data-table";
import { columns as packColumns } from "./columns";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { PageHero } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";

export const metadata = { title: "Pack Transactions" };

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

export default async function PackTransactionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/transactions/packs");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;
  const tab = params.tab || "all";
  const rawSort = params.sortBy;
  const sortBy: TransactionSortMode = (
    rawSort && (SORT_MODES as string[]).includes(rawSort) ? rawSort : "recent"
  ) as TransactionSortMode;

  const result = await getTransactions({
    page,
    perPage,
    search: params.search,
    types: TYPES,
    status: tab === "all" ? undefined : tab,
    sortBy,
  });

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
            <Package className="size-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold leading-tight">Pack Transactions</h1>
            <p className="text-sm text-muted-foreground">
              Pack opening transactions — filter by status or search.
            </p>
          </div>
        </div>
      </PageHero>

      <div className="space-y-4">
        <div className="flex gap-1 rounded-lg bg-muted p-1">
          {STATUS_TABS.map((t) => (
            <Link
              key={t.value}
              href={`/transactions/packs?tab=${t.value}`}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                tab === t.value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {t.label}
            </Link>
          ))}
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
        <FadeIn>
          <TransactionsDataTable data={result.data} columns={packColumns} />
        </FadeIn>
        <DataTablePagination
          page={result.page}
          totalPages={result.totalPages}
          total={result.total}
          perPage={result.perPage}
        />
      </div>
    </div>
  );
}
