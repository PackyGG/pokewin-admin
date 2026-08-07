/**
 * Public surface for the user-detail tabs module. Originally this
 * file housed a `UserTabs` wrapper that took every per-tab dataset
 * up-front and switched between Modern / Classic views client-side.
 *
 * After the deferred-tabs refactor:
 *   - page.tsx mounts each tab's data behind its own <Suspense> and
 *     renders <UserViewModern> directly. The wrapper is therefore
 *     no longer needed.
 *   - The re-exports below preserve the type + section-component
 *     surface that user-view-modern.tsx and user-view-modern-tabs.tsx
 *     pull from, so internal callers stay on the same import path.
 *
 * Keep this file as the one-stop import — splitting the re-exports
 * across the source modules would force each consumer to know which
 * sub-file owns which symbol.
 */
export type {
  UserDetail,
  PaginatedTransactions,
  PnlBreakdown,
  
} from "./user-tabs-types";
export {
  GAMING_TX_TYPES,
  FINANCIAL_TX_TYPES,
  ADJUSTMENT_TX_TYPES,
  
  
} from "./user-tabs-types";
export {
  
  
  
  
  FeatureLocksCard,
  AccountDetailsSection,
  
  
} from "./user-tabs-cards";
// Shared with the /users list column (Signup) — one display mapping for
// `account.providerId`, not two.
export { formatSignupProvider } from "@/lib/utils/signup-provider";
export { CategoryTransactionsTable } from "./user-tabs-transactions";
export { InventoryGrid, DisposedCardsTable } from "./user-tabs-inventory";
;
;
