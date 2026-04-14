import { db } from "@/lib/db";

/**
 * Lifetime realized P&L from the house perspective — a balance-sheet snapshot.
 *
 * Single source of truth for the Dashboard and Analytics pages so the two
 * can never drift. Mirrors the per-user P&L definition in
 * src/lib/queries/users.ts (there it's user-profit, here it's house-profit,
 * so the sign is flipped).
 *
 *   pnl =   total deposits
 *         − total withdrawals (balances.total_withdrawn + shipped/completed
 *                              card_withdrawal_requests)
 *         − current user balance (available + locked)
 *         − unsold, non-exchanged inventory
 *         − unclaimed vouchers
 *         − unclaimed rakeback claims
 *
 * All aggregates exclude staff (admin/creator) — role NOT IN ('admin','creator').
 *
 * The returned breakdown is deliberately flat so consumers can pick the
 * fields they want to surface in their UI without re-running the query.
 */
export type RealizedPnlSnapshot = {
  pnl: number;
  totalDeposited: number;
  totalWithdrawn: number;
  userBalance: number;
  inventory: number;
  vouchers: number;
  unclaimedRakeback: number;
};

export async function getRealizedPnlSnapshot(): Promise<RealizedPnlSnapshot> {
  const rows = await db.$queryRaw<
    {
      deposited: string;
      balance_withdrawn: string;
      card_withdrawn: string;
      available_balance: string;
      locked_balance: string;
      inventory: string;
      vouchers: string;
      unclaimed_rakeback: string;
    }[]
  >`
    WITH real_users AS (
      SELECT id FROM "user" WHERE role NOT IN ('admin','creator')
    )
    SELECT
      COALESCE((SELECT SUM(total_deposited::numeric)     FROM balances                 WHERE user_id IN (SELECT id FROM real_users)), 0)::text AS deposited,
      COALESCE((SELECT SUM(total_withdrawn::numeric)     FROM balances                 WHERE user_id IN (SELECT id FROM real_users)), 0)::text AS balance_withdrawn,
      COALESCE((SELECT SUM(total_value_usd::numeric)     FROM card_withdrawal_requests  WHERE status IN ('completed','shipped') AND user_id IN (SELECT id FROM real_users)), 0)::text AS card_withdrawn,
      COALESCE((SELECT SUM(available_balance::numeric)   FROM balances                 WHERE user_id IN (SELECT id FROM real_users)), 0)::text AS available_balance,
      COALESCE((SELECT SUM(locked_balance::numeric)      FROM balances                 WHERE user_id IN (SELECT id FROM real_users)), 0)::text AS locked_balance,
      COALESCE((SELECT SUM(value_at_obtained::numeric)   FROM user_inventory            WHERE sold_at IS NULL AND exchanged_at IS NULL AND user_id IN (SELECT id FROM real_users)), 0)::text AS inventory,
      COALESCE((SELECT SUM(value::numeric)               FROM vouchers                  WHERE claimed_at IS NULL AND user_id IN (SELECT id FROM real_users)), 0)::text AS vouchers,
      COALESCE((SELECT SUM(rakeback_amount_usd::numeric) FROM rakeback_claims           WHERE claimed_at IS NULL AND user_id IN (SELECT id FROM real_users)), 0)::text AS unclaimed_rakeback
  `;

  const r = rows[0];
  const totalDeposited = Number(r?.deposited ?? 0);
  const balanceWithdrawn = Number(r?.balance_withdrawn ?? 0);
  const cardWithdrawn = Number(r?.card_withdrawn ?? 0);
  const totalWithdrawn = balanceWithdrawn + cardWithdrawn;
  const availableBalance = Number(r?.available_balance ?? 0);
  const lockedBalance = Number(r?.locked_balance ?? 0);
  const userBalance = availableBalance + lockedBalance;
  const inventory = Number(r?.inventory ?? 0);
  const vouchers = Number(r?.vouchers ?? 0);
  const unclaimedRakeback = Number(r?.unclaimed_rakeback ?? 0);

  const pnl =
    totalDeposited -
    totalWithdrawn -
    userBalance -
    inventory -
    vouchers -
    unclaimedRakeback;

  return {
    pnl,
    totalDeposited,
    totalWithdrawn,
    userBalance,
    inventory,
    vouchers,
    unclaimedRakeback,
  };
}
