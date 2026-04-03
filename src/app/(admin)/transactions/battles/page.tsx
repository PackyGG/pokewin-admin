import { Suspense } from "react";
import Link from "next/link";
import { getTransactions } from "@/lib/queries/transactions";
import { requirePageAccess } from "@/lib/dal";
import { TransactionsDataTable } from "../data-table";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const STATUS_TABS = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
];

const TYPES = ["battle_bet", "battle_sponsorship", "battle_refund", "battle_excess_to_voucher"];

export default async function BattleTransactionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/transactions/battles");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;
  const tab = params.tab || "all";

  const result = await getTransactions({
    page,
    perPage,
    search: params.search,
    types: TYPES,
    status: tab === "all" ? undefined : tab,
  });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Battle Transactions</h1>
      <div className="flex gap-1 rounded-lg bg-muted p-1">
        {STATUS_TABS.map((t) => (
          <Link
            key={t.value}
            href={`/transactions/battles?tab=${t.value}`}
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
        />
      </Suspense>
      <TransactionsDataTable data={result.data} />
      <DataTablePagination
        page={result.page}
        totalPages={result.totalPages}
        total={result.total}
        perPage={result.perPage}
      />
    </div>
  );
}
