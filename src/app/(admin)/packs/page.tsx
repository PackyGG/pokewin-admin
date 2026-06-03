import { Suspense } from "react";
import {
  Coins,
  DollarSign,
  Gauge,
  Package,
  Power,
  Sparkles,
} from "lucide-react";
import {
  getPacks,
  getPacksListStats,
  type PackListItem,
  type PackSetFilter,
} from "@/lib/queries/packs";
import { getUserPermissions, requirePageAccess } from "@/lib/dal";
import { hasCapability } from "@/app/(admin)/settings/roles/permissions-utils";
import { ensurePackCreatorCapabilities } from "@/lib/pack-creator/ensure-capabilities";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { PaginationSkeleton } from "@/components/loading-skeletons";
import { CreatePackButton } from "./create-pack-button";
import { PacksFilterBar } from "./packs-filter-bar";
import { PacksList } from "./packs-list";
import {
  KpiTile,
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { houseAccent, formatPercentValue } from "@/lib/house-pov";
import {
  resolveEntityView,
  type EntityView,
} from "@/components/entity-surface/view-toggle";
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
import type { PaginatedResult } from "@/lib/types";

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
  sortBy,
  sortOrder,
  set,
  view,
  canToggle,
  canDelete,
  canEdit,
}: {
  page: number;
  perPage: number;
  search?: string;
  active?: string;
  sortBy?: string;
  sortOrder: "asc" | "desc";
  set: PackSetFilter;
  view: EntityView;
  canToggle: boolean;
  canDelete: boolean;
  canEdit: boolean;
}) {
  const { data: result, error } = await loadPrimary(
    () =>
      getPacks({ page, perPage, search, active, sortBy, sortOrder, set }),
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
        <PacksList
          data={result.data}
          view={view}
          canToggle={canToggle}
          canDelete={canDelete}
          canEdit={canEdit}
        />
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
  if (!isAdmin) {
    const perms = await getUserPermissions(session.userId);
    canCreate = hasCapability(perms, "__can_create_pack");
    canToggle = hasCapability(perms, "__can_toggle_pack_active");
    canDelete = hasCapability(perms, "__can_delete_pack");
    canEdit = hasCapability(perms, "__can_update_pack");
  }

  // Tab-scoped KPI stats — cached aggregates that stay stable across page
  // navigation + search refinements. Scoped to the active Pokemon / OnePiece
  // pool so the strip matches the list below.
  const stats = await getPacksListStats(activeSet);

  const activeFilter = readActiveFilter(params);

  const suspenseKey = boundaryKey([
    activeSet,
    view,
    page,
    perPage,
    search,
    activeFilter,
    sortBy,
    sortOrder,
  ]);

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Package}
          title="Packs"
          subtitle="Pack catalog — pricing, availability, and economics."
          action={canCreate ? <CreatePackButton /> : undefined}
        />
      </PageHero>

      {/* KPI strip — pool-scoped totals that stay stable while admins
          paginate or filter the list below. House-POV colors throughout. */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        <KpiTile
          label={activeSet === "onepiece" ? "OnePiece Packs" : "Pokemon Packs"}
          value={formatNumber(stats.totalPacks)}
          sub={
            stats.totalPacks > 0
              ? `${stats.activePacks} active · ${
                  stats.totalPacks - stats.activePacks
                } off`
              : undefined
          }
          icon={Package}
          accent="blue"
        />
        <KpiTile
          label="Active"
          value={formatNumber(stats.activePacks)}
          sub={
            stats.totalPacks > 0
              ? `${Math.round(
                  (stats.activePacks / stats.totalPacks) * 100,
                )}% of catalog`
              : undefined
          }
          icon={Power}
          accent="cyan"
        />
        <KpiTile
          label="Lifetime Opens"
          value={formatNumber(stats.totalOpenings)}
          icon={Sparkles}
          accent="purple"
        />
        <KpiTile
          label="Lifetime Revenue"
          value={formatCurrency(stats.totalRevenue)}
          sub={`payout ${formatCurrency(stats.totalPayout)}`}
          icon={DollarSign}
          accent="emerald"
        />
        <KpiTile
          label="House Edge"
          value={formatPercentValue(stats.houseEdgePct, 1)}
          sub={
            stats.totalRevenue > 0
              ? `${formatCurrency(
                  stats.totalRevenue - stats.totalPayout,
                )} kept`
              : "no opens yet"
          }
          icon={Gauge}
          // House-POV: positive pool edge → emerald, negative → rose.
          accent={houseAccent(stats.houseEdgePct)}
        />
      </div>

      <div className="space-y-3">
        <SectionHeading
          icon={Coins}
          title={activeSet === "onepiece" ? "OnePiece Catalog" : "Pokemon Catalog"}
        />
        {/* Filter chrome (tab switch + search + status + view toggle). Its own
            Suspense boundary so the controls flush before the list query. */}
        <Suspense fallback={<FilterBarSkeleton filters={1} />}>
          <PacksFilterBar />
        </Suspense>
        {/* List — keyed so the skeleton re-triggers on any param that changes
            the result set or the view. Skeleton matches the ACTIVE view. */}
        <Suspense
          key={suspenseKey}
          fallback={
            <>
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
            </>
          }
        >
          <PacksContent
            page={page}
            perPage={perPage}
            search={search}
            active={activeFilter}
            sortBy={sortBy}
            sortOrder={sortOrder}
            set={activeSet}
            view={view}
            canToggle={canToggle}
            canDelete={canDelete}
            canEdit={canEdit}
          />
        </Suspense>
      </div>
    </div>
  );
}

/** Read the (optional) status filter param, normalized away from "all". */
function readActiveFilter(
  params: Record<string, string | undefined>,
): string | undefined {
  const v = params.active;
  return v === "active" || v === "inactive" ? v : undefined;
}
