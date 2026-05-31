import { Suspense } from "react";
import { Ticket, CheckCircle2, Clock, Users } from "lucide-react";
import { getPromoCodes, getPromoCodesListStats } from "@/lib/queries/promo-codes";
import { requirePageAccess } from "@/lib/dal";
import { PromoCodesDataTable } from "./data-table";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { Skeleton } from "@/components/ui/skeleton";
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
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;

  // Stats stay stable across the region / status filter — admins get
  // a fixed read-out of the promo-code pool while they refine the
  // table on screen.
  const [result, stats] = await Promise.all([
    getPromoCodes({
      page,
      perPage,
      region: params.region,
      status: params.status,
    }),
    getPromoCodesListStats(),
  ]);

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
        <FadeIn className="space-y-4">
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
          <PromoCodesDataTable data={result.data} />
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
