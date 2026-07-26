import "server-only";

import { sql } from "drizzle-orm";
import { getDrizzleDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";

/** One fill-program conversion payout minted in the window. */
export type ConvertedFillSessionRow = {
  /** Main-DB voucher id (`creator_fill_conversion`). */
  voucherId: string;
  sessionId: string | null;
  dealId: string | null;
  userId: string;
  username: string | null;
  /** When the payout voucher was minted (`vouchers.created_at`). */
  convertedAtIso: string;
  /** `vouchers.value` — the house cost recognized at conversion. */
  amountUsd: number;
};

/**
 * Fill-program conversion payouts minted in `[since, now)` — the canonical
 * "creator ended the session and received a payout voucher" event.
 *
 * Reads `vouchers.origin = 'creator_fill_conversion'` from the Main DB (the
 * same source as `/creators` "Converted" and per-creator fill-payout cost).
 * This is more reliable than fanning out to the backend sessions API:
 *   • No `role = 'creator'` roster filter (voucher origin is creator-only).
 *   • No pagination caps across hundreds of creators.
 *   • Amount is the minted voucher value (what the house owes), which
 *     matches operator-facing session tables even when backend
 *     `converted_to_raw_usd` drifts.
 *
 * Multiplier deal payouts stay separate (`creator_multiplier_payout`).
 *
 * SCOPE: the admin-managed `excluded_users` BLACKLIST is applied to the
 * receiving `user_id` so a blacklisted recipient never appears (matching the
 * dashboard Creators-Costs card + withdrawals drilldown that consume this).
 * Staff/creator roles are NOT dropped — creators are the legitimate subject.
 */
export async function getConvertedFillSessionsInWindow(
  since: Date,
): Promise<ConvertedFillSessionRow[]> {
  const db = await getDrizzleDb();
  const excludedIds = await getExcludedUserIds();

  type Row = {
    voucher_id: string;
    user_id: string;
    username: string | null;
    amount: string;
    minted_at: Date;
    deal_id: string | null;
    session_id: string | null;
  };

  const blacklistFilter =
    excludedIds.length === 0
      ? sql``
      : sql`AND v.user_id NOT IN (${sql.join(
          [...excludedIds].map((id) => sql`${id}`),
          sql`, `,
        )})`;
  const result = await db.execute<Row>(sql`
     SELECT
       v.id AS voucher_id,
       v.user_id,
       u.username,
       v.value::numeric AS amount,
       v.created_at AS minted_at,
       v.metadata->>'deal_id' AS deal_id,
       v.metadata->>'session_id' AS session_id
     FROM vouchers v
     LEFT JOIN "user" u ON u.id = v.user_id
     WHERE v.origin::text = 'creator_fill_conversion'
       AND v.created_at >= ${since}
       ${blacklistFilter}
     ORDER BY v.created_at DESC
  `);
  const rows = result.rows;

  return rows.map((r) => ({
    voucherId: r.voucher_id,
    sessionId: r.session_id,
    dealId: r.deal_id,
    userId: r.user_id,
    username: r.username,
    convertedAtIso: new Date(r.minted_at).toISOString(),
    amountUsd: toNumber(r.amount),
  }));
}

export function sumConvertedFillSessions(
  rows: ConvertedFillSessionRow[],
): number {
  return rows.reduce((sum, r) => sum + r.amountUsd, 0);
}
