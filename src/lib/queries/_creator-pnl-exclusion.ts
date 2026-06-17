import "server-only";

/**
 * Creator-inventory carve-out from the canonical house-P&L formula
 * (owner decision 2026-06-17).
 *
 * A `role = 'creator'` user's open card inventory is overwhelmingly
 * house-funded sponsored stream play, NOT a real customer holding. Counting
 * it in the P&L `inventoryValue` (lifetime) / `inventoryChange` (windowed)
 * liability term shows a phantom live house loss until the creator ends the
 * stream and the holdings convert to a streamer voucher
 * (`voucher_origin` = creator_fill_conversion / creator_multiplier_payout) —
 * which DOES stay counted via the `unclaimedVouchers` term, so the real cost
 * lands exactly at conversion.
 *
 * Therefore the inventory term EXCLUDES rows owned by a creator, EVERYWHERE
 * the canonical house P&L is computed (user detail, users-list, dashboard
 * P&L Today / movers / daily chart, rolling per-user ladder, period delta).
 * The balance + voucher + deposit + withdrawal terms are UNAFFECTED — only
 * the inventory liability is dropped. Applied with an identical predicate on
 * Postgres and every ClickHouse twin so CQRS parity holds automatically
 * (the `role` column exists in both engines; see the ClickHouse helper
 * `nonCreatorOwnerCh` in `clickhouse/queries/_shared.ts`).
 *
 * Postgres SQL predicate — keeps a row ONLY if its owner is not a creator.
 * `userIdCol` is the inventory / ledger row's user-id column, e.g.
 * `ui.user_id` or `lt.user_id`. The `role = 'creator'` subquery is a small
 * anti-membership set served by the `"user"` PK / role index.
 */
export function nonCreatorOwnerSql(userIdCol: string): string {
  return `${userIdCol} NOT IN (SELECT id FROM "user" WHERE role = 'creator')`;
}
