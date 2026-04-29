import { Suspense } from "react";
import { Package } from "lucide-react";
import { getPacks } from "@/lib/queries/packs";
import { requirePageAccess } from "@/lib/dal";
import { PacksGrid } from "./packs-grid";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { Skeleton } from "@/components/ui/skeleton";
import { PaginationSkeleton } from "@/components/loading-skeletons";
import { CreatePackButton } from "./create-pack-button";
import { PageHero } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";

export const metadata = { title: "Packs" };

/**
 * Streaming server component for the packs grid. The getPacks query
 * (joins pack_cards × cards plus a groupBy for total counts) runs
 * inside a Suspense boundary so the hero/toolbar can flush first.
 */
async function PacksContent({
  page,
  perPage,
  search,
  active,
  sortBy,
  sortOrder,
}: {
  page: number;
  perPage: number;
  search?: string;
  active?: string;
  sortBy?: string;
  sortOrder?: string;
}) {
  const result = await getPacks({
    page,
    perPage,
    search,
    active,
    sortBy,
    sortOrder,
  });

  return (
    <>
      <FadeIn>
        <PacksGrid data={result.data} />
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

export default async function PacksPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/packs");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;

  const suspenseKey = `${page}|${perPage}|${params.search ?? ""}|${params.active ?? ""}|${params.sortBy ?? ""}|${params.sortOrder ?? ""}`;

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
        <Suspense
          key={suspenseKey}
          fallback={
            <>
              <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
                {Array.from({ length: 18 }).map((_, i) => (
                  <Skeleton
                    key={i}
                    className="rounded-xl"
                    style={{ aspectRatio: "3/4" }}
                  />
                ))}
              </div>
              <PaginationSkeleton />
            </>
          }
        >
          <PacksContent
            page={page}
            perPage={perPage}
            search={params.search}
            active={params.active}
            sortBy={params.sortBy}
            sortOrder={params.sortOrder}
          />
        </Suspense>
      </div>
    </div>
  );
}
