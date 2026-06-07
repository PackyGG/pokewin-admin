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
import {
  getUserWagerRequirement,
  type UserWagerRequirement,
} from "@/lib/backend-api/wager-requirements";
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
// Dedicated uncapped admin_balance_adjustment fetch — see page.tsx
// (ADJUSTMENT_TYPES / ADJ_LIMIT) for the full rationale. Keeps every
// adjustment available to the Overview feed independent of the shared
// 10-row financial page.
const ADJUSTMENT_TYPES = ["admin_balance_adjustment"];
const ADJ_LIMIT = 200;

// ───────────────────────────────────────────────────────────────────
//  OVERVIEW
// ───────────────────────────────────────────────────────────────────

export async function OverviewTabContent({
  data,
}: {
  data: UserDetail;
}) {
  const [gamingTx, financialTx, adjustmentsTx, pnlBreakdown] =
    await Promise.all([
      getUserTransactions(data.user.id, 1, 10, { types: GAMING_TYPES }),
      getUserTransactions(data.user.id, 1, 10, { types: FINANCIAL_TYPES }),
      getUserTransactions(data.user.id, 1, ADJ_LIMIT, {
        types: ADJUSTMENT_TYPES,
      }),
      getUserPnlBreakdown(data.user.id),
    ]);
  return (
    <OverviewTab
      data={data}
      gamingTxPromise={Promise.resolve(gamingTx)}
      financialTxPromise={Promise.resolve(financialTx)}
      adjustmentsTxPromise={Promise.resolve(adjustmentsTx)}
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
  return (
    <GamingTab data={data} gamingTxPromise={Promise.resolve(gamingTx)} />
  );
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
      financialTxPromise={Promise.resolve(financialTx)}
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
  // Owned inventory is awaited (critical — drives the grid + values);
  // the disposed page is handed to InventoryTab as an in-flight promise so
  // its "Sold & Exchanged" table streams behind the tab's inner Suspense
  // rather than blocking the owned grid. Mirrors page.tsx's split.
  const inventory = await getUserInventory(data.user.id, 1, 24, {
    status: "owned",
  });
  const disposedInventoryPromise = getUserInventory(data.user.id, 1, 24, {
    status: "disposed",
  });
  return (
    <InventoryTab
      data={data}
      inventory={inventory}
      disposedInventoryPromise={disposedInventoryPromise}
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
  // Account tab now renders a Windowed P&L strip directly under the
  // wagering stats, so we need the same pnlBreakdown the Overview tab
  // consumes. Fetched in parallel with the notes so the tab paints in
  // a single round-trip.
  const [notes, pnlBreakdown] = await Promise.all([
    getNotesForUser(data.user.id),
    getUserPnlBreakdown(data.user.id),
  ]);
  // Per-user withdrawal wager-requirement override (backend API). Read
  // non-critically so an undeployed backend branch can't crash this tab —
  // null degrades the card to its "awaiting backend deploy" state.
  let wagerRequirement: UserWagerRequirement | null = null;
  try {
    wagerRequirement = await getUserWagerRequirement(data.user.id);
  } catch {
    wagerRequirement = null;
  }
  return (
    <AccountTab
      data={data}
      notes={notes}
      pnlBreakdown={pnlBreakdown}
      wagerRequirement={wagerRequirement}
    />
  );
}
