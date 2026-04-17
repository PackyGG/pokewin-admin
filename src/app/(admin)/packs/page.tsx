import { Suspense } from "react";
import { Package } from "lucide-react";
import { getPacks } from "@/lib/queries/packs";
import { requirePageAccess } from "@/lib/dal";
import { PacksGrid } from "./packs-grid";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { Skeleton } from "@/components/ui/skeleton";
import { CreatePackButton } from "./create-pack-button";
import { PageHero } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";

export const metadata = { title: "Packs" };

export default async function PacksPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/packs");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;

  const result = await getPacks({
    page,
    perPage,
    search: params.search,
    active: params.active,
    sortBy: params.sortBy,
    sortOrder: params.sortOrder,
  });

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
              <Package className="size-5 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold leading-tight">Packs</h1>
              <p className="text-sm text-muted-foreground">
                Pack catalog — pricing, availability, and stats.
              </p>
            </div>
          </div>
          <CreatePackButton />
        </div>
      </PageHero>

      <div className="space-y-4">
        <Suspense fallback={<Skeleton className="h-10 w-full" />}>
          <DataTableToolbar
            searchPlaceholder="Search by name or slug..."
            filters={[
              {
                name: "Status",
                paramKey: "active",
                options: [
                  { label: "Active", value: "active" },
                  { label: "Inactive", value: "inactive" },
                ],
              },
            ]}
          />
        </Suspense>
        <FadeIn>
          <PacksGrid data={result.data} />
        </FadeIn>
        <DataTablePagination
          page={result.page}
          totalPages={result.totalPages}
          total={result.total}
          perPage={result.perPage}
        />
      </div>
    </div>
  );
}
