import { Suspense } from "react";
import { Sparkles, Users, DollarSign, Wallet } from "lucide-react";
import { getCreators, searchNonCreatorUsers } from "@/lib/queries/creators";
import { requirePageAccess } from "@/lib/dal";
import { CreatorsDataTable } from "./data-table";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { Skeleton } from "@/components/ui/skeleton";
import { UserSearchResults } from "./user-search-results";
import {
  PageHero,
  SectionHeading,
  KpiTile,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { formatCurrency, formatNumber } from "@/lib/utils/format";

export const metadata = { title: "Creators" };

export default async function CreatorsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/creators");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;

  const [result, nonCreators] = await Promise.all([
    getCreators({
      page,
      perPage,
      search: params.search,
      sortBy: params.sortBy,
      sortOrder: params.sortOrder,
    }),
    params.search ? searchNonCreatorUsers(params.search) : Promise.resolve([]),
  ]);

  const pageReferred = result.data.reduce((sum, c) => sum + c.totalReferred, 0);
  const pageEarned = result.data.reduce((sum, c) => sum + c.totalEarnedUsd, 0);
  const pageAvailable = result.data.reduce((sum, c) => sum + c.availableUsd, 0);

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
            <Sparkles className="size-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold leading-tight">Creators</h1>
            <p className="text-sm text-muted-foreground">
              Affiliate partners with commission tracking, referrals, and payouts.
            </p>
          </div>
        </div>
      </PageHero>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiTile
          label="Total Creators"
          value={formatNumber(result.total)}
          icon={Sparkles}
          accent="purple"
        />
        <KpiTile
          label="Referred (page)"
          value={formatNumber(pageReferred)}
          icon={Users}
          accent="blue"
        />
        <KpiTile
          label="Earned (page)"
          value={formatCurrency(pageEarned)}
          icon={DollarSign}
          accent="emerald"
        />
        <KpiTile
          label="Available (page)"
          value={formatCurrency(pageAvailable)}
          icon={Wallet}
          accent="amber"
        />
      </div>

      <div className="space-y-3">
        <SectionHeading icon={Sparkles} title="All Creators" />
        <FadeIn className="space-y-4">
          <Suspense fallback={<Skeleton className="h-10 w-full" />}>
            <DataTableToolbar searchPlaceholder="Search by code or username..." />
          </Suspense>
          <CreatorsDataTable data={result.data} />
          <DataTablePagination
            page={result.page}
            totalPages={result.totalPages}
            total={result.total}
            perPage={result.perPage}
          />
          {nonCreators.length > 0 && <UserSearchResults users={nonCreators} />}
        </FadeIn>
      </div>
    </div>
  );
}
