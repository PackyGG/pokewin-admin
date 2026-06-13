import { Suspense } from "react";
import { Coins, Package } from "lucide-react";
import {
  getPacks,
  parsePackCategory,
  type PackListItem,
  type PackSetFilter,
  type PackCategoryFilter,
} from "@/lib/queries/packs";
import {
  getUserPermissions,
  requirePageAccess,
  sessionHasRole,
} from "@/lib/dal";
import { hasCapability } from "@/app/(admin)/settings/roles/permissions-utils";
import { ensurePackCreatorCapabilities } from "@/lib/pack-creator/ensure-capabilities";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { PaginationSkeleton } from "@/components/loading-skeletons";
import { CreatePackButton } from "./create-pack-button";
import { PacksFilterBar } from "./packs-filter-bar";
import { PacksList } from "./packs-list";
import { PacksKpiStrip } from "./packs-kpi-strip";
import { PacksPageShell } from "./packs-page-shell";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
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
import {
  loadPrimary,
  parseListParams,
  boundaryKey,
} from "@/lib/entity-surface/loader";
import { safeQuery } from "@/lib/errors/safe-query";
import type { PaginatedResult } from "@/lib/types";
import { Skeleton } from "@/components/ui/skeleton";

export const metadata = { title: "Packs" };

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

export default async function PacksPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await requirePageAccess("/packs");
  const params = await searchParams;

  const { page, perPage, search, sortBy, sortOrder } = parseListParams(params, {
    defaultPerPage: 20,
    allowedSortFields: PACKS_SORT_FIELDS,
    defaultSortBy: "created_at",
    defaultSortOrder: "desc",
  });

  // Pokemon / OnePiece pool. Packs have no first-class type column — the
  // split is derived from the sets of the cards inside each pack (see
  // getPacks). `pokemon` is the default: anything that isn't an explicit
  // "onepiece" param (absent, garbage, or "pokemon") lands on Pokemon,
  // the larger pool.
  const activeSet: PackSetFilter =
    params.set === "onepiece" ? "onepiece" : "pokemon";

  // Default to the dense triage TABLE; the gallery is one toggle away.
  const view = resolveEntityView(params.view);

  // Idempotent runtime back-fill (no-op after first run per process): grants
  // existing pack_creator users __can_update_pack so they can edit demo packs.
  // Runs BEFORE getUserPermissions so the freshly-granted capability appears
  // in this same request's permission read.
  await ensurePackCreatorCapabilities();

  // Per-capability gating: pack_creator gets create + edit-on-demo; no
  // toggle / delete. Real admins always pass.
  const isAdmin = session.role === "admin";
  let canCreate = isAdmin;
  let canToggle = isAdmin;
  let canDelete = isAdmin;
  let canEdit = isAdmin;
  // __can_edit_live_packs is the pack_creator-specific opt-in that lifts the
  // demo-only (inactive) edit restriction. Real admins ignore it entirely. The
  // full card-pool/odds editor in the detail modal uses it (with the pack's
  // active state) to mirror updatePack's server gate, so it never dangles an
  // Edit button that 500s for a pack_creator touching a live pack.
  let canEditLive = isAdmin;
  if (!isAdmin) {
    // safeQuery defaulting to [] so an Admin-DB blip can't crash a
    // pack_creator's catalog view — it degrades to "no capabilities" (create /
    // edit buttons hidden), the safe default. Real admins skip this branch.
    const { data: perms } = await safeQuery(
      () => getUserPermissions(session.userId),
      [] as string[],
      "packs.list.perms",
    );
    canCreate = hasCapability(perms, "__can_create_pack");
    canToggle = hasCapability(perms, "__can_toggle_pack_active");
    canDelete = hasCapability(perms, "__can_delete_pack");
    canEdit = hasCapability(perms, "__can_update_pack");
    canEditLive = hasCapability(perms, "__can_edit_live_packs");
  }
  // Whether the viewer holds the pack_creator role (primary OR secondary).
  // pack_creators are demo-only editors unless they also hold
  // __can_edit_live_packs; admins are never gated this way.
  const isPackCreator = sessionHasRole(session, "pack_creator");

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
        <PageHero>
          <PageHeroIdentity
            icon={Package}
            title="Packs"
            subtitle="Pack catalog — pricing, availability, and economics."
            action={canCreate ? <CreatePackButton /> : undefined}
          />
        </PageHero>

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
            title={activeSet === "onepiece" ? "OnePiece Catalog" : "Pokemon Catalog"}
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
