import { Suspense } from "react";
import { Code, CheckCircle2, XCircle } from "lucide-react";
import { getCodes, getCreatorsCodesListStats } from "@/lib/queries/creators";
import { requirePageAccess } from "@/lib/dal";
import { CodesDataTable } from "./data-table";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { Skeleton } from "@/components/ui/skeleton";
import {
  PageHero,
  PageHeroIdentity,
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

  // Stats stay stable across search / sort. The previous per-page
  // derivation was structurally wrong: every row's isActive is
  // hard-coded `true` in getCodes, so "Active (page)" always equalled
  // the page row count and "Inactive (page)" always read 0. The new
  // stats query checks affiliate_codes.code against the owning user's
  // currently-selected affiliate_code + affiliate_code_active flag,
  // which is the real truth.
  const [result, stats] = await Promise.all([
    getCodes({
      page,
      perPage,
      search: params.search,
      sortBy: params.sortBy,
      sortOrder: params.sortOrder,
    }),
    getCreatorsCodesListStats(),
  ]);

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Code}
          title="Affiliate Codes"
          subtitle="All affiliate codes across creators — status, ownership, performance."
        />
      </PageHero>

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
