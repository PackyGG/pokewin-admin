import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getUserDetail, getUserTransactions, getUserAuditLog, getUserInventory, getUserPnlBreakdown, getUserRewards } from "@/lib/queries/users";
import { getNotesForUser } from "@/lib/queries/admin-notes";
import { getUserTags } from "@/lib/queries/user-tags";
import { requirePageAccess, getUserPermissions } from "@/lib/dal";
import { hasCapability } from "@/app/(admin)/settings/roles/permissions-utils";
import { UserTabs } from "./user-tabs";
import { UserTagsPanel } from "./user-tags-panel";
import { computeRiskScore } from "@/lib/fraud/score";
import {
  getSharedIpUsers,
  getSharedFingerprintUsers,
} from "@/lib/fraud/shared-identity";

export const metadata = { title: "User Detail" };

export default async function UserDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requirePageAccess("/users");
  const { id } = await params;
  const sp = await searchParams;
  const txPage = Math.max(1, Number(sp.txPage) || 1);
  const txPerPage = [10, 20, 50, 100].includes(Number(sp.txPerPage))
    ? Number(sp.txPerPage)
    : 20;
  const auditPage = Math.max(1, Number(sp.auditPage) || 1);
  const auditPerPage = [10, 20, 50, 100].includes(Number(sp.auditPerPage))
    ? Number(sp.auditPerPage)
    : 20;

  const GAMING_TYPES = ["pack_opening", "battle_bet", "battle_sponsorship", "battle_refund", "voucher_redeemed"];
  const FINANCIAL_TYPES = ["deposit", "deposit_bonus", "admin_balance_adjustment", "card_withdrawal", "withdrawal_shipping_fee", "rakeback_claim", "balance_reward_claim", "affiliate_claim", "promo_code_redeemed", "gift_card_redeemed", "rain_win", "race_prize"];
  const CARD_SALE_TYPES = ["card_sale", "reward_card_sale"];
  const EXCHANGE_TYPES = ["card_exchange", "exchange_excess_to_voucher", "exchange_excess_credit", "battle_excess_to_voucher", "voucher_exchange"];

  // Resolve permissions in parallel with the data queries — admins can
  // skip the permissions fetch entirely (they get all capabilities by
  // definition), so only non-admins trigger the extra round-trip. Previously
  // this was awaited inside the JSX after the main Promise.all, adding
  // a serial round-trip to the page's time-to-render.
  const [data, transactions, auditLog, inventory, disposedInventory, pnlBreakdown, notes, gamingTx, financialTx, rewards, riskBreakdown, sharedIps, sharedFingerprints, permissions, userTags] = await Promise.all([
    getUserDetail(id),
    getUserTransactions(id, txPage, txPerPage, {
      type: typeof sp.txType === "string" ? sp.txType : undefined,
      status: typeof sp.txStatus === "string" ? sp.txStatus : undefined,
      dateFrom: typeof sp.txFrom === "string" ? sp.txFrom : undefined,
      dateTo: typeof sp.txTo === "string" ? sp.txTo : undefined,
    }),
    getUserAuditLog(id, auditPage, auditPerPage, {
      eventType: typeof sp.auditEventType === "string" ? sp.auditEventType : undefined,
    }),
    getUserInventory(id, 1, 24, { status: "owned" }),
    getUserInventory(id, 1, 24, { status: "disposed" }),
    getUserPnlBreakdown(id),
    getNotesForUser(id),
    getUserTransactions(id, 1, 10, { types: GAMING_TYPES }),
    getUserTransactions(id, 1, 10, { types: FINANCIAL_TYPES }),
    getUserRewards(id),
    // Fraud / trust assessment. Heavy aggregation — cached in-memory
    // for 60s so moderators clicking around the user don't re-run it.
    computeRiskScore(id),
    // Fingerprints table may be absent in fresh/dev environments — degrade
    // gracefully to an empty list rather than crashing the user detail page.
    getSharedIpUsers(id).catch(() => []),
    getSharedFingerprintUsers(id).catch(() => []),
    session.role === "admin" ? Promise.resolve(null) : getUserPermissions(session.userId),
    // VIP tags (admin-CRM metadata). Single round-trip to adminDb;
    // joins to admin_users so the panel tooltip can show who set
    // each tag. Always fetched — the panel renders read-only for
    // viewers without __can_manage_user_tags.
    getUserTags(id),
  ]);

  if (!data) notFound();

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

  return (
    <div className="space-y-4">
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
      <UserTabs data={{ ...data, sessionRole: session.role, capabilities }} transactions={transactions} auditLog={auditLog} inventory={inventory} disposedInventory={disposedInventory} pnlBreakdown={pnlBreakdown} notes={notes} gamingTx={gamingTx} financialTx={financialTx} rewards={rewards} riskBreakdown={riskBreakdown} sharedIps={sharedIps} sharedFingerprints={sharedFingerprints} />
    </div>
  );
}
