import { Suspense } from "react";
import { getGiftCards } from "@/lib/queries/gift-cards";
import { requirePageAccess } from "@/lib/dal";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { Skeleton } from "@/components/ui/skeleton";
import { GiftCardsContent } from "./gift-cards-content";
import { CreateGiftCardDialog } from "./create-dialog";

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

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Gift Cards</h1>

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
        >
          <CreateGiftCardDialog />
        </DataTableToolbar>
      </Suspense>

      <GiftCardsContent data={result.data} />

      <DataTablePagination
        page={result.page}
        totalPages={result.totalPages}
        total={result.total}
        perPage={result.perPage}
      />
    </div>
  );
}
