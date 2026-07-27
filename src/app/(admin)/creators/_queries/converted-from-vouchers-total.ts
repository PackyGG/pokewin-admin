import "server-only";

import { getReadDrizzleDb } from "@/lib/db";
import { queryRows } from "@/lib/drizzle-query";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { escapeBlacklistIds } from "@/lib/queries/_blacklist";

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
 * holds by construction. Both apply the SAME admin-managed `excluded_users`
 * blacklist to `v.user_id` so the invariant holds on ONE population — the
 * withdrawn (numerator) sibling already blacklists, so this converted
 * (denominator) leg must too or a blacklisted creator's converted vouchers
 * would inflate the total and understate the withdrawn %.
 *
 * Single round-trip, no bind parameters needed (no dynamic input — it is a
 * whole-table aggregate over a fixed origin enum literal + the inlined,
 * pre-escaped blacklist id list).
 */
export async function getConvertedFromVouchersTotal(): Promise<number> {
  const db = await getReadDrizzleDb();

  // Blacklist gate: drop excluded (owner-locked) creator ids from this
  // identifiable lifetime converted total — mirrors the withdrawn sibling
  // (`getWithdrawnFromConvertedTotal`) and the `/dashboard` "Creators Costs
  // (today)" twin so a blacklisted recipient never appears ANYWHERE. Guarded
  // for the empty set so the SQL stays valid when nothing is excluded;
  // inlined via the canonical pre-escaped id list (whole-table aggregate, no
  // bind params).
  const excluded = await getExcludedUserIds();
  const blacklistClause =
    excluded.length > 0
      ? `AND v.user_id NOT IN (${escapeBlacklistIds(excluded)})`
      : "";

  // `origin` compared via ::text (NOT the bare enum): the generated
  // `voucher_origin` type is AHEAD of live prod, which does not yet carry
  // the 'creator_fill_conversion' label — a bare enum comparison against an
  // unknown label throws 22P02 at parse time (the ffa61b5c failure class)
  // and broke the /creators "Converted" KPI. ::text compares false instead,
  // so the tile shows an honest $0 until prod gains the label.
  const rows = await queryRows<{ converted: string | null }[]>(db,
    `SELECT COALESCE(SUM(v.value::numeric), 0)::text AS converted
    FROM vouchers v
    WHERE v.origin::text = 'creator_fill_conversion'
      ${blacklistClause}`,
  );

  return Number(rows[0]?.converted ?? 0) || 0;
}
