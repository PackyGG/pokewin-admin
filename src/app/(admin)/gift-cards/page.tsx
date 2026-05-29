import { Suspense } from "react";
import { Gift, CheckCircle2, XCircle, Coins } from "lucide-react";
import { getGiftCards } from "@/lib/queries/gift-cards";
import { requirePageAccess } from "@/lib/dal";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { Skeleton } from "@/components/ui/skeleton";
import { GiftCardsContent } from "./gift-cards-content";
import { CreateGiftCardDialog } from "./create-dialog";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
  KpiTile,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { formatCurrency } from "@/lib/utils/format";

export const metadata = { title: "Gift Cards" };

export default async function GiftCardsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/gift-cards");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;

  const result = await getGiftCards({
    page,
    perPage,
    status: params.status,
    region: params.region,
    search: params.search,
  });

  const availableCount = result.data.filter((c) => c.status === "available").length;
  const redeemedCount = result.data.filter((c) => c.status === "redeemed").length;
  const pageValue = result.data.reduce((sum, c) => sum + c.value, 0);

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Gift}
          title="Gift Cards"
          subtitle="Manage and issue gift card codes with regional and value controls."
          action={<CreateGiftCardDialog />}
        />
      </PageHero>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiTile
          label="Total"
          value={String(result.total)}
          icon={Gift}
          accent="blue"
        />
        <KpiTile
          label="Available (page)"
          value={String(availableCount)}
          icon={CheckCircle2}
          accent="emerald"
        />
        <KpiTile
          label="Redeemed (page)"
          value={String(redeemedCount)}
          icon={XCircle}
          accent="purple"
        />
        <KpiTile
          label="Page Value"
          value={formatCurrency(pageValue)}
          icon={Coins}
          accent="amber"
        />
      </div>

      <div className="space-y-3">
        <SectionHeading icon={Gift} title="All Gift Cards" />
        <FadeIn className="space-y-4">
          <Suspense fallback={<Skeleton className="h-10 w-full" />}>
            <DataTableToolbar
              searchPlaceholder="Search by code..."
              filters={[
                {
                  name: "Status",
                  paramKey: "status",
                  options: [
                    { label: "Available", value: "available" },
                    { label: "Redeemed", value: "redeemed" },
                    { label: "Cancelled", value: "cancelled" },
                    { label: "Expired", value: "expired" },
                  ],
                },
              ]}
            />
          </Suspense>

          <GiftCardsContent data={result.data} />

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
