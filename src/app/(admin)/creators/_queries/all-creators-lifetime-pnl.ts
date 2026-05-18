import "server-only";

import { getDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";

/**
 * Combined lifetime House P&L across EVERY creator's affiliate-code
 * activity. Coverage-aware code attribution — same model the
 * /creators/[id] hero panel uses:
 *
 *   pnl = totalDeposits − totalCardWithdrawals
 *
 * Where:
 *   • totalDeposits = SUM(ledger.amount for deposit) attributed via
 *     coverage reconstruction. A deposit at time T by user U is booked
 *     against the creator whose code U was on at T — derived from the
 *     most recent acu row by U in [T - 7d, T]. Fixes the previous
 *     under-count where only the user's first-ever deposit had an
 *     acu deposit row (the backend depositCount=1 early-return bug).
 *   • totalCardWithdrawals = value of physical cards from creator-
 *     attributed sessions, restricted to users who have at least one
 *     coverage-attributed deposit under THAT creator (depositor filter,
 *     same as the detail panel — keeps over-wagerers from dragging a
 *     creator's number down).
 *
 * Per-creator breakdown is returned alongside the aggregate so admins
 * can drill in from the KPI tile to see which specific creator is
 * dragging the global number into the red (or carrying it). Each
 * deposit has at most one covering creator, so per-creator rows sum
 * cleanly to the aggregate.
 *
 * SQL shape: one round-trip with CTEs that share intermediate sets.
 *   covered_deposits   — DISTINCT ON pattern: pick the most recent acu
 *                        row per ledger deposit. Single sort-merge join
 *                        instead of N correlated lookups.
 *   depositors_per_creator — driven from covered_deposits, used to gate
 *                        the cardWD attribution.
 *
 * Returns aggregate totals + sorted byCreator breakdown.
 */
export type CreatorLifetimePnlBreakdownRow = {
  userId: string;
  username: string | null;
  image: string | null;
  totalDeposits: number;
  totalWagered: number;
  totalCardWithdrawals: number;
  pnl: number;
};

export type AllCreatorsLifetimePnl = {
  totalDeposits: number;
  totalWagered: number;
  totalCardWithdrawals: number;
  pnl: number;
  byCreator: CreatorLifetimePnlBreakdownRow[];
};

export async function getAllCreatorsLifetimePnl(): Promise<AllCreatorsLifetimePnl> {
  const db = await getDb();
  const excluded = await getExcludedUserIds();
  // Blacklist guard applied as an extra AND on every WHERE that aliases
  // the referred user as `u`. Inlined per query because we can't share
  // a binding across CTE definitions in raw SQL cleanly.
  const blacklistAnd =
    excluded.length > 0
      ? ` AND u.id NOT IN (${excluded
          .map((id) => `'${id.replace(/'/g, "''")}'`)
          .join(",")})`
      : "";

  const rows = await db.$queryRawUnsafe<
    {
      creator_user_id: string;
      username: string | null;
      image: string | null;
      total_deposits: string;
      total_wagered: string;
      total_card_withdrawals: string;
    }[]
  >(`
    WITH covered_deposits AS (
      -- DISTINCT ON picks the most recent acu row per ledger deposit
      -- whose created_at falls in the 7-day pre-deposit window.
      -- That row's affiliate_user_id is the covering creator at the
      -- moment of the deposit.
      SELECT DISTINCT ON (lt.id)
             lt.id           AS deposit_id,
             lt.user_id,
             lt.amount::numeric AS amount,
             acu.affiliate_user_id AS creator_id
        FROM ledger_transactions lt
        JOIN "user" u ON u.id = lt.user_id
        LEFT JOIN affiliate_code_usages acu
               ON acu.referred_user_id = lt.user_id
              AND acu.created_at <= lt.created_at
              AND acu.created_at >= lt.created_at - INTERVAL '7 days'
              AND acu.referred_user_id != acu.affiliate_user_id
       WHERE lt.type = 'deposit'
         AND lt.status = 'completed'
         AND u.role NOT IN ('admin', 'support', 'creator')${blacklistAnd}
       ORDER BY lt.id, acu.created_at DESC
    ),
    attributed_deposits AS (
      SELECT * FROM covered_deposits WHERE creator_id IS NOT NULL
    ),
    depositors_per_creator AS (
      -- Per-creator set of users with at least one coverage-attributed
      -- deposit. Drives the cardWD depositor filter.
      SELECT DISTINCT creator_id, user_id FROM attributed_deposits
    ),
    creator_deposits AS (
      SELECT creator_id, SUM(amount) AS total_deposits
        FROM attributed_deposits
       GROUP BY creator_id
    ),
    creator_wagers AS (
      -- Wagers are unchanged: every wager creates an acu wager row
      -- with the active code at that moment, so the canonical sum
      -- IS the truth.
      SELECT acu.affiliate_user_id AS creator_id,
             SUM(acu.wager_amount_usd::numeric) AS total_wagered
        FROM affiliate_code_usages acu
        JOIN "user" u ON u.id = acu.referred_user_id
       WHERE acu.usage_type::text = 'wager'
         AND u.role NOT IN ('admin', 'support', 'creator')
         AND u.id != acu.affiliate_user_id${blacklistAnd}
       GROUP BY acu.affiliate_user_id
    ),
    creator_cardwd AS (
      -- CardWD: value_at_obtained from inventory items withdrawn,
      -- where the item came from a session wagered under some creator's
      -- code AND the withdrawing user has a coverage-attributed deposit
      -- under THAT creator. Depositor filter via EXISTS on
      -- depositors_per_creator so cross-creator drag is prevented.
      SELECT acu_w.affiliate_user_id AS creator_id,
             SUM(ui.value_at_obtained::numeric) AS total_card_withdrawals
        FROM card_withdrawal_requests cwr
        JOIN user_inventory ui ON ui.id = ANY(cwr.inventory_item_ids)
        JOIN affiliate_code_usages acu_w
             ON acu_w.game_session_id = ui.source_id
            AND acu_w.usage_type::text = 'wager'
        JOIN "user" u ON u.id = acu_w.referred_user_id
       WHERE cwr.status IN ('completed', 'shipped')
         AND ui.source_type::text IN ('pack', 'battle')
         AND u.role NOT IN ('admin', 'support', 'creator')
         AND u.id != acu_w.affiliate_user_id${blacklistAnd}
         AND EXISTS (
           SELECT 1 FROM depositors_per_creator dpc
            WHERE dpc.creator_id = acu_w.affiliate_user_id
              AND dpc.user_id    = ui.user_id
         )
       GROUP BY acu_w.affiliate_user_id
    )
    SELECT COALESCE(cd.creator_id, cw.creator_id, ccw.creator_id) AS creator_user_id,
           cu.username,
           cu.image,
           COALESCE(cd.total_deposits, 0)::text         AS total_deposits,
           COALESCE(cw.total_wagered, 0)::text          AS total_wagered,
           COALESCE(ccw.total_card_withdrawals, 0)::text AS total_card_withdrawals
      FROM creator_deposits cd
      FULL OUTER JOIN creator_wagers cw   ON cw.creator_id  = cd.creator_id
      FULL OUTER JOIN creator_cardwd ccw  ON ccw.creator_id = COALESCE(cd.creator_id, cw.creator_id)
      JOIN "user" cu ON cu.id = COALESCE(cd.creator_id, cw.creator_id, ccw.creator_id)
     WHERE cu.role = 'creator'
  `);

  const byCreator: CreatorLifetimePnlBreakdownRow[] = [];
  let totalDeposits = 0;
  let totalWagered = 0;
  let totalCardWithdrawals = 0;
  for (const r of rows) {
    const dep = Number(r.total_deposits);
    const wag = Number(r.total_wagered);
    const cwd = Number(r.total_card_withdrawals);
    const pnl = dep - cwd;
    byCreator.push({
      userId: r.creator_user_id,
      username: r.username,
      image: r.image,
      totalDeposits: dep,
      totalWagered: wag,
      totalCardWithdrawals: cwd,
      pnl,
    });
    totalDeposits += dep;
    totalWagered += wag;
    totalCardWithdrawals += cwd;
  }

  // Ascending by pnl — most negative first surfaces creators that
  // drag the global number into the red. Tiebreak by gross cardWD desc
  // so two creators at equal pnl still surface by value-out magnitude.
  byCreator.sort((a, b) => {
    const d = a.pnl - b.pnl;
    if (d !== 0) return d;
    return b.totalCardWithdrawals - a.totalCardWithdrawals;
  });

  return {
    totalDeposits,
    totalWagered,
    totalCardWithdrawals,
    pnl: totalDeposits - totalCardWithdrawals,
    byCreator,
  };
}
