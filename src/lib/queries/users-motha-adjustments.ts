import "server-only";

import { cache } from "react";
import { adminDb } from "@/lib/admin-db";
import { ensureBalanceAdjustmentMetaSchema } from "@/lib/balance-adjustment-meta/ensure-schema";

/** Active admin_users.id for username `motha` (case-insensitive). */
export const getMothaAdminUserId = cache(async (): Promise<string | null> => {
  const user = await adminDb.admin_users.findFirst({
    where: {
      username: { equals: "motha", mode: "insensitive" },
      is_active: true,
    },
    select: { id: true },
  });
  return user?.id ?? null;
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

  await ensureBalanceAdjustmentMetaSchema();

  const rows = await adminDb.admin_balance_adjustment_meta.findMany({
    where: {
      target_user_id: targetUserId,
      admin_user_id: mothaId,
    },
    select: { ledger_tx_id: true },
    orderBy: { created_at: "desc" },
  });

  return rows.map((r) => r.ledger_tx_id);
}
