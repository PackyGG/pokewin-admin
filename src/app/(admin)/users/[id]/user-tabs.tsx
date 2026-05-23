"use client";

import { UserViewModern } from "./user-view-modern";
import type {
  UserDetail,
  PaginatedTransactions,
  PaginatedInventory,
  PnlBreakdown,
  AdminNote,
} from "./user-tabs-types";
import type { UserRewards } from "@/lib/queries/users";
import type { RiskScoreBreakdown } from "@/lib/fraud/score-types";
import type { SharedIdentityUser } from "@/lib/fraud/shared-identity-types";

// ---------------------------------------------------------------------------
// Re-exports — preserve the public surface so existing imports keep working.
// ---------------------------------------------------------------------------
export type {
  UserDetail,
  PaginatedTransactions,
  PnlBreakdown,
  AdminNote,
} from "./user-tabs-types";
export {
  GAMING_TX_TYPES,
  FINANCIAL_TX_TYPES,
  CARD_SALE_TX_TYPES,
  EXCHANGE_TX_TYPES,
} from "./user-tabs-types";
export {
  BalanceSummaryCard,
  PnlCard,
  ActivityStatsCard,
  RewardsCard,
  FeatureLocksCard,
  AccountDetailsSection,
  BalanceHistoryChart,
  NotesSection,
} from "./user-tabs-cards";
export { CategoryTransactionsTable } from "./user-tabs-transactions";
export { InventoryGrid, DisposedCardsTable } from "./user-tabs-inventory";
export { CreatorSection } from "./user-tabs-creator";
export { ModerationSection } from "./user-tabs-moderation";

export function UserTabs({
  data,
  inventory,
  disposedInventory,
  pnlBreakdown,
  notes,
  gamingTx,
  financialTx,
  rewards,
  riskBreakdown,
  sharedIps,
  sharedFingerprints,
}: {
  data: UserDetail;
  inventory: PaginatedInventory;
  disposedInventory: PaginatedInventory;
  pnlBreakdown: PnlBreakdown;
  notes: AdminNote[];
  gamingTx: PaginatedTransactions;
  financialTx: PaginatedTransactions;
  rewards: UserRewards;
  riskBreakdown: RiskScoreBreakdown;
  sharedIps: SharedIdentityUser[];
  sharedFingerprints: SharedIdentityUser[];
}) {
  // Classic view was removed — UserTabs now always renders the modern
  // user detail page. The wrapper is kept for backwards-compatible call
  // sites (page.tsx) and type stability.
  return (
    <UserViewModern
      data={data}
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
    />
  );
}
