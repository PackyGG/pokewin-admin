import "server-only";

import { getReadDrizzleDb } from "@/lib/db";
import { queryRows } from "@/lib/drizzle-query";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { escapeBlacklistIds } from "@/lib/queries/_blacklist";

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
  const db = await getReadDrizzleDb();

  // Blacklist gate: drop excluded (staff-flagged / owner-locked) creator ids
  // from this identifiable lifetime withdrawn total. Guarded for the empty set
  // so the SQL stays valid when nothing is excluded. Inlined into a
  // Static whole-table aggregate executed through the Drizzle query adapter.
  // the canonical pre-escaped id list — same shape as the per-deal sibling.
  const excluded = await getExcludedUserIds();
  const blacklistClause =
    excluded.length > 0
      ? `AND v.user_id NOT IN (${escapeBlacklistIds(excluded)})`
      : "";

  const rows = await queryRows<
    {
      withdrawn_completed: string | null;
      withdraw_in_flight: string | null;
    }[]
  >(db,
    `SELECT
      COALESCE(SUM(CASE WHEN best_status = 'completed' THEN value END), 0)::text AS withdrawn_completed,
      COALESCE(SUM(CASE WHEN best_status IN ('pending', 'processing', 'shipped') THEN value END), 0)::text AS withdraw_in_flight
    FROM (
      SELECT DISTINCT ON (v.id)
        v.id,
        v.value,
        wr.status AS best_status
      FROM vouchers v
      JOIN card_withdrawal_requests wr ON v.id = ANY(wr.voucher_ids)
      -- ::text — prod's voucher_origin enum lacks this label; a bare enum
      -- comparison 22P02s the statement (ffa61b5c class). ::text → $0.
      WHERE v.origin::text = 'creator_fill_conversion'
        ${blacklistClause}
        AND wr.status IN ('pending', 'processing', 'shipped', 'completed')
      ORDER BY v.id, CASE wr.status
        WHEN 'completed' THEN 1
        WHEN 'shipped'   THEN 2
        WHEN 'processing' THEN 3
        WHEN 'pending'   THEN 4
      END
    ) t`,
  );

  return {
    withdrawnUsd: Number(rows[0]?.withdrawn_completed ?? 0) || 0,
    withdrawPendingUsd: Number(rows[0]?.withdraw_in_flight ?? 0) || 0,
  };
}
