import "server-only";

import { getDb } from "@/lib/db";

/**
 * LIFETIME, ALL-CREATORS "Converted" total — the combined value of every
 * end-of-session payout voucher (`vouchers.origin =
 * 'creator_fill_conversion'`, §2 of the creator model: the "stream payout
 * voucher") ever minted, across EVERY creator, with NO deal / active-deal
 * filter.
 *
 * ─── WHY NO DEAL FILTER (owner scope decision) ───────────────────────
 *
 * The previous "Converted" tile was scoped to creators with an
 * ACTIVE/scheduled deal (`metadata->>'deal_id' = ANY(activeDeals)`). The
 * owner moved it to a lifetime, all-creators figure: how much stream
 * earnings have EVER been converted into payout vouchers, not just for
 * creators currently on a live deal.
 *
 * The `creator_fill_conversion` origin is itself creator-only (it is the
 * weekly-fill payout voucher), so summing every voucher of that origin IS
 * "across all creators ever" — no `user.role = 'creator'` join is needed
 * (it would only narrow to current role-holders and drop ex-creators'
 * historical conversions, which the lifetime figure should keep). This is
 * the SAME origin + value source the per-creator detail-page cost
 * (`getCreatorFillConversionCost`) reads — just unscoped to all creators.
 *
 * Shares its voucher set with `getWithdrawnFromConvertedTotal` (which sums
 * the subset of these vouchers that left the platform via a completed
 * withdrawal request), so the tile's invariant `withdrawn ≤ converted`
 * holds by construction.
 *
 * Single round-trip, no bind parameters needed (no dynamic input — it is a
 * whole-table aggregate over a fixed origin enum literal).
 */
export async function getConvertedFromVouchersTotal(): Promise<number> {
  const db = await getDb();

  const rows = await db.$queryRaw<{ converted: string | null }[]>`
    SELECT COALESCE(SUM(v.value::numeric), 0)::text AS converted
    FROM vouchers v
    WHERE v.origin = 'creator_fill_conversion'
  `;

  return Number(rows[0]?.converted ?? 0) || 0;
}
