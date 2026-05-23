import { Suspense } from "react";
import { Ticket, CheckCircle2, Clock, Users } from "lucide-react";
import { getPromoCodes } from "@/lib/queries/promo-codes";
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

  const result = await getPromoCodes({
    page,
    perPage,
    region: params.region,
    status: params.status,
  });

  const now = Date.now();
  const activeCount = result.data.filter(
    (c) => !c.expiresAt || new Date(c.expiresAt).getTime() > now,
  ).length;
  const expiredCount = result.data.length - activeCount;
  const totalRedemptions = result.data.reduce(
    (sum, c) => sum + c.redemptionCount,
    0,
  );

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
          value={String(result.total)}
          icon={Ticket}
          accent="blue"
        />
        <KpiTile
          label="Active (page)"
          value={String(activeCount)}
          icon={CheckCircle2}
          accent="emerald"
        />
        <KpiTile
          label="Expired (page)"
          value={String(expiredCount)}
          icon={Clock}
          accent="rose"
        />
        <KpiTile
          label="Redemptions (page)"
          value={String(totalRedemptions)}
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
