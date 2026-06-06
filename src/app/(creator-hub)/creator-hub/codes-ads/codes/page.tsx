import { Suspense } from "react";
import { Code, CheckCircle2, XCircle } from "lucide-react";
import { getCodes, getCreatorsCodesListStats } from "@/lib/queries/creators";
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

import { requireCreatorHubPageAccess } from "../_lib/require-creator-hub-access";
import { CodesAdsTabBar } from "../_components/codes-ads-tab-bar";

export const metadata = { title: "Codes · Creator Hub" };

export default async function CreatorHubCodesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireCreatorHubPageAccess();
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;

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
          accent="pink"
          title="Affiliate Codes"
          subtitle="All affiliate codes across creators — status, ownership, performance."
        />
      </PageHero>

      <CodesAdsTabBar />

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
