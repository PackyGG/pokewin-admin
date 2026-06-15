import { Suspense } from "react";
import { Coins } from "lucide-react";
import {
  getPacks,
  parsePackCategory,
  type PackListItem,
  type PackSetFilter,
  type PackCategoryFilter,
} from "@/lib/queries/packs";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { PaginationSkeleton } from "@/components/loading-skeletons";
import { PacksFilterBar } from "../packs-filter-bar";
import { PacksList } from "../packs-list";
import { PacksKpiStrip } from "../packs-kpi-strip";
import { PacksPageShell } from "../packs-page-shell";
import { SectionHeading } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import {
  resolveEntityView,
  type EntityView,
} from "@/components/entity-surface/view";
import {
  EntityTableSkeleton,
  EntityGridSkeleton,
  FilterBarSkeleton,
  InlineError,
} from "@/components/entity-surface";
import { parseListParams, boundaryKey } from "@/lib/entity-surface/loader";
import { loadPrimary } from "@/lib/entity-surface/loader";
import type { PaginatedResult } from "@/lib/types";
import { Skeleton } from "@/components/ui/skeleton";

const PACKS_SORT_FIELDS = [
  "created_at",
  "name",
  "price",
  "total_revenue",
  "total_payout",
  "total_openings",
  "actual_rtp",
  "actual_house_edge",
] as const;

const EMPTY_PACKS: PaginatedResult<PackListItem> = {
  data: [],
  total: 0,
  page: 1,
  perPage: 20,
  totalPages: 0,
};

/**
 * Streaming server component for the packs list. The active view (table /
 * gallery) is rendered server-side from `?view=` so there's no wrong-view
 * flash. The primary query is wrapped in `loadPrimary` (safeQuery + timeout)
 * so a slow/failed list degrades to an inline error in place — never a page
 * crash. ONLY the active view's data is fetched here; the inspector preview +
 * quick-edit fetch lazily from inside their own deferred overlays.
 */
async function PacksContent({
  page,
  perPage,
  search,
  active,
  tag,
  sortBy,
  sortOrder,
  set,
  view,
}: {
  page: number;
  perPage: number;
  search?: string;
  active?: string;
  tag?: PackCategoryFilter;
  sortBy?: string;
  sortOrder: "asc" | "desc";
  set: PackSetFilter;
  view: EntityView;
}) {
  const { data: result, error } = await loadPrimary(
    () =>
      getPacks({ page, perPage, search, active, tag, sortBy, sortOrder, set }),
    EMPTY_PACKS,
    "packs.list",
  );

  if (error) {
    return (
      <InlineError
        title="Couldn't load the pack catalog"
        hint="The list query timed out or failed. Retry, or narrow the filters."
      />
    );
  }

  return (
    <>
      <FadeIn>
        <PacksList data={result.data} view={view} />
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

/**
 * "Catalog" tab content for the merged Packs surface (/packs). Lifted verbatim
 * from the former standalone /packs page body (only the PageHero + create /
 * reprice actions moved up to the shared page shell, which owns them per-tab).
 *
 * Mounted inside the page's `<Suspense key={tab}>` so its catalog queries only
 * run when the Catalog tab is active (Active-Tab-Only). The permission flags
 * are resolved by the page (which already ran `requirePageAccess("/packs")`)
 * and threaded down so this segment never re-runs the gate.
 */
export function PacksCatalogTab({
  searchParams,
  canToggle,
  canDelete,
  canEdit,
  canEditLive,
  isPackCreator,
}: {
  searchParams: Record<string, string | undefined>;
  canToggle: boolean;
  canDelete: boolean;
  canEdit: boolean;
  canEditLive: boolean;
  isPackCreator: boolean;
}) {
  const params = searchParams;

  const { page, perPage, search, sortBy, sortOrder } = parseListParams(params, {
    defaultPerPage: 20,
    allowedSortFields: PACKS_SORT_FIELDS,
    defaultSortBy: "created_at",
    defaultSortOrder: "desc",
  });

  // Pokemon / OnePiece pool. Packs have no first-class type column — the
  // split is derived from the sets of the cards inside each pack (see
  // getPacks). `pokemon` is the default.
  const activeSet: PackSetFilter =
    params.set === "onepiece" ? "onepiece" : "pokemon";

  // Default to the dense triage TABLE; the gallery is one toggle away.
  const view = resolveEntityView(params.view);

  const activeFilter = readActiveFilter(params);

  // Category filter (1% / 5% / 10% tag, or daily/reward pack type) — read +
  // whitelisted server-side, then applied in getPacks. Unknown/garbage values
  // coerce to undefined (no filter).
  const categoryFilter = parsePackCategory(params.tag);

  const suspenseKey = boundaryKey([
    activeSet,
    view,
    page,
    perPage,
    search,
    activeFilter,
    categoryFilter,
    sortBy,
    sortOrder,
  ]);

  return (
    <PacksPageShell
      canToggle={canToggle}
      canDelete={canDelete}
      canEdit={canEdit}
      canEditLive={canEditLive}
      isPackCreator={isPackCreator}
    >
      <div className="space-y-6">
        <Suspense
          key={`kpi-${activeSet}`}
          fallback={
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-[68px] rounded-xl" />
              ))}
            </div>
          }
        >
          <PacksKpiStrip activeSet={activeSet} />
        </Suspense>

        <div className="space-y-3">
          <SectionHeading
            icon={Coins}
            title={
              activeSet === "onepiece" ? "OnePiece Catalog" : "Pokemon Catalog"
            }
          />
          <Suspense fallback={<FilterBarSkeleton filters={1} />}>
            <PacksFilterBar />
          </Suspense>
          <Suspense
            key={suspenseKey}
            fallback={
              <FadeIn>
                {view === "grid" ? (
                  <EntityGridSkeleton count={perPage} />
                ) : (
                  <EntityTableSkeleton
                    rows={Math.min(perPage, 12)}
                    columns={7}
                    selectable={false}
                  />
                )}
                <PaginationSkeleton />
              </FadeIn>
            }
          >
            <PacksContent
              page={page}
              perPage={perPage}
              search={search}
              active={activeFilter}
              tag={categoryFilter}
              sortBy={sortBy}
              sortOrder={sortOrder}
              set={activeSet}
              view={view}
            />
          </Suspense>
        </div>
      </div>
    </PacksPageShell>
  );
}

/** Read the (optional) status filter param, normalized away from "all". */
function readActiveFilter(
  params: Record<string, string | undefined>,
): string | undefined {
  const v = params.active;
  return v === "active" || v === "inactive" ? v : undefined;
}
