import { Suspense } from "react";
import { getCards, getRarities, getSets } from "@/lib/queries/cards";
import { requirePageAccess } from "@/lib/dal";
import { CardsGrid } from "./cards-grid";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { Skeleton } from "@/components/ui/skeleton";
import { CreateCardButton } from "./create-card-button";
import { PriceFilter } from "./price-filter";
import { SetFilter } from "./set-filter";

export default async function CardsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/cards");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;

  const [result, rarities, sets] = await Promise.all([
    getCards({
      page,
      perPage,
      search: params.search,
      rarity: params.rarity,
      setId: params.setId,
      minPrice: params.minPrice,
      maxPrice: params.maxPrice,
      sortBy: params.sortBy,
      sortOrder: params.sortOrder,
    }),
    getRarities(),
    getSets(),
  ]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Cards</h1>
        <CreateCardButton sets={sets} />
      </div>
      <Suspense fallback={<Skeleton className="h-10 w-full" />}>
        <DataTableToolbar
          searchPlaceholder="Search by name..."
          filters={[
            {
              name: "Rarity",
              paramKey: "rarity",
              options: rarities.filter((r): r is string => r != null).map((r) => ({ label: r, value: r })),
            },
          ]}
        >
          <SetFilter sets={sets} />
          <PriceFilter />
        </DataTableToolbar>
      </Suspense>
      <CardsGrid data={result.data} />
      <DataTablePagination
        page={result.page}
        totalPages={result.totalPages}
        total={result.total}
        perPage={result.perPage}
      />
    </div>
  );
}
