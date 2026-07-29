import { Suspense } from "react";

import {
  getUserPermissions,
  requirePageAccess,
  sessionIsAdmin,
  sessionIsOwner,
} from "@/lib/dal";
import { pageAccessGranted } from "@/lib/admin-pages";
import { safeQuery } from "@/lib/errors/safe-query";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import {
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";
import { parseUpgraderTab } from "./tabs";
import { UpgraderTabNav } from "./_components/upgrader-tab-nav";
import { UpgraderCatalogTab } from "./_components/catalog-tab";
import { UpgraderTransactionsTab } from "./_tx/transactions-tab";

export const metadata = { title: "Upgrader" };

/**
 * Upgrader — the merged Catalog + Transactions surface.
 *
 * Combines the former standalone /upgrader (the output-card pool) and
 * /transactions/upgrader (every upgrader game) into one tabbed page:
 *   • "Catalog"      — the output card pool the upgrader wheel can pay out.
 *   • "Transactions" — every upgrader game (bet, payout, house P&L).
 *
 * Active-Tab-Only: each tab is an async server segment behind a single
 * `<Suspense key={tab}>`, so only the active tab runs its (heavy) queries.
 * Switching tabs is a `?tab=` navigation (the client tab nav), never an eager
 * dual-fetch — the Transactions tab's game_sessions scans never fire while the
 * Catalog tab is showing, and vice-versa.
 *
 * SECURITY: the page keeps its `requirePageAccess("/upgrader")` gate (the
 * Catalog key). The Transactions tab keeps the ORIGINAL `/transactions/upgrader`
 * permission key, enforced two ways: the tab chip is hidden unless the viewer
 * holds that grant (`canViewTransactions`), AND a direct hit on
 * `?tab=transactions` re-runs `requirePageAccess("/transactions/upgrader")`
 * before the segment mounts, so a Catalog-only user is redirected before any
 * game_sessions read. A user with only the transactions grant still reaches it
 * via the /transactions/upgrader → /upgrader?tab=transactions redirect.
 */
export default async function UpgraderPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await requirePageAccess("/upgrader");
  const params = await searchParams;

  const tab = parseUpgraderTab(params.tab);

  // Whether the viewer may see the Transactions tab — admin/owner bypass
  // (same as requirePageAccess), otherwise the original /transactions/upgrader
  // grant. Drives the tab-chip visibility; the segment re-enforces it.
  const isPrivileged = sessionIsAdmin(session) || sessionIsOwner(session);
  let canViewTransactions = isPrivileged;
  if (!isPrivileged) {
    const { data: allowed } = await safeQuery(
      () => getUserPermissions(session.userId),
      [] as string[],
      "upgrader.tx-access",
    );
    canViewTransactions = pageAccessGranted(allowed, "/transactions/upgrader");
  }

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity />
      </PageHero>

      <UpgraderTabNav canViewTransactions={canViewTransactions} />

      {/* One async segment per tab — only the active one mounts so the
          inactive tab never runs its queries (Active-Tab-Only). */}
      <Suspense
        key={tab}
        fallback={
          <div className="space-y-6">
            <KpiStripSkeleton count={5} />
            <div className="space-y-3">
              <SectionHeadingSkeleton titleWidth={120} />
              <TableSkeleton rows={8} columns={7} />
            </div>
          </div>
        }
      >
        {tab === "transactions" ? (
          <UpgraderTransactionsTabSegment params={params} />
        ) : (
          <UpgraderCatalogTab searchParams={params} />
        )}
      </Suspense>
    </div>
  );
}

/**
 * Transactions tab segment. Re-enforces the ORIGINAL `/transactions/upgrader`
 * permission key server-side before mounting the body, so a Catalog-only user
 * who navigates directly to `?tab=transactions` is redirected before any
 * game_sessions read — the tab is NOT widened to the /upgrader grant.
 */
async function UpgraderTransactionsTabSegment({
  params,
}: {
  params: Record<string, string | undefined>;
}) {
  await requirePageAccess("/transactions/upgrader");
  return <UpgraderTransactionsTab searchParams={params} />;
}
