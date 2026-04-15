import { Suspense } from "react";
import Link from "next/link";
import { getBattles } from "@/lib/queries/battles";
import { requirePageAccess } from "@/lib/dal";
import { BattlesDataTable } from "./data-table";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export const metadata = { title: "Battles" };

const STATUS_TABS = [
  { value: "all", label: "All" },
  { value: "waiting", label: "Waiting" },
  { value: "in_progress", label: "In Progress" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
];

export default async function BattlesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/battles");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;
  const tab = params.tab || "all";

  const result = await getBattles({
    page,
    perPage,
    status: tab === "all" ? undefined : tab,
    mode: params.mode,
    search: params.search,
  });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Battles</h1>
      <div className="flex gap-1 rounded-lg bg-muted p-1">
        {STATUS_TABS.map((t) => (
          <Link
            key={t.value}
            href={`/battles?tab=${t.value}`}
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
          searchPlaceholder="Search by battle ID or username..."
          filters={[
            {
              name: "Mode",
              paramKey: "mode",
              options: [
                { label: "Normal", value: "normal" },
                { label: "Jackpot", value: "jackpot" },
                { label: "Group", value: "group" },
                { label: "HP Rush", value: "hp_rush" },
                { label: "Lowest", value: "lowest" },
              ],
            },
          ]}
        />
      </Suspense>
      <BattlesDataTable data={result.data} />
      <DataTablePagination
        page={result.page}
        totalPages={result.totalPages}
        total={result.total}
        perPage={result.perPage}
      />
    </div>
  );
}
