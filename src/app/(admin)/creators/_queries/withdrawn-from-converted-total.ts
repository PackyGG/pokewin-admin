import "server-only";

import { getDb } from "@/lib/db";

/**
 * LIFETIME, ALL-CREATORS "withdrawn from converted" total — of every
 * conversion payout voucher ever minted (`vouchers.origin =
 * 'creator_fill_conversion'`), how much has actually left the platform via
 * a `card_withdrawal_requests` row, with NO deal / active-deal filter:
 *
 *   - withdrawnUsd: terminal — wr.status = 'completed'
 *   - withdrawPendingUsd: in-flight — wr.status IN
 *     ('pending', 'processing', 'shipped')
 *
 * ─── WHY NO DEAL FILTER (owner scope decision) ───────────────────────
 *
 * This is the all-creators / lifetime counterpart to the per-deal
 * `getWithdrawnFromConvertedByDeal` (which stays deal-scoped for the
 * per-creator card chips). It reads the SAME `creator_fill_conversion`
 * voucher set as `getConvertedFromVouchersTotal`, just the subset that has
 * a completed/in-flight withdrawal request, so the /creators "Converted"
 * tile's invariant `withdrawn ≤ converted` still holds across the lifetime
 * figure.
 *
 * Dedupe is per-voucher with DISTINCT ON: if a voucher appears in multiple
 * non-cancelled requests (retry path, status cycling), the most-progressed
 * status wins so the totals don't double-count — identical to the per-deal
 * helper.
 *
 * Single round-trip, no bind parameters (whole-table aggregate over a
 * fixed origin enum literal + a fixed status set).
 */
export type WithdrawnFromConvertedTotal = {
  withdrawnUsd: number;
  withdrawPendingUsd: number;
};

export async function getWithdrawnFromConvertedTotal(): Promise<WithdrawnFromConvertedTotal> {
  const db = await getDb();

  const rows = await db.$queryRaw<
    {
      withdrawn_completed: string | null;
      withdraw_in_flight: string | null;
    }[]
  >`
    SELECT
      COALESCE(SUM(CASE WHEN best_status = 'completed' THEN value END), 0)::text AS withdrawn_completed,
      COALESCE(SUM(CASE WHEN best_status IN ('pending', 'processing', 'shipped') THEN value END), 0)::text AS withdraw_in_flight
    FROM (
      SELECT DISTINCT ON (v.id)
        v.id,
        v.value,
        wr.status AS best_status
      FROM vouchers v
      JOIN card_withdrawal_requests wr ON v.id = ANY(wr.voucher_ids)
      WHERE v.origin = 'creator_fill_conversion'
        AND wr.status IN ('pending', 'processing', 'shipped', 'completed')
      ORDER BY v.id, CASE wr.status
        WHEN 'completed' THEN 1
        WHEN 'shipped'   THEN 2
        WHEN 'processing' THEN 3
        WHEN 'pending'   THEN 4
      END
    ) t
  `;

  return {
    withdrawnUsd: Number(rows[0]?.withdrawn_completed ?? 0) || 0,
    withdrawPendingUsd: Number(rows[0]?.withdraw_in_flight ?? 0) || 0,
  };
}
