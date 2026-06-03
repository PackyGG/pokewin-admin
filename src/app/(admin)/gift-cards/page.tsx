import { Suspense } from "react";
import { Gift, CheckCircle2, XCircle, Coins } from "lucide-react";
import { getGiftCards, getGiftCardsListStats } from "@/lib/queries/gift-cards";
import { requirePageAccess } from "@/lib/dal";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { Skeleton } from "@/components/ui/skeleton";
import {
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";
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

  // Global stats stay stable across the status / region / search filter,
  // so the strip is a fixed read-out of the gift-card pool rather than a
  // window into the current 20-row slice. Awaited up-front; the table
  // itself streams in behind a keyed <Suspense> so a filter / search /
  // page change shows a table skeleton instead of blocking the page.
  const stats = await getGiftCardsListStats();

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
          value={String(stats.totalCards)}
          icon={Gift}
          accent="blue"
        />
        <KpiTile
          label="Available"
          value={String(stats.availableCount)}
          icon={CheckCircle2}
          accent="emerald"
        />
        <KpiTile
          label="Redeemed"
          value={String(stats.redeemedCount)}
          icon={XCircle}
          accent="purple"
        />
        <KpiTile
          label="Total Value"
          value={formatCurrency(stats.totalValueUsd)}
          icon={Coins}
          accent="amber"
        />
      </div>

      <div className="space-y-3">
        <SectionHeading icon={Gift} title="All Gift Cards" />
        <div className="space-y-4">
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

          {/* Keyed on the table inputs so a filter / search / page change
              re-shows the table skeleton instead of blocking on the
              previous render — matches the rain / rewards pattern. */}
          <Suspense
            key={`${params.status ?? ""}|${params.region ?? ""}|${params.search ?? ""}|${params.page ?? "1"}|${params.perPage ?? "20"}`}
            fallback={
              <>
                <TableSkeleton rows={12} columns={7} />
                <PaginationSkeleton />
              </>
            }
          >
            <GiftCardsListAsync params={params} />
          </Suspense>
        </div>
      </div>
    </div>
  );
}

async function GiftCardsListAsync({
  params,
}: {
  params: Record<string, string | undefined>;
}) {
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;

  const result = await getGiftCards({
    page,
    perPage,
    status: params.status,
    region: params.region,
    search: params.search,
  });

  return (
    <>
      <FadeIn>
        <GiftCardsContent data={result.data} />
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
