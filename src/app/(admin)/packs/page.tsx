import { Suspense } from "react";
import { redirect } from "next/navigation";
import { isUuid } from "@/lib/utils/ids";
import {
  getUserPermissions,
  requirePageAccess,
  sessionIsAdmin,
  sessionIsOwner,
} from "@/lib/dal";
import { pageAccessGranted } from "@/lib/admin-pages";
import { hasCapability } from "@/app/(admin)/settings/roles/permissions-utils";
import { CreatePackButton } from "./create-pack-button";
import { RepriceAllPacksButton } from "./reprice-all-packs";
import { isRepriceOwner } from "@/lib/reprice-access";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { safeQuery } from "@/lib/errors/safe-query";
import {
  SectionHeadingSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";
import { parsePacksTab } from "./tabs";
import { PacksTabNav } from "./_components/packs-tab-nav";
import { PacksCatalogTab } from "./_components/catalog-tab";
import { PackTransactionsTab } from "./_components/transactions-tab";

export const metadata = { title: "Packs" };

/** Pack-creator capability flags + role membership for the Catalog tab. */
type CatalogCaps = {
  canCreate: boolean;
  canToggle: boolean;
  canDelete: boolean;
};

/** Full capabilities — the `session.role === "admin"` short-circuit. */
const ADMIN_CATALOG_CAPS: CatalogCaps = {
  canCreate: true,
  canToggle: true,
  canDelete: true,
};

/**
 * Derive the Catalog tab's pack-creator capabilities from an ALREADY-RESOLVED
 * permission list. Pure — it issues no read of its own, so the page can share a
 * single `getUserPermissions()` result between this and the Transactions-tab
 * visibility gate (they used to run the identical Admin-DB read twice per
 * render, serialized, because `caps` was awaited after the tab-access check).
 */
function catalogCapsFrom(permissions: string[]): CatalogCaps {
  return {
    canCreate: hasCapability(permissions, "__can_create_pack"),
    canToggle: hasCapability(permissions, "__can_toggle_pack_active"),
    canDelete: hasCapability(permissions, "__can_delete_pack"),
  };
}

/**
 * Packs — the merged Catalog + Transactions surface.
 *
 * Combines the former standalone /packs (the pack catalog) and
 * /transactions/packs (pack-opening transactions) into one tabbed page:
 *   • "Catalog"      — the pack catalog (pricing, availability, economics).
 *   • "Transactions" — pack-opening ledger transactions.
 *
 * Active-Tab-Only: each tab is an async server segment behind a single
 * `<Suspense key={tab}>`, so only the active tab runs its (heavy) queries.
 * Switching tabs is a `?tab=` navigation (the client tab nav), never an eager
 * dual-fetch — the Transactions tab's ledger joins never fire while the
 * Catalog tab is showing, and vice-versa.
 *
 * SECURITY: the page keeps its `requirePageAccess("/packs")` gate (the Catalog
 * key). The Transactions tab keeps the ORIGINAL `/transactions/packs`
 * permission key, enforced two ways: the tab chip is hidden unless the viewer
 * holds that grant (`canViewTransactions`), AND a direct hit on
 * `?tab=transactions` re-runs `requirePageAccess("/transactions/packs")` before
 * the segment mounts, so a Catalog-only user is redirected before any ledger
 * read. A user with only the transactions grant still reaches it via the
 * /transactions/packs → /packs?tab=transactions redirect.
 */
export default async function PacksPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await requirePageAccess("/packs");
  const params = await searchParams;

  // Legacy inspect URLs → dedicated detail route.
  if (params.inspect && isUuid(params.inspect)) {
    redirect(`/packs/${params.inspect}`);
  }

  const tab = parsePacksTab(params.tab);

  // Whether the viewer may see the Transactions tab — admin/owner bypass
  // (same as requirePageAccess), otherwise the original /transactions/packs
  // grant. Drives the tab-chip visibility; the segment re-enforces it.
  const isPrivileged = sessionIsAdmin(session) || sessionIsOwner(session);
  // The Catalog caps keep their ORIGINAL, narrower short-circuit
  // (`session.role === "admin"`) — an owner-without-admin-role still resolves
  // its capabilities from the grant list, exactly as before.
  const isRoleAdmin = session.role === "admin";
  const catalogActive = tab === "catalog";

  // ONE Admin-DB permission read for both consumers. Previously the tab-access
  // gate and `resolveCatalogCaps` each issued their own
  // `getUserPermissions(session.userId)` — the same row, fetched twice and
  // serialized (caps was awaited after the gate). Same inputs, same flags, one
  // round trip; skipped entirely when neither consumer needs it.
  const needsPermissions = !isPrivileged || (catalogActive && !isRoleAdmin);
  const { data: permissions } = needsPermissions
    ? await safeQuery(
        () => getUserPermissions(session.userId),
        [] as string[],
        "packs.permissions",
      )
    : { data: [] as string[] };

  const canViewTransactions =
    isPrivileged || pageAccessGranted(permissions, "/transactions/packs");

  // Resolved once when the Catalog tab is active, so both the hero action and
  // the catalog body read the same flags (no double work).
  const caps: CatalogCaps | null = !catalogActive
    ? null
    : isRoleAdmin
      ? ADMIN_CATALOG_CAPS
      : catalogCapsFrom(permissions);

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          action={
            // Hero actions belong to the Catalog tab only (create / reprice).
            caps && (caps.canCreate || isRepriceOwner(session)) ? (
              <div className="flex flex-wrap items-center gap-2">
                {/* Owner-only (motha): re-price tool is hidden from every
                    other admin. Enforced again server-side in the actions. */}
                {isRepriceOwner(session) && <RepriceAllPacksButton />}
                {caps.canCreate && <CreatePackButton />}
              </div>
            ) : undefined
          }
        />
      </PageHero>

      <PacksTabNav canViewTransactions={canViewTransactions} />

      {/* Active-Tab-Only is enforced by this conditional alone: only the
          active tab's segment is ever in the tree, so the inactive tab never
          runs its queries. The Catalog tab is rendered DIRECTLY (not wrapped
          in a combined per-tab boundary) so its own internal boundaries — the
          KPI strip (keyed only on the active set, NOT on `page`) and the
          paginated table (keyed on page/view/sort/search) — stay independent.
          Paging therefore re-keys only the table boundary and the KPI boxes
          persist across page changes instead of flashing a skeleton (mirrors
          /rewards/rakeback's split summary + table boundaries). The
          Transactions tab is async (it re-enforces its own permission gate),
          so it gets its own keyed Suspense. */}
      {tab === "transactions" ? (
        <Suspense
          key="tab-transactions"
          fallback={
            <div className="space-y-3">
              <SectionHeadingSkeleton titleWidth={120} />
              <TableSkeleton rows={8} columns={6} />
            </div>
          }
        >
          <PackTransactionsTabSegment params={params} />
        </Suspense>
      ) : (
        <PacksCatalogTab
          searchParams={params}
          canToggle={caps!.canToggle}
          canDelete={caps!.canDelete}
        />
      )}
    </div>
  );
}

/**
 * Transactions tab segment. Re-enforces the ORIGINAL `/transactions/packs`
 * permission key server-side before mounting the body, so a Catalog-only user
 * who navigates directly to `?tab=transactions` is redirected before any
 * ledger read — the tab is NOT widened to the /packs grant.
 */
async function PackTransactionsTabSegment({
  params,
}: {
  params: Record<string, string | undefined>;
}) {
  await requirePageAccess("/transactions/packs");
  return <PackTransactionsTab searchParams={params} />;
}
