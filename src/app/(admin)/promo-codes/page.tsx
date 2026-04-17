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
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
              <Ticket className="size-5 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold leading-tight">Promo Codes</h1>
              <p className="text-sm text-muted-foreground">
                Manage promotional codes — track usage, restrictions, and expirations.
              </p>
            </div>
          </div>
          <CreatePromoCodeButton />
        </div>
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
