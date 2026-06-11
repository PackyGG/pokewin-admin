import "server-only";

import { getDb } from "@/lib/db";

/**
 * Per-deal "withdrawn from converted" breakdown — of the conversion
 * payout vouchers minted under each deal (vouchers.origin =
 * 'creator_fill_conversion', metadata.deal_id = dealId), how much has
 * actually left the platform via a card_withdrawal_requests row,
 * split into:
 *
 *   - withdrawnUsd: terminal — wr.status = 'completed'
 *   - withdrawPendingUsd: in-flight — wr.status IN
 *     ('pending', 'processing', 'shipped')
 *
 * This is the "of the converted amount, how much actually walked out
 * the door" sub-metric that the Converted stat on the creators card
 * grid contextualises with. Together they let the admin tell apart
 * "creator converted but kept playing" from "creator converted and
 * cashed out".
 *
 * Dedupe is per-voucher with DISTINCT ON: if a voucher accidentally
 * appears in multiple non-cancelled requests (retry path, status
 * cycling), the most-progressed status wins so the totals don't
 * double-count.
 *
 * Keyed on `user_id` (not deal_id) so callers can `.get(creatorId)`
 * exactly like the sibling `getDealCapInfoByUser` helper.
 *
 * Single round-trip; passing N deals = one query with two arrays.
 */
export type WithdrawnFromConverted = {
  withdrawnUsd: number;
  withdrawPendingUsd: number;
};

export async function getWithdrawnFromConvertedByDeal(
  deals: { userId: string; dealId: string }[],
): Promise<Map<string, WithdrawnFromConverted>> {
  const result = new Map<string, WithdrawnFromConverted>();
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
    withdrawn_completed: string | null;
    withdraw_in_flight: string | null;
  };

  const rows = await db.$queryRawUnsafe<Row[]>(
    `SELECT
        deal_id,
        COALESCE(SUM(CASE WHEN best_status = 'completed' THEN value END), 0)::text AS withdrawn_completed,
        COALESCE(SUM(CASE WHEN best_status IN ('pending', 'processing', 'shipped') THEN value END), 0)::text AS withdraw_in_flight
      FROM (
        SELECT DISTINCT ON (v.id)
          v.id,
          v.value,
          v.metadata->>'deal_id' AS deal_id,
          wr.status AS best_status
        FROM vouchers v
        JOIN card_withdrawal_requests wr ON v.id = ANY(wr.voucher_ids)
        WHERE v.user_id = ANY($1::text[])
          -- ::text — prod's voucher_origin enum lacks this label; a bare
          -- enum comparison 22P02s the statement (ffa61b5c class).
          AND v.origin::text = 'creator_fill_conversion'
          AND v.metadata->>'deal_id' = ANY($2::text[])
          AND wr.status IN ('pending', 'processing', 'shipped', 'completed')
        ORDER BY v.id, CASE wr.status
          WHEN 'completed' THEN 1
          WHEN 'shipped'   THEN 2
          WHEN 'processing' THEN 3
          WHEN 'pending'   THEN 4
        END
      ) t
      GROUP BY deal_id`,
    userIds,
    dealIds,
  );

  for (const row of rows) {
    const userId = userByDeal.get(row.deal_id);
    if (!userId) continue;
    result.set(userId, {
      withdrawnUsd: Number(row.withdrawn_completed ?? 0),
      withdrawPendingUsd: Number(row.withdraw_in_flight ?? 0),
    });
  }

  return result;
}
