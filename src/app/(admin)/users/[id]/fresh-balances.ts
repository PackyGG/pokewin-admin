import "server-only";

import { getPrimaryDrizzleDb } from "@/lib/db";
import { queryRows } from "@/lib/drizzle-query";
import {
  officialStreamAdjustmentSqlPredicate,
  removeLockedBalanceAdjustmentSqlPredicate,
} from "@/lib/balance-adjustment-categories";
import { toNumber } from "@/lib/utils/decimal";

export type FreshUserBalances = {
  availableBalance: number;
  availableBalanceRaw: number;
  lockedBalance: number;
  unlockAt: string | null;
  inventoryValue: number;
  vouchersValue: number;
};

/**
 * Uncached, authoritative balance-box read.
 *
 * The larger user-detail aggregate intentionally uses the MAIN mirror and a
 * short cache. This small primary read provides read-after-write consistency
 * and prevents a lagging mirror value from being cached again after refresh.
 */
export async function readFreshUserBalances(
  userId: string,
): Promise<FreshUserBalances | null> {
  const db = await getPrimaryDrizzleDb();
  const officialStream = officialStreamAdjustmentSqlPredicate({
    typeColumn: "lt.type",
    metadataColumn: "lt.metadata",
  });
  const removeLocked = removeLockedBalanceAdjustmentSqlPredicate({
    typeColumn: "lt.type",
    metadataColumn: "lt.metadata",
  });

  type Row = {
    available_balance: string;
    locked_balance: string;
    unlock_at: Date | string | null;
    inventory_value: string;
    voucher_value: string;
    official_stream: string;
    remove_locked: string;
  };

  const [row] = await queryRows<Row[]>(
    db,
    `SELECT
       b.available_balance::text AS available_balance,
       b.locked_balance::text AS locked_balance,
       b.unlock_at,
       COALESCE((SELECT SUM(ui.value_at_obtained::numeric)
                 FROM user_inventory ui
                 JOIN "user" u ON u.id = ui.user_id
                 WHERE ui.user_id = $1
                   AND ui.sold_at IS NULL
                   AND ui.exchanged_at IS NULL
                   AND ui.withdrawal_locked_at IS NULL
                   AND u.role::text <> 'creator'), 0)::text AS inventory_value,
       COALESCE((SELECT SUM(v.value::numeric)
                 FROM vouchers v
                 WHERE v.user_id = $1 AND v.claimed_at IS NULL), 0)::text AS voucher_value,
       COALESCE((SELECT SUM(lt.amount::numeric)
                 FROM ledger_transactions lt
                 WHERE lt.user_id = $1
                   AND lt.status::text = 'completed'
                   AND ${officialStream}), 0)::text AS official_stream,
       COALESCE((SELECT SUM(lt.amount::numeric)
                 FROM ledger_transactions lt
                 WHERE lt.user_id = $1
                   AND lt.status::text = 'completed'
                   AND ${removeLocked}), 0)::text AS remove_locked
     FROM balances b
     WHERE b.user_id = $1`,
    userId,
  );

  if (!row) return null;

  const availableBalanceRaw = toNumber(row.available_balance);
  return {
    availableBalance: Math.max(
      0,
      availableBalanceRaw -
        toNumber(row.official_stream) -
        toNumber(row.remove_locked),
    ),
    availableBalanceRaw,
    lockedBalance: toNumber(row.locked_balance),
    unlockAt: row.unlock_at ? new Date(row.unlock_at).toISOString() : null,
    inventoryValue: toNumber(row.inventory_value),
    vouchersValue: toNumber(row.voucher_value),
  };
}
