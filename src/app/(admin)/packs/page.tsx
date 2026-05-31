import { Suspense } from "react";
import {
  Coins,
  DollarSign,
  Gauge,
  Package,
  Power,
  Sparkles,
} from "lucide-react";
import { getPacks, getPacksListStats } from "@/lib/queries/packs";
import { getUserPermissions, requirePageAccess } from "@/lib/dal";
import { hasCapability } from "@/app/(admin)/settings/roles/permissions-utils";
import { ensurePackCreatorCapabilities } from "@/lib/pack-creator/ensure-capabilities";
import { PacksGrid } from "./packs-grid";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { Skeleton } from "@/components/ui/skeleton";
import { PaginationSkeleton } from "@/components/loading-skeletons";
import { CreatePackButton } from "./create-pack-button";
import {
  KpiTile,
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { formatCurrency, formatNumber } from "@/lib/utils/format";

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
  canToggle,
  canDelete,
}: {
  page: number;
  perPage: number;
  search?: string;
  active?: string;
  sortBy?: string;
  sortOrder?: string;
  canToggle: boolean;
  canDelete: boolean;
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
        <PacksGrid
          data={result.data}
          canToggle={canToggle}
          canDelete={canDelete}
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
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;

  const suspenseKey = `${page}|${perPage}|${params.search ?? ""}|${params.active ?? ""}|${params.sortBy ?? ""}|${params.sortOrder ?? ""}`;

  // Idempotent runtime back-fill: existing pack_creator users were
  // created before __can_update_pack landed in the role's default
  // allowed_pages, so they couldn't edit demo packs after saving.
  // This grants the capability to anyone with role 'pack_creator'
  // who's missing it. No-op after the first run per process.
  // Runs BEFORE getUserPermissions so the freshly-granted capability
  // appears in this same request's permission read.
  await ensurePackCreatorCapabilities();

  // Per-capability gating: pack_creator gets create + edit-on-demo;
  // no toggle / delete. Real admins always pass; the catalog of
  // __can_* keys lives in permissions-utils.ts.
  const isAdmin = session.role === "admin";
  let canCreate = isAdmin;
  let canToggle = isAdmin;
  let canDelete = isAdmin;
  if (!isAdmin) {
    const perms = await getUserPermissions(session.userId);
    canCreate = hasCapability(perms, "__can_create_pack");
    canToggle = hasCapability(perms, "__can_toggle_pack_active");
    canDelete = hasCapability(perms, "__can_delete_pack");
  }

  // Global KPI stats — cached aggregates that stay stable across page
  // navigation + search refinements. Read off the maintained
  // packs.total_* columns in a single round-trip; see getPacksListStats
  // for the unstable_cache wrap mirroring /users.
  const stats = await getPacksListStats();
  // House-POV accent: positive edge means we're up overall → emerald;
  // negative means we've paid out more than we took in → rose. Mirrors
  // the per-tile financial-color rule in CLAUDE.md.
  const houseEdgeAccent = stats.houseEdgePct >= 0 ? "emerald" : "rose";

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Package}
          title="Packs"
          subtitle="Pack catalog — pricing, availability, and stats."
          action={canCreate ? <CreatePackButton /> : undefined}
        />
      </PageHero>

      {/* KPI strip — catalog-wide totals that stay stable while admins
          paginate or filter the grid below. Lifetime Revenue / Payout
          come from the maintained packs.total_revenue / total_payout
          columns; house edge is derived from the two (volume-weighted,
          not the per-pack average). House-POV colors throughout. */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        <KpiTile
          label="Total Packs"
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
          value={`${stats.houseEdgePct.toFixed(1)}%`}
          sub={
            stats.totalRevenue > 0
              ? `${formatCurrency(
                  stats.totalRevenue - stats.totalPayout,
                )} kept`
              : "no opens yet"
          }
          icon={Gauge}
          accent={houseEdgeAccent}
        />
      </div>

      <div className="space-y-3">
        <SectionHeading icon={Coins} title="Catalog" />
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
            canToggle={canToggle}
            canDelete={canDelete}
          />
        </Suspense>
      </div>
    </div>
  );
}
