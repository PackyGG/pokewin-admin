import { Suspense } from "react";
import Link from "next/link";
import { getWithdrawals } from "@/lib/queries/withdrawals";
import { requirePageAccess } from "@/lib/dal";
import { WithdrawalsDataTable } from "./data-table";
import {
  requestColumns,
  shippingRequestColumns,
  finishedColumns,
  activeShipmentColumns,
} from "./columns";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { ValueRangeFilter } from "./value-range-filter";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const TABS = [
  {
    value: "all",
    label: "All",
    statuses: [] as string[],
    columns: finishedColumns,
  },
  {
    value: "requests",
    label: "Withdrawal Requests",
    statuses: ["pending", "processing"],
    columns: requestColumns,
  },
  {
    value: "shipping",
    label: "Shipping Requests",
    statuses: ["pending"],
    method: "physical" as const,
    columns: shippingRequestColumns,
  },
  {
    value: "active-shipments",
    label: "Active Shipments",
    statuses: ["processing", "shipped"],
    method: "physical" as const,
    columns: activeShipmentColumns,
  },
  {
    value: "finished",
    label: "Finished",
    statuses: ["completed", "cancelled", "failed"],
    columns: finishedColumns,
  },
];

export default async function WithdrawalsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/withdrawals");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;
  const tabValue = params.tab || "requests";

  const activeTab = TABS.find((t) => t.value === tabValue) ?? TABS[0];

  const minValue = params.minValue ? Number(params.minValue) : undefined;
  const maxValue = params.maxValue ? Number(params.maxValue) : undefined;

  const hasHardcodedMethod = "method" in activeTab;
  const method = hasHardcodedMethod
    ? activeTab.method
    : (params.method as "physical" | "crypto" | undefined);

  const result = await getWithdrawals({
    page,
    perPage,
    statuses: activeTab.statuses,
    method,
    search: params.search,
    minValue: minValue && !isNaN(minValue) ? minValue : undefined,
    maxValue: maxValue && !isNaN(maxValue) ? maxValue : undefined,
  });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Withdrawals</h1>
      <div className="flex gap-1 rounded-lg bg-muted p-1">
        {TABS.map((t) => (
          <Link
            key={t.value}
            href={`/withdrawals?tab=${t.value}`}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              tabValue === t.value
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
          searchPlaceholder="Search by ID or username..."
          filters={
            !hasHardcodedMethod
              ? [
                  {
                    name: "Method",
                    paramKey: "method",
                    options: [
                      { label: "Physical", value: "physical" },
                      { label: "Crypto", value: "crypto" },
                    ],
                  },
                ]
              : undefined
          }
        >
          <ValueRangeFilter />
        </DataTableToolbar>
      </Suspense>
      <WithdrawalsDataTable columns={activeTab.columns} data={result.data} />
      <DataTablePagination
        page={result.page}
        totalPages={result.totalPages}
        total={result.total}
        perPage={result.perPage}
      />
    </div>
  );
}
