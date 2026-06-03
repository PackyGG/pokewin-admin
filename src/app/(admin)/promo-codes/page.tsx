import { Suspense } from "react";
import { Ticket, CheckCircle2, Clock, Users } from "lucide-react";
import { getPromoCodes, getPromoCodesListStats } from "@/lib/queries/promo-codes";
import { requirePageAccess } from "@/lib/dal";
import { PromoCodesDataTable } from "./data-table";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { Skeleton } from "@/components/ui/skeleton";
import {
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";
import { CreatePromoCodeButton } from "./create-button";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
  KpiTile,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";

export const metadata = { title: "Promo Codes" };

export default async function PromoCodesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/promo-codes");
  const params = await searchParams;

  // Stats stay stable across the region / status filter — admins get a
  // fixed read-out of the promo-code pool while they refine the table on
  // screen. Awaited up-front; the table streams in behind a keyed
  // <Suspense> so a filter / page change shows a table skeleton instead
  // of blocking the page on the previous render.
  const stats = await getPromoCodesListStats();

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Ticket}
          title="Promo Codes"
          subtitle="Manage promotional codes — track usage, restrictions, and expirations."
          action={<CreatePromoCodeButton />}
        />
      </PageHero>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiTile
          label="Total Codes"
          value={String(stats.totalCodes)}
          icon={Ticket}
          accent="blue"
        />
        <KpiTile
          label="Active"
          value={String(stats.activeCount)}
          icon={CheckCircle2}
          accent="emerald"
        />
        <KpiTile
          label="Expired"
          value={String(stats.expiredCount)}
          icon={Clock}
          accent="rose"
        />
        <KpiTile
          label="Redemptions"
          value={String(stats.totalRedemptions)}
          icon={Users}
          accent="purple"
        />
      </div>

      <div className="space-y-3">
        <SectionHeading icon={Ticket} title="All Codes" />
        <div className="space-y-4">
          <Suspense fallback={<Skeleton className="h-10 w-full" />}>
            <DataTableToolbar
              searchPlaceholder="Search promo codes..."
              filters={[
                {
                  name: "Status",
                  paramKey: "status",
                  options: [
                    { label: "Active", value: "active" },
                    { label: "Expired", value: "expired" },
                  ],
                },
              ]}
            />
          </Suspense>
          {/* Keyed on the table inputs so a filter / page change re-shows
              the table skeleton instead of blocking on the previous
              render — matches the rain / rewards pattern. */}
          <Suspense
            key={`${params.status ?? ""}|${params.region ?? ""}|${params.page ?? "1"}|${params.perPage ?? "20"}`}
            fallback={
              <>
                <TableSkeleton rows={12} columns={7} />
                <PaginationSkeleton />
              </>
            }
          >
            <PromoCodesListAsync params={params} />
          </Suspense>
        </div>
      </div>
    </div>
  );
}

async function PromoCodesListAsync({
  params,
}: {
  params: Record<string, string | undefined>;
}) {
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;

  const result = await getPromoCodes({
    page,
    perPage,
    region: params.region,
    status: params.status,
  });

  return (
    <>
      <FadeIn>
        <PromoCodesDataTable data={result.data} />
      </FadeIn>
      <DataTablePagination
        page={result.page}
        totalPages={result.totalPages}
        total={result.total}
        perPage={result.perPage}
      />
    </>
  );
}
