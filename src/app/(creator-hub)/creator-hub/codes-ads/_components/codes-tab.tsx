import { Suspense } from "react";
import { Code, CheckCircle2, XCircle } from "lucide-react";
import { getCodes, getCreatorsCodesListStats } from "@/lib/queries/creators";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { Skeleton } from "@/components/ui/skeleton";
import { SectionHeading, KpiTile } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { formatNumber } from "@/lib/utils/format";
import { HubCodesDataTable } from "./hub-codes-data-table";

export async function CodesTabContent({
  searchParams,
}: {
  searchParams: Record<string, string | undefined>;
}) {
  const page = Number(searchParams.page) || 1;
  const perPage = Number(searchParams.perPage) || 20;

  const [result, stats] = await Promise.all([
    getCodes({
      page,
      perPage,
      search: searchParams.search,
      sortBy: searchParams.sortBy,
      sortOrder: searchParams.sortOrder,
    }),
    getCreatorsCodesListStats(),
  ]);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <KpiTile
          label="Total Codes"
          value={formatNumber(stats.totalCodes)}
          icon={Code}
          accent="blue"
        />
        <KpiTile
          label="Active"
          value={formatNumber(stats.activeCount)}
          icon={CheckCircle2}
          accent="emerald"
        />
        <KpiTile
          label="Inactive"
          value={formatNumber(stats.inactiveCount)}
          icon={XCircle}
          accent="rose"
        />
      </div>

      <div className="space-y-3">
        <SectionHeading icon={Code} title="All Codes" />
        <FadeIn className="space-y-4">
          <Suspense fallback={<Skeleton className="h-10 w-full" />}>
            <DataTableToolbar searchPlaceholder="Search by code or username..." />
          </Suspense>
          <HubCodesDataTable data={result.data} />
          <DataTablePagination
            page={result.page}
            totalPages={result.totalPages}
            total={result.total}
            perPage={result.perPage}
          />
        </FadeIn>
      </div>
    </div>
  );
}
