import "server-only";

import { getDb } from "@/lib/db";

/**
 * Per-deal "converted to payout vouchers" total — the TRUE amount of
 * stream earnings each deal has minted into end-of-session payout
 * vouchers (the `creator_fill_conversion` lifecycle, §2 of the creator
 * model: "stream payout voucher").
 *
 * Source: Main DB `vouchers` where
 *   - origin = 'creator_fill_conversion'      (the end-session payout)
 *   - metadata.deal_id = <dealId>             (tied to this deal)
 *
 * This is the SAME voucher set + scope the sibling
 * `getWithdrawnFromConvertedByDeal` reads — it sums the *minted* value,
 * while that helper sums the subset of those vouchers that left the
 * platform via a completed `card_withdrawal_request`. Sharing one
 * source guarantees the invariant the "Converted" tile relies on:
 * `withdrawn ≤ converted` (withdrawn is a subset of these vouchers).
 *
 * Why NOT the backend deal's `withdraw_cap_used_usd`: that field is the
 * deal's withdraw-CAP consumption counter — admin-mutable (it's an
 * explicit `UpdateDealInput.patch.withdraw_cap_used_usd` override), per
 * deal-VERSION, and a running ceiling-usage figure, NOT the minted
 * voucher total. It is the wrong source for a "Converted to payout
 * vouchers" figure (the per-card stat was already relabeled away from
 * "Converted" to "Cap used" for exactly this reason). Reading the real
 * minted vouchers makes the figure mean what the label says.
 *
 * Keyed on `user_id` (not deal_id) so callers can `.get(creatorId)`
 * exactly like the sibling `getWithdrawnFromConvertedByDeal` helper.
 *
 * Single round-trip; passing N deals = one query with two arrays.
 */
export async function getConvertedFromVouchersByDeal(
  deals: { userId: string; dealId: string }[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (deals.length === 0) return result;

  const userIds = deals.map((d) => d.userId);
  const dealIds = deals.map((d) => d.dealId);

  const db = await getDb();

  // Deal -> user_id back-map, so the SQL only needs to return one
  // (user_id, deal_id) row per deal and we can key the result by
  // user_id without a re-lookup at the call site.
  const userByDeal = new Map<string, string>();
  for (const d of deals) userByDeal.set(d.dealId, d.userId);

  type Row = {
    deal_id: string;
    converted: string | null;
  };

  const rows = await db.$queryRawUnsafe<Row[]>(
    `SELECT
        v.metadata->>'deal_id' AS deal_id,
        COALESCE(SUM(v.value::numeric), 0)::text AS converted
      FROM vouchers v
      WHERE v.user_id = ANY($1::text[])
        AND v.origin = 'creator_fill_conversion'
        AND v.metadata->>'deal_id' = ANY($2::text[])
      GROUP BY v.metadata->>'deal_id'`,
    userIds,
    dealIds,
  );

  for (const row of rows) {
    const userId = userByDeal.get(row.deal_id);
    if (!userId) continue;
    result.set(userId, Number(row.converted ?? 0));
  }

  return result;
}
