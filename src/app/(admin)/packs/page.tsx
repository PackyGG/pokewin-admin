import { Suspense } from "react";
import { redirect } from "next/navigation";
import { Package } from "lucide-react";
import { isUuid } from "@/lib/utils/ids";
import {
  getUserPermissions,
  requirePageAccess,
  sessionHasRole,
  sessionIsAdmin,
  sessionIsOwner,
} from "@/lib/dal";
import type { SessionPayload } from "@/lib/session";
import { pageAccessGranted } from "@/lib/admin-pages";
import { hasCapability } from "@/app/(admin)/settings/roles/permissions-utils";
import { ensurePackCreatorCapabilities } from "@/lib/pack-creator/ensure-capabilities";
import { CreatePackButton } from "./create-pack-button";
import { RepriceAllPacksButton } from "./reprice-all-packs";
import { isRepriceOwner } from "@/lib/reprice-access";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { safeQuery } from "@/lib/errors/safe-query";
import {
  KpiStripSkeleton,
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
  canEdit: boolean;
  canEditLive: boolean;
  isPackCreator: boolean;
};

/**
 * Resolve the Catalog tab's pack-creator capabilities — lifted verbatim from
 * the old standalone /packs page. Runs the idempotent runtime back-fill first
 * (no-op after the first run per process) so a freshly-granted capability
 * appears in this same request's permission read. Real admins always pass;
 * non-admins read their effective `allowed_pages` via a safeQuery so an
 * Admin-DB blip degrades to "no capabilities" rather than crashing the page.
 */
async function resolveCatalogCaps(session: SessionPayload): Promise<CatalogCaps> {
  await ensurePackCreatorCapabilities();

  const isAdmin = session.role === "admin";
  if (isAdmin) {
    return {
      canCreate: true,
      canToggle: true,
      canDelete: true,
      canEdit: true,
      canEditLive: true,
      isPackCreator: sessionHasRole(session, "pack_creator"),
    };
  }
  const { data: perms } = await safeQuery(
    () => getUserPermissions(session.userId),
    [] as string[],
    "packs.list.perms",
  );
  return {
    canCreate: hasCapability(perms, "__can_create_pack"),
    canToggle: hasCapability(perms, "__can_toggle_pack_active"),
    canDelete: hasCapability(perms, "__can_delete_pack"),
    canEdit: hasCapability(perms, "__can_update_pack"),
    canEditLive: hasCapability(perms, "__can_edit_live_packs"),
    isPackCreator: sessionHasRole(session, "pack_creator"),
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
  let canViewTransactions = isPrivileged;
  if (!isPrivileged) {
    const { data: allowed } = await safeQuery(
      () => getUserPermissions(session.userId),
      [] as string[],
      "packs.tx-access",
    );
    canViewTransactions = pageAccessGranted(allowed, "/transactions/packs");
  }

  // Resolve the Catalog caps once when the Catalog tab is active, so both the
  // hero action and the catalog body read the same flags (no double work).
  const caps = tab === "catalog" ? await resolveCatalogCaps(session) : null;

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Package}
          title="Packs"
          subtitle="Pack catalog and pack-opening transactions in one place."
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

      {/* One async segment per tab — only the active one mounts so the
          inactive tab never runs its queries (Active-Tab-Only). */}
      <Suspense
        key={tab}
        fallback={
          <div className="space-y-6">
            <KpiStripSkeleton count={5} />
            <div className="space-y-3">
              <SectionHeadingSkeleton titleWidth={120} />
              <TableSkeleton rows={8} columns={6} />
            </div>
          </div>
        }
      >
        {tab === "transactions" ? (
          <PackTransactionsTabSegment params={params} />
        ) : (
          <PacksCatalogTab
            searchParams={params}
            canToggle={caps!.canToggle}
            canDelete={caps!.canDelete}
            canEdit={caps!.canEdit}
          />
        )}
      </Suspense>
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
