/**
 * Per-tab async server components. Each one fetches only the data
 * its tab needs (on top of the shared UserDetail it gets via props
 * from page.tsx) and renders the matching client-side tab component.
 *
 * Mounted behind a <Suspense> boundary in page.tsx so the hero +
 * tab bar paint immediately while tab data streams in. Switching
 * tabs via the URL (?tab=X) only fires the new tab's queries —
 * the page's shared UserDetail is reused across tabs because it's
 * resolved synchronously in page.tsx's awaited fetch and threaded
 * down as a prop.
 *
 * AutoRefresh (router.refresh) re-renders the entire route,
 * re-running both the page-level UserDetail fetch and the active
 * tab segment.
 */
import {
  getUserInventory,
  getUserPnlBreakdown,
  getUserRewards,
  getUserTransactions,
} from "@/lib/queries/users";
import { getNotesForUser } from "@/lib/queries/admin-notes";
import { computeRiskScore } from "@/lib/fraud/score";
import {
  getSharedIpUsers,
  getSharedFingerprintUsers,
} from "@/lib/fraud/shared-identity";
import {
  OverviewTab,
  FinancesTab,
  RewardsTab,
  GamingTab,
  InventoryTab,
  AffiliateTab,
  AccountTab,
} from "./user-view-modern-tabs";
import { TrustTab } from "./user-tabs-trust";
import type { UserDetail } from "./user-tabs-types";

// Lifted from page.tsx so each tab segment owns its own type list
// instead of having page.tsx fan them out as props.
const GAMING_TYPES = [
  "pack_opening",
  "battle_bet",
  "battle_sponsorship",
  "battle_refund",
  "upgrader_bet",
  "upgrader_payout",
  "voucher_redeemed",
];
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

// ───────────────────────────────────────────────────────────────────
//  OVERVIEW
// ───────────────────────────────────────────────────────────────────

export async function OverviewTabContent({
  data,
}: {
  data: UserDetail;
}) {
  const [gamingTx, financialTx, pnlBreakdown] = await Promise.all([
    getUserTransactions(data.user.id, 1, 10, { types: GAMING_TYPES }),
    getUserTransactions(data.user.id, 1, 10, { types: FINANCIAL_TYPES }),
    getUserPnlBreakdown(data.user.id),
  ]);
  return (
    <OverviewTab
      data={data}
      gamingTx={gamingTx}
      financialTx={financialTx}
      pnlBreakdown={pnlBreakdown}
      isAdmin={data.sessionRole === "admin"}
    />
  );
}

// ───────────────────────────────────────────────────────────────────
//  GAMING
// ───────────────────────────────────────────────────────────────────

export async function GamingTabContent({ data }: { data: UserDetail }) {
  const gamingTx = await getUserTransactions(data.user.id, 1, 10, {
    types: GAMING_TYPES,
  });
  return <GamingTab data={data} gamingTx={gamingTx} />;
}

// ───────────────────────────────────────────────────────────────────
//  FINANCES
// ───────────────────────────────────────────────────────────────────

export async function FinancesTabContent({ data }: { data: UserDetail }) {
  const financialTx = await getUserTransactions(data.user.id, 1, 10, {
    types: FINANCIAL_TYPES,
  });
  return (
    <FinancesTab
      data={data}
      financialTx={financialTx}
      isAdmin={data.sessionRole === "admin"}
    />
  );
}

// ───────────────────────────────────────────────────────────────────
//  REWARDS
// ───────────────────────────────────────────────────────────────────

export async function RewardsTabContent({ userId }: { userId: string }) {
  const rewards = await getUserRewards(userId);
  return <RewardsTab rewards={rewards} />;
}

// ───────────────────────────────────────────────────────────────────
//  INVENTORY
// ───────────────────────────────────────────────────────────────────

export async function InventoryTabContent({ data }: { data: UserDetail }) {
  const [inventory, disposedInventory] = await Promise.all([
    getUserInventory(data.user.id, 1, 24, { status: "owned" }),
    getUserInventory(data.user.id, 1, 24, { status: "disposed" }),
  ]);
  return (
    <InventoryTab
      data={data}
      inventory={inventory}
      disposedInventory={disposedInventory}
    />
  );
}

// ───────────────────────────────────────────────────────────────────
//  TRUST
// ───────────────────────────────────────────────────────────────────

export async function TrustTabContent({ userId }: { userId: string }) {
  const [breakdown, sharedIps, sharedFingerprints] = await Promise.all([
    computeRiskScore(userId),
    // Fingerprints table may be absent in fresh/dev environments — degrade
    // gracefully to an empty list rather than crashing the trust tab.
    getSharedIpUsers(userId).catch(() => []),
    getSharedFingerprintUsers(userId).catch(() => []),
  ]);
  return (
    <TrustTab
      userId={userId}
      breakdown={breakdown}
      sharedIps={sharedIps}
      sharedFingerprints={sharedFingerprints}
    />
  );
}

// ───────────────────────────────────────────────────────────────────
//  AFFILIATE — no extra fetch beyond UserDetail
// ───────────────────────────────────────────────────────────────────

export function AffiliateTabContent({ data }: { data: UserDetail }) {
  return <AffiliateTab data={data} />;
}

// ───────────────────────────────────────────────────────────────────
//  ACCOUNT
// ───────────────────────────────────────────────────────────────────

export async function AccountTabContent({ data }: { data: UserDetail }) {
  const notes = await getNotesForUser(data.user.id);
  return (
    <AccountTab
      data={data}
      notes={notes}
      isAdmin={data.sessionRole === "admin"}
    />
  );
}
