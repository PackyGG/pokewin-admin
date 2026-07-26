import "server-only";

import { cache } from "react";
import { sql } from "drizzle-orm";
import { adminDrizzle } from "@/lib/admin-db";

/** Active admin_users.id for username `motha` (case-insensitive). */
export const getMothaAdminUserId = cache(async (): Promise<string | null> => {
  const result = await adminDrizzle.execute<{ id: string }>(sql`
    SELECT id
    FROM admin_users
    WHERE LOWER(username) = 'motha'
      AND is_active = true
    LIMIT 1
  `);
  return result.rows[0]?.id ?? null;
});

/**
 * Ledger tx ids for balance adjustments motha made to `targetUserId`,
 * sourced from admin_balance_adjustment_meta (authoritative admin actor).
 */
export async function getMothaAdjustmentLedgerTxIdsForUser(
  targetUserId: string,
): Promise<string[]> {
  const mothaId = await getMothaAdminUserId();
  if (!mothaId) return [];

  const result = await adminDrizzle.execute<{ ledger_tx_id: string }>(sql`
    SELECT ledger_tx_id
    FROM admin_balance_adjustment_meta
    WHERE target_user_id = ${targetUserId}
      AND admin_user_id = ${mothaId}
    ORDER BY created_at DESC
  `);

  return result.rows.map((r) => r.ledger_tx_id);
}
