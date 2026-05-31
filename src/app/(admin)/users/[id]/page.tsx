import { Suspense } from "react";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getUserDetail } from "@/lib/queries/users";
import { getUserTags } from "@/lib/queries/user-tags";
import { getUserCreatorHistory } from "@/lib/queries/user-role-history";
import { requirePageAccess, getUserPermissions } from "@/lib/dal";
import { hasCapability } from "@/app/(admin)/settings/roles/permissions-utils";
import { ensureSupportBaseline } from "@/lib/support-baseline";
import { UserTagsPanel } from "./user-tags-panel";
import { AutoRefresh } from "../../dashboard/auto-refresh";
import { computeRiskScore } from "@/lib/fraud/score";
import { UserViewModern } from "./user-view-modern";
import { coerceTab } from "./user-tabs-types";
import {
  OverviewTabContent,
  GamingTabContent,
  FinancesTabContent,
  RewardsTabContent,
  InventoryTabContent,
  TrustTabContent,
  AffiliateTabContent,
  AccountTabContent,
} from "./tab-content";
import { Skeleton } from "@/components/ui/skeleton";
import {
  TableSkeleton,
  StatPanelSkeleton,
  GridSkeleton,
} from "@/components/loading-skeletons";
import { safeQuery } from "@/lib/errors/safe-query";

export const metadata = { title: "User Detail" };

export default async function UserDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  // Self-heal support's /users baseline before the gate runs — same
  // protection as /users/page.tsx so a deep-link into /users/[id]
  // also re-grants if the bulk role editor wiped it. See
  // src/lib/support-baseline.ts.
  await ensureSupportBaseline();
  const session = await requirePageAccess("/users");
  const { id } = await params;
  const sp = await searchParams;
  // Active tab is URL-driven (?tab=<key>). Anything not on the
  // whitelist resolves to "overview" so the page can't be broken by
  // arbitrary param values. This replaces the prior client-side
  // useState tab driver — necessary because per-tab data now streams
  // via Suspense and the server needs to know which tab to render.
  const activeTab = coerceTab(sp.tab);

  // ── HEADER FETCH ───────────────────────────────────────────────
  // Only the data needed for the hero (identity, balances, badges,
  // risk score) + the action-button capability flags. Per-tab data
  // (transactions, P&L, inventory, rewards, notes, shared identity)
  // is fetched inside the per-tab Suspense segments below so the
  // hero paints immediately while the active tab streams in.
  //
  // Resolve permissions in parallel: admins skip the permissions
  // fetch entirely (they get all capabilities by definition) so
  // only non-admins trigger the extra round-trip.
  // getUserDetail + permissions are the page's primary data — if they
  // throw, the segment-level error.tsx takes over (the page can't render
  // without them). The three peripheral queries (tags, history, risk
  // score) are non-critical hero metadata — wrap them in safeQuery so a
  // slow admin DB lookup or a heavy fraud-score SQL hiccup doesn't blank
  // the entire user-detail view. Each falls back to a neutral empty
  // shape that the downstream rendering already tolerates.
  const [data, permissions, userTagsResult, creatorHistoryResult, riskResult] =
    await Promise.all([
      getUserDetail(id),
      session.role === "admin" ? Promise.resolve(null) : getUserPermissions(session.userId),
      // VIP tags (admin-CRM metadata). Empty array on failure → the
      // UserTagsPanel renders the empty-state dashed row, no crash.
      safeQuery(() => getUserTags(id), [], "users.detail.tags"),
      // Creator history already self-degrades inside the query (its own
      // try/catch returns the empty shape). safeQuery adds the central
      // log line on top so the failure surfaces in Vercel logs with the
      // standard `[error:users.detail.creatorHistory]` prefix.
      safeQuery(
        () => getUserCreatorHistory(id),
        { everCreatorByAudit: false, creatorSince: null },
        "users.detail.creatorHistory",
      ),
      // Fraud / trust assessment for the hero badges. Heaviest query on
      // the page (cross-table aggregate). Failure → the hero falls back
      // to the same neutral "low / 0 / no signals" shape the query
      // itself emits for unknown users, so the risk badge renders
      // unobtrusively instead of blanking the whole view.
      safeQuery(
        () => computeRiskScore(id),
        {
          score: 0,
          tier: "low" as const,
          signals: [],
          topReasons: [],
          suggestions: [],
          timeline: [],
          sharedIpCount: 0,
          sharedFingerprintCount: 0,
          sharedBannedCount: 0,
          sharedLockedCount: 0,
          computedAt: Date.now(),
          computeDurationMs: 0,
        },
        "users.detail.riskScore",
      ),
    ]);

  if (!data) notFound();
  const userTags = userTagsResult.data;
  const creatorHistory = creatorHistoryResult.data;
  const riskBreakdown = riskResult.data;

  // "Ever a creator?" = currently creator, OR an audit role-change to
  // creator exists, OR they own affiliate codes (created only for
  // creators). wasCreator surfaces the past-creator badge for users who
  // aren't creators right now.
  const everCreator =
    data.user.role === "creator" ||
    creatorHistory.everCreatorByAudit ||
    data.user.ownedCodes.length > 0;
  const wasCreator = everCreator && data.user.role !== "creator";

  const capabilities =
    session.role === "admin"
      ? {
          canAdjustBalance: true,
          canAdjustXp: true,
          canEditIdentity: true,
          canBanUsers: true,
          canLockUsers: true,
          canToggleFeatureLocks: true,
          canAssignAffiliate: true,
          canWipeAccounts: true,
          canChangeUserRoles: true,
          canRecordManualWithdrawal: true,
        }
      : {
          canAdjustBalance: hasCapability(permissions ?? [], "__can_adjust_balance"),
          canAdjustXp: hasCapability(permissions ?? [], "__can_adjust_xp"),
          canEditIdentity: hasCapability(permissions ?? [], "__can_edit_identity"),
          canBanUsers: hasCapability(permissions ?? [], "__can_ban_users"),
          canLockUsers: hasCapability(permissions ?? [], "__can_lock_users"),
          canToggleFeatureLocks: hasCapability(permissions ?? [], "__can_toggle_feature_locks"),
          canAssignAffiliate: hasCapability(permissions ?? [], "__can_assign_affiliate"),
          canWipeAccounts: hasCapability(permissions ?? [], "__can_wipe_accounts"),
          canChangeUserRoles: hasCapability(permissions ?? [], "__can_change_user_roles"),
          canRecordManualWithdrawal: hasCapability(permissions ?? [], "__can_record_manual_withdrawal"),
        };

  // Tag management is independent of the per-action capabilities
  // above so it can be granted to a CRM/sales role without giving
  // them ban/edit-identity/wipe etc.
  const canManageUserTags =
    session.role === "admin" ||
    hasCapability(permissions ?? [], "__can_manage_user_tags");

  // Hydrate UserDetail with session-derived fields so tab content
  // components see the same shape they had pre-refactor. Avoids a
  // second round-trip + keeps capability gating consistent across
  // hero (page-level) and tab body (segment-level).
  const detailWithSession = {
    ...data,
    sessionRole: session.role,
    capabilities,
    wasCreator,
    creatorSince: creatorHistory.creatorSince,
  };

  // Suspense key — re-throw the fallback when the tab changes so the
  // skeleton matches the new tab's shape on switch. Otherwise React
  // would reuse the prior tab's resolved children until the new tab's
  // promise resolves, which looks like a frozen page.
  const tabFallback = <TabFallback tab={activeTab} />;

  return (
    <div className="space-y-4">
      {/* Re-fetch server data every 60s so admins watching a user-detail
          tab don't see stale gaming transactions / balances. router.refresh
          re-runs both the page-level fetches AND the active tab's
          Suspense segment, so the visible tab's content stays fresh
          without re-firing other tabs' queries. */}
      <AutoRefresh intervalMs={60_000} />
      <div className="space-y-2">
        <div className="flex items-center gap-3 flex-wrap">
          <Link href="/users" className="inline-flex size-9 items-center justify-center rounded-md hover:bg-accent hover:text-accent-foreground">
            <ArrowLeft className="size-4" />
          </Link>
          <div className="min-w-0">
            <h1 className="text-2xl font-bold leading-tight">
              {data.user.username ?? data.user.email}
            </h1>
            <p className="text-sm text-muted-foreground">{data.user.email}</p>
          </div>
        </div>
        {/* VIP tag manager — dedicated dashed-border row so admins
            always notice the section (even on empty profiles). Read-
            only for viewers without __can_manage_user_tags. */}
        <UserTagsPanel
          userId={id}
          initialTags={userTags}
          canManage={canManageUserTags}
        />
      </div>
      <UserViewModern
        data={detailWithSession}
        riskBreakdown={riskBreakdown}
        activeTab={activeTab}
      >
        {/* Each tab segment fetches only its own data. The Suspense
            key is the tab name so switching from Overview → Cards
            re-throws the fallback (otherwise React would reuse the
            prior tab's resolved JSX). */}
        <Suspense key={activeTab} fallback={tabFallback}>
          {activeTab === "overview" && (
            <OverviewTabContent data={detailWithSession} />
          )}
          {activeTab === "gaming" && (
            <GamingTabContent data={detailWithSession} />
          )}
          {activeTab === "finances" && (
            <FinancesTabContent data={detailWithSession} />
          )}
          {activeTab === "rewards" && <RewardsTabContent userId={id} />}
          {activeTab === "inventory" && (
            <InventoryTabContent data={detailWithSession} />
          )}
          {activeTab === "trust" && <TrustTabContent userId={id} />}
          {activeTab === "affiliate" && (
            <AffiliateTabContent data={detailWithSession} />
          )}
          {activeTab === "account" && (
            <AccountTabContent data={detailWithSession} />
          )}
        </Suspense>
      </UserViewModern>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────
//  TAB FALLBACK — matches each tab's rough shape so the skeleton
//  doesn't jump when the real content swaps in.
// ───────────────────────────────────────────────────────────────────

function TabFallback({ tab }: { tab: string }) {
  // Each tab has a different shape; matching the silhouette keeps the
  // layout from jumping when the streamed content resolves. The
  // common pattern (panels + a table or grid) covers the heavy tabs;
  // lighter tabs reuse a simpler skeleton.
  switch (tab) {
    case "overview":
      return (
        <div className="space-y-4 sm:space-y-6">
          <div className="grid gap-3 sm:gap-4 grid-cols-1 md:grid-cols-3">
            <StatPanelSkeleton rows={4} />
            <StatPanelSkeleton rows={4} />
            <StatPanelSkeleton rows={4} />
          </div>
          <Skeleton className="h-9 w-48" />
          <TableSkeleton rows={6} columns={6} />
          <Skeleton className="h-9 w-32" />
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <Skeleton className="h-32 rounded-2xl" />
            <Skeleton className="h-32 rounded-2xl" />
            <Skeleton className="h-32 rounded-2xl" />
            <Skeleton className="h-32 rounded-2xl" />
          </div>
          <Skeleton className="h-9 w-40" />
          <Skeleton className="h-64 rounded-2xl" />
        </div>
      );
    case "gaming":
    case "finances":
      return (
        <div className="space-y-6">
          <Skeleton className="h-9 w-48" />
          <TableSkeleton rows={10} columns={7} />
        </div>
      );
    case "inventory":
      return (
        <div className="space-y-6">
          <Skeleton className="h-9 w-48" />
          <GridSkeleton count={18} cols={6} />
          <Skeleton className="h-9 w-48" />
          <TableSkeleton rows={6} columns={6} />
        </div>
      );
    case "trust":
      return (
        <div className="space-y-6">
          <Skeleton className="h-48 rounded-2xl" />
          <Skeleton className="h-9 w-48" />
          <Skeleton className="h-64 rounded-2xl" />
          <Skeleton className="h-9 w-48" />
          <TableSkeleton rows={5} columns={5} />
          <Skeleton className="h-9 w-48" />
          <TableSkeleton rows={5} columns={5} />
        </div>
      );
    case "rewards":
      return (
        <div className="space-y-6">
          <Skeleton className="h-9 w-48" />
          <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
            <Skeleton className="h-28 rounded-2xl" />
            <Skeleton className="h-28 rounded-2xl" />
            <Skeleton className="h-28 rounded-2xl" />
            <Skeleton className="h-28 rounded-2xl" />
          </div>
          <Skeleton className="h-48 rounded-2xl" />
        </div>
      );
    case "affiliate":
      return (
        <div className="space-y-6">
          <Skeleton className="h-32 rounded-2xl" />
          <Skeleton className="h-9 w-48" />
          <Skeleton className="h-40 rounded-2xl" />
          <Skeleton className="h-9 w-48" />
          <Skeleton className="h-40 rounded-2xl" />
        </div>
      );
    case "account":
      return (
        <div className="space-y-6">
          <Skeleton className="h-9 w-48" />
          <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
            <Skeleton className="h-28 rounded-2xl" />
            <Skeleton className="h-28 rounded-2xl" />
            <Skeleton className="h-28 rounded-2xl" />
            <Skeleton className="h-28 rounded-2xl" />
          </div>
          <Skeleton className="h-9 w-48" />
          <Skeleton className="h-64 rounded-2xl" />
          <Skeleton className="h-9 w-48" />
          <Skeleton className="h-40 rounded-2xl" />
        </div>
      );
    default:
      return <Skeleton className="h-64 rounded-2xl" />;
  }
}
