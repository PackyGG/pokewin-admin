import "server-only";

import { getDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";

/**
 * Combined lifetime House P&L across EVERY creator's referred-user
 * pool. Same canonical balance-sheet formula the dashboard's
 * Lifetime PnL + the per-creator hero tile use:
 *
 *   pnl = totalDeposits
 *       − totalWithdrawals (manual + card)
 *       − currentBalance (available + locked, RIGHT NOW)
 *       − currentInventory (unsold + unexchanged, RIGHT NOW)
 *       − currentVouchers (unclaimed, RIGHT NOW)
 *
 * Pool = `SELECT DISTINCT referred_user_id FROM affiliate_code_usages`
 * with the same staff + blacklist + creator-role exclusion the
 * per-creator query uses. DISTINCT so a user referred by multiple
 * creators only counts once (the "combined" reading admins asked
 * for — total house P&L attributable to ALL creator referrals,
 * not the sum of individual creator PnLs which would double-count
 * shared referrals).
 *
 * Single SQL round-trip — six correlated sub-SELECTs against the
 * same `referred_users` CTE.
 *
 * Returns null on query failure (best-effort path so the KPI tile
 * falls back to "—" instead of crashing /creators).
 */
export type AllCreatorsLifetimePnl = {
  totalDeposits: number;
  totalWithdrawals: number;
  currentBalance: number;
  currentInventory: number;
  currentVouchers: number;
  pnl: number;
};

export async function getAllCreatorsLifetimePnl(): Promise<AllCreatorsLifetimePnl> {
  const db = await getDb();
  const excluded = await getExcludedUserIds();
  const blacklistFrag =
    excluded.length > 0
      ? `AND u.id NOT IN (${excluded
          .map((id) => `'${id.replace(/'/g, "''")}'`)
          .join(",")})`
      : "";

  // Same exclusion shape as creators-pnl.ts:buildReferredUsersSql.
  // No per-creator `affiliate_user_id` filter — we want the UNION of
  // every creator's referrals. Also excludes the creator themselves
  // (we don't want creators' own activity counting as their
  // referrals' activity).
  const REFERRED_USERS_SQL = `
    SELECT DISTINCT acu.referred_user_id
      FROM affiliate_code_usages acu
      JOIN "user" u ON u.id = acu.referred_user_id
      JOIN "user" cu ON cu.id = acu.affiliate_user_id
     WHERE u.role NOT IN ('admin', 'support', 'creator')
       AND u.id != acu.affiliate_user_id
       AND cu.role = 'creator'
       ${blacklistFrag}
  `;

  const rows = await db.$queryRawUnsafe<
    {
      total_deposits: string;
      manual_withdrawals: string;
      card_withdrawals: string;
      current_balance: string;
      current_inventory: string;
      current_vouchers: string;
    }[]
  >(`
    SELECT
        (SELECT COALESCE(SUM(CASE WHEN lt.type = 'deposit'
                                   THEN lt.amount::numeric
                                   ELSE 0 END), 0)::text
           FROM ledger_transactions lt
          WHERE lt.user_id IN (${REFERRED_USERS_SQL})
            AND lt.status = 'completed'
        ) AS total_deposits,
        (SELECT COALESCE(SUM(CASE WHEN lt.type = 'admin_balance_adjustment'
                                   AND lt.balance_after < lt.balance_before
                                   AND lt.description ILIKE 'Manual withdrawal:%'
                                   THEN lt.amount::numeric
                                   ELSE 0 END), 0)::text
           FROM ledger_transactions lt
          WHERE lt.user_id IN (${REFERRED_USERS_SQL})
            AND lt.status = 'completed'
        ) AS manual_withdrawals,
        (SELECT COALESCE(SUM(cwr.total_value_usd::numeric), 0)::text
           FROM card_withdrawal_requests cwr
          WHERE cwr.user_id IN (${REFERRED_USERS_SQL})
            AND cwr.status IN ('completed', 'shipped')
        ) AS card_withdrawals,
        (SELECT COALESCE(SUM(b.available_balance::numeric + b.locked_balance::numeric), 0)::text
           FROM balances b
          WHERE b.user_id IN (${REFERRED_USERS_SQL})
        ) AS current_balance,
        (SELECT COALESCE(SUM(ui.value_at_obtained::numeric), 0)::text
           FROM user_inventory ui
          WHERE ui.user_id IN (${REFERRED_USERS_SQL})
            AND ui.sold_at IS NULL
            AND ui.exchanged_at IS NULL
        ) AS current_inventory,
        (SELECT COALESCE(SUM(v.value::numeric), 0)::text
           FROM vouchers v
          WHERE v.user_id IN (${REFERRED_USERS_SQL})
            AND v.claimed_at IS NULL
        ) AS current_vouchers
  `);

  const r = rows[0];
  const totalDeposits = Number(r?.total_deposits ?? 0);
  const totalWithdrawals =
    Number(r?.manual_withdrawals ?? 0) + Number(r?.card_withdrawals ?? 0);
  const currentBalance = Number(r?.current_balance ?? 0);
  const currentInventory = Number(r?.current_inventory ?? 0);
  const currentVouchers = Number(r?.current_vouchers ?? 0);
  return {
    totalDeposits,
    totalWithdrawals,
    currentBalance,
    currentInventory,
    currentVouchers,
    pnl:
      totalDeposits -
      totalWithdrawals -
      currentBalance -
      currentInventory -
      currentVouchers,
  };
}
