import { Suspense } from "react";
import { Code, CheckCircle2, XCircle } from "lucide-react";
import { getCodes } from "@/lib/queries/creators";
import { requirePageAccess } from "@/lib/dal";
import { CodesDataTable } from "./data-table";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { Skeleton } from "@/components/ui/skeleton";
import {
  PageHero,
  SectionHeading,
  KpiTile,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { formatNumber } from "@/lib/utils/format";

export const metadata = { title: "Creator Codes" };

export default async function CodesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/creators/codes");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;

  const result = await getCodes({
    page,
    perPage,
    search: params.search,
    sortBy: params.sortBy,
    sortOrder: params.sortOrder,
  });

  const activeCount = result.data.filter((c) => c.isActive).length;
  const inactiveCount = result.data.length - activeCount;

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
            <Code className="size-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold leading-tight">Affiliate Codes</h1>
            <p className="text-sm text-muted-foreground">
              All affiliate codes across creators — status, ownership, performance.
            </p>
          </div>
        </div>
      </PageHero>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <KpiTile
          label="Total Codes"
          value={formatNumber(result.total)}
          icon={Code}
          accent="blue"
        />
        <KpiTile
          label="Active (page)"
          value={formatNumber(activeCount)}
          icon={CheckCircle2}
          accent="emerald"
        />
        <KpiTile
          label="Inactive (page)"
          value={formatNumber(inactiveCount)}
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
          <CodesDataTable data={result.data} />
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
