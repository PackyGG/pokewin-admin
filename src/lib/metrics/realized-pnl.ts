import "server-only";

/**
 * realized-pnl.ts — the metric layer's single REFERENCE to the canonical
 * realized-P&L functions.
 *
 * WIRED. Realized P&L is a balance-sheet truth (deposits − withdrawals −
 * onSiteBalance − inventory − vouchers), NOT a gaming-margin metric, and
 * the existing implementations in `src/lib/queries/pnl.ts` and
 * `src/lib/queries/_realized-pnl.ts` are already correct (and cached). We
 * do NOT reinvent them here — we re-export them (e.g. `calculateWindowedPnl`,
 * consumed live by insights-analytics' cost-breakdown and money-flow) so a
 * page can import every metric, gaming AND balance-sheet, from
 * `@/lib/metrics` and there is one obvious place to find the realized-P&L
 * source of truth.
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
 * LIST/DETAIL P&L PARITY (M10 — closed): `calculateUsersPnlBatch` applies
 * the SAME inventory filters as `calculateUserPnl` —
 * `status IN WITHDRAWAL_LIABILITY_STATUSES` (pnl.ts:341) and
 * `withdrawal_locked_at: null` (pnl.ts:357), matching pnl.ts:146/161 on the
 * detail side — so the users-LIST P&L equals the users-DETAIL P&L even for
 * users with cards locked for withdrawal.
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
