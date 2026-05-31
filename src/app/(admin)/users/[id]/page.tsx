import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import {
  getUserDetail,
  getUserTransactions,
  getUserInventory,
  getUserPnlBreakdown,
  getUserRewards,
} from "@/lib/queries/users";
import { getNotesForUser } from "@/lib/queries/admin-notes";
import { getUserTags } from "@/lib/queries/user-tags";
import { getUserCreatorHistory } from "@/lib/queries/user-role-history";
import { requirePageAccess, getUserPermissions } from "@/lib/dal";
import { hasCapability } from "@/app/(admin)/settings/roles/permissions-utils";
import { ensureSupportBaseline } from "@/lib/support-baseline";
import { UserTagsPanel } from "./user-tags-panel";
import { AutoRefresh } from "../../dashboard/auto-refresh";
import { computeRiskScore } from "@/lib/fraud/score";
import {
  getSharedIpUsers,
  getSharedFingerprintUsers,
} from "@/lib/fraud/shared-identity";
import { UserViewModern } from "./user-view-modern";
import { coerceTab } from "./user-tabs-types";
import { safeQuery } from "@/lib/errors/safe-query";

export const metadata = { title: "User Detail" };

// GAMING is pack / battle / upgrader play — entry, payout, refund.
// Sale / exchange rows live in FINANCIAL_TYPES below so card sales
// appear alongside deposits and withdrawals as cash-movement events;
// the gaming tab stays focused on gameplay.
const GAMING_TYPES = [
  "pack_opening",
  "battle_bet",
  "battle_sponsorship",
  "battle_refund",
  "upgrader_bet",
  "upgrader_payout",
  "voucher_redeemed",
];
// FINANCIAL covers deposits, withdrawals, and direct cash payouts
// (rakeback / affiliate / rain / race / gift / promo). Card sales +
// card / voucher exchanges intentionally live in NEITHER tab — they
// bloated the Deposits & Withdrawals view with rows admins did not
// consider cash events. If a future surface needs them they'll get
// their own section instead of being folded into Financial.
const FINANCIAL_TYPES = [
  "deposit",
  "deposit_bonus",
  "admin_balance_adjustment",
  "card_withdrawal",
  "withdrawal_shipping_fee",
  "rakeback_claim",
  "balance_reward_claim",
  "affiliate_claim",
  "promo_code_redeemed",
  "gift_card_redeemed",
  "rain_win",
  "race_prize",
];

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
  // Active tab is URL-driven (?tab=<key>) so deep-links from elsewhere
  // (hero risk badges, future bookmarks) still resolve correctly.
  // The shell hydrates this into client state on mount so subsequent
  // tab clicks are instant — see UserViewModern.
  const initialTab = coerceTab(sp.tab);

  // ── UPFRONT FETCH ──────────────────────────────────────────────
  // All tab data is fetched in one Promise.all so tab switching is
  // instant client-side — the alternative (per-tab Suspense fanout)
  // makes every click a server round-trip and feels broken.
  //
  // getUserDetail + permissions are the page's primary data — if they
  // throw, the segment-level error.tsx takes over (the page can't render
  // without them). The peripheral queries (tags, history, risk score)
  // are non-critical hero metadata — wrap them in safeQuery so a slow
  // admin DB lookup or a heavy fraud-score SQL hiccup doesn't blank the
  // entire user-detail view. Each falls back to a neutral empty shape
  // that the downstream rendering already tolerates.
  const [
    data,
    inventory,
    disposedInventory,
    pnlBreakdown,
    notes,
    gamingTx,
    financialTx,
    rewards,
    permissions,
    userTagsResult,
    creatorHistoryResult,
    riskResult,
    sharedIpsResult,
    sharedFingerprintsResult,
  ] = await Promise.all([
    getUserDetail(id),
    getUserInventory(id, 1, 24, { status: "owned" }),
    getUserInventory(id, 1, 24, { status: "disposed" }),
    getUserPnlBreakdown(id),
    getNotesForUser(id),
    getUserTransactions(id, 1, 10, { types: GAMING_TYPES }),
    getUserTransactions(id, 1, 10, { types: FINANCIAL_TYPES }),
    getUserRewards(id),
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
    // Fraud / trust assessment for the hero badges + Trust tab.
    // Heaviest query on the page (cross-table aggregate). Failure →
    // the hero falls back to the same neutral "low / 0 / no signals"
    // shape the query itself emits for unknown users, so the risk
    // badge renders unobtrusively instead of blanking the whole view.
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
    // Fingerprints table may be absent in fresh/dev environments —
    // degrade gracefully to an empty list rather than crashing the
    // user detail page.
    safeQuery(() => getSharedIpUsers(id), [], "users.detail.sharedIps"),
    safeQuery(
      () => getSharedFingerprintUsers(id),
      [],
      "users.detail.sharedFingerprints",
    ),
  ]);

  if (!data) notFound();
  const userTags = userTagsResult.data;
  const creatorHistory = creatorHistoryResult.data;
  const riskBreakdown = riskResult.data;
  const sharedIps = sharedIpsResult.data;
  const sharedFingerprints = sharedFingerprintsResult.data;

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

  const detailWithSession = {
    ...data,
    sessionRole: session.role,
    capabilities,
    wasCreator,
    creatorSince: creatorHistory.creatorSince,
  };

  return (
    <div className="space-y-4">
      {/* Re-fetch server data every 60s so admins watching a user-detail
          tab don't see stale gaming transactions / balances. router.refresh
          re-runs the page-level fetches and re-renders the whole tree, so
          the active tab's tables update in place without changing tab. */}
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
        gamingTx={gamingTx}
        financialTx={financialTx}
        rewards={rewards}
        notes={notes}
        pnlBreakdown={pnlBreakdown}
        inventory={inventory}
        disposedInventory={disposedInventory}
        riskBreakdown={riskBreakdown}
        sharedIps={sharedIps}
        sharedFingerprints={sharedFingerprints}
        initialTab={initialTab}
      />
    </div>
  );
}
