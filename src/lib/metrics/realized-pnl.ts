import "server-only";

/**
 * realized-pnl.ts — the metric layer's single REFERENCE to the canonical
 * realized-P&L functions.
 *
 * Phase-1 foundation, UNWIRED. Realized P&L is a balance-sheet truth
 * (deposits − withdrawals − onSiteBalance − inventory − vouchers), NOT a
 * gaming-margin metric, and the existing implementations in
 * `src/lib/queries/pnl.ts` and `src/lib/queries/_realized-pnl.ts` are
 * already correct (and cached). We do NOT reinvent them here — we
 * re-export them so a migrated page can import every metric, gaming AND
 * balance-sheet, from `@/lib/metrics` and there is one obvious place to
 * find the realized-P&L source of truth.
 *
 * Canonical formula (house POV, per CLAUDE.md), in `pnl.ts`
 * `computeHousePnl`:
 *
 *   pnl = deposits − withdrawals − onSiteBalance − inventoryValue
 *         − unclaimedVouchers
 *
 * Lifetime global snapshot (`getRealizedPnlSnapshot`) additionally
 * subtracts the unclaimed-rakeback liability. Per-user P&L sticks to the
 * five canonical terms so the User Detail page matches.
 *
 * NOTE (documented divergence, not fixed here — that's a later migration
 * step): `calculateUsersPnlBatch` does NOT apply the
 * `withdrawal_locked_at: null` inventory filter that `calculateUserPnl`
 * does (pnl.ts:293 vs pnl.ts:104), so the users-LIST PnL can differ from
 * the users-DETAIL PnL for users with cards locked for withdrawal. This
 * layer only centralises the reference; reconciling the two is an
 * explicit wiring task, flagged so it is not forgotten.
 */

export {
  computeHousePnl,
  calculateUserPnl,
  calculateUsersPnlBatch,
  calculateWindowedPnl,
  getDailyPnl,
  getPackBattlePurePnl,
} from "@/lib/queries/pnl";

export type {
  PnlComponents,
  UserPnl,
  WindowedPnl,
  DailyPnlPoint,
  PackBattlePnlRow,
  PackBattlePnlWindows,
} from "@/lib/queries/pnl";

export { getRealizedPnlSnapshot } from "@/lib/queries/_realized-pnl";
export type { RealizedPnlSnapshot } from "@/lib/queries/_realized-pnl";
