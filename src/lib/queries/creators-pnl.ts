import { getDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { WAGER_TYPES_SQL } from "./_wager-payout-types";
import type {
  CreatorLifetimePnl,
  CreatorPnlData,
  CreatorPnlPeriod,
} from "./creators-types";

/**
 * Per-creator House P&L, computed as a windowed analog of the canonical
 * lifetime formula on the dashboard / user-detail page:
 *
 *   pnl = deposits − withdrawals − balanceChange − inventoryChange − voucherChange
 *
 * Each component is the DELTA over the window (not a snapshot). Because
 * a user's lifetime PnL is exactly cash_in − cash_out − liability_now,
 * the windowed delta of that expression equals
 * lifetime_pnl(t_end) − lifetime_pnl(t_start) — i.e. the actual P&L
 * change attributable to the window.
 *
 * Sign convention notes:
 *   • `ledger_transactions.amount` is ALWAYS POSITIVE in this DB; the
 *     sign of the balance impact lives in `balance_after −
 *     balance_before`. So `balanceChange` sums the SIGNED delta, not
 *     the amount.
 *   • There is no `'withdrawal'` value in `ledger_transaction_type`.
 *     Real withdrawals on this platform come via:
 *       (a) `card_withdrawal_requests` (status completed/shipped) —
 *           physical cards or crypto sells leaving the house, and
 *       (b) `admin_balance_adjustment` rows tagged in description
 *           with `Manual withdrawal:%` (a manual cash-out by an admin).
 *     Both are summed into `withdrawals`.
 *
 * Referred-user pool excludes:
 *   • admin / support — staff accounts (consistent with rest of analytics)
 *   • creator         — other streamer accounts; their on-site activity
 *                       isn't representative of "real referral" P&L the
 *                       admin wants to evaluate per creator
 *   • the creator's own user_id — defensive guard against self-references
 *     in affiliate_code_usages
 *
 * Four parallel scans (ledger / card_withdrawals / inventory / vouchers)
 * each bucket their values across the same VALUES list of windows so the
 * per-period rows line up by period name in JS. All four queries scope
 * scan to ≤ 30 days back so user_inventory and ledger don't pull full
 * history.
 */
const PERIODS = ["24h", "3d", "7d", "14d", "30d"] as const;

type PeriodKey = (typeof PERIODS)[number];

const PERIODS_VALUES_SQL = `(VALUES ('24h'),('3d'),('7d'),('14d'),('30d')) AS p(period)`;
const PERIOD_INTERVAL_CASE = `CASE p.period
  WHEN '24h' THEN INTERVAL '24 hours'
  WHEN '3d'  THEN INTERVAL '3 days'
  WHEN '7d'  THEN INTERVAL '7 days'
  WHEN '14d' THEN INTERVAL '14 days'
  WHEN '30d' THEN INTERVAL '30 days'
END`;

// Built per-call so the admin-managed blacklist (cached via React
// `cache()`) can append `AND u.id NOT IN (...)` to the referred-user
// pool. Keeps the staff-role exclusion + the blacklist in lockstep
// for every per-creator PnL aggregate below.
async function buildReferredUsersSql(): Promise<string> {
  const excluded = await getExcludedUserIds();
  const blacklistFrag =
    excluded.length > 0
      ? ` AND u.id NOT IN (${excluded
          .map((id) => `'${id.replace(/'/g, "''")}'`)
          .join(",")})`
      : "";
  return `
    SELECT DISTINCT acu.referred_user_id
      FROM affiliate_code_usages acu
      JOIN "user" u ON u.id = acu.referred_user_id
     WHERE acu.affiliate_user_id = $1
       AND u.role NOT IN ('admin', 'support', 'creator')
       AND u.id != $1${blacklistFrag}
  `;
}

export async function getCreatorPnl(userId: string): Promise<CreatorPnlData> {
  const db = await getDb();
  const REFERRED_USERS_SQL = await buildReferredUsersSql();

  const [ledgerRows, cardWithdrawalRows, inventoryRows, voucherRows, lifetimeRows] =
    await Promise.all([
      // Ledger-derived components per window:
      //   deposits           = SUM(amount where type='deposit')
      //   manual_withdrawals = SUM(amount where type='admin_balance_adjustment'
      //                            AND balance_after < balance_before
      //                            AND description ILIKE 'Manual withdrawal:%')
      //   bal_change         = SUM(balance_after − balance_before) — SIGNED.
      //
      // The balance at any time t equals the cumulative SIGNED delta of
      // every completed ledger event up to t (= sum of balance_after −
      // balance_before). So the change in balance over a window is the
      // sum of those signed deltas inside the window.
      db.$queryRawUnsafe<
        {
          period: string;
          deposits: string;
          manual_withdrawals: string;
          bal_change: string;
        }[]
      >(
        `SELECT p.period,
                COALESCE(SUM(CASE WHEN lt.type = 'deposit'
                                  THEN lt.amount::numeric
                                  ELSE 0 END), 0)::text AS deposits,
                COALESCE(SUM(CASE WHEN lt.type = 'admin_balance_adjustment'
                                   AND lt.balance_after < lt.balance_before
                                   AND lt.description ILIKE 'Manual withdrawal:%'
                                  THEN lt.amount::numeric
                                  ELSE 0 END), 0)::text AS manual_withdrawals,
                COALESCE(SUM((lt.balance_after - lt.balance_before)::numeric), 0)::text AS bal_change
           FROM ${PERIODS_VALUES_SQL}
           LEFT JOIN ledger_transactions lt
             ON lt.user_id IN (${REFERRED_USERS_SQL})
            AND lt.status = 'completed'
            AND lt.created_at >= NOW() - (${PERIOD_INTERVAL_CASE})
          GROUP BY p.period`,
        userId,
      ),

      // Card withdrawals — physical cards / crypto sells leaving the
      // house. Time-scoped by COALESCE(shipped_at, completed_at) to
      // match the moment the value left our books.
      db.$queryRawUnsafe<
        {
          period: string;
          card_withdrawals: string;
        }[]
      >(
        `SELECT p.period,
                COALESCE(SUM(cwr.total_value_usd::numeric), 0)::text AS card_withdrawals
           FROM ${PERIODS_VALUES_SQL}
           LEFT JOIN card_withdrawal_requests cwr
             ON cwr.user_id IN (${REFERRED_USERS_SQL})
            AND cwr.status IN ('completed', 'shipped')
            AND COALESCE(cwr.shipped_at, cwr.completed_at)
                  >= NOW() - (${PERIOD_INTERVAL_CASE})
          GROUP BY p.period`,
        userId,
      ),

      // Inventory delta — value_at_obtained is the canonical valuation
      // used by Platform-P&L on /users/[id], so per-creator P&L can't
      // drift from per-user P&L for the same user pool.
      //
      // obtained: items added to inventory in window.
      // disposed: items removed (sold OR exchanged) in window.
      // An item obtained AND disposed in the same window contributes
      // 0 net (which is correct — no liability change across the
      // window).
      db.$queryRawUnsafe<
        {
          period: string;
          obtained: string;
          disposed: string;
        }[]
      >(
        `SELECT p.period,
                COALESCE(SUM(CASE
                  WHEN ui.obtained_at >= NOW() - (${PERIOD_INTERVAL_CASE})
                    THEN ui.value_at_obtained::numeric
                  ELSE 0
                END), 0)::text AS obtained,
                COALESCE(SUM(CASE
                  WHEN ui.sold_at      >= NOW() - (${PERIOD_INTERVAL_CASE})
                    OR ui.exchanged_at >= NOW() - (${PERIOD_INTERVAL_CASE})
                    THEN ui.value_at_obtained::numeric
                  ELSE 0
                END), 0)::text AS disposed
           FROM ${PERIODS_VALUES_SQL}
           LEFT JOIN user_inventory ui
             ON ui.user_id IN (${REFERRED_USERS_SQL})
            AND (
                  ui.obtained_at  >= NOW() - INTERVAL '30 days'
               OR ui.sold_at      >= NOW() - INTERVAL '30 days'
               OR ui.exchanged_at >= NOW() - INTERVAL '30 days'
            )
          GROUP BY p.period`,
        userId,
      ),

      // Voucher delta — issued (created_at IN window) vs claimed
      // (claimed_at IN window). A voucher created AND claimed in the
      // same window contributes 0 net (which is correct — no
      // liability change).
      db.$queryRawUnsafe<
        {
          period: string;
          issued: string;
          claimed: string;
        }[]
      >(
        `SELECT p.period,
                COALESCE(SUM(CASE
                  WHEN v.created_at >= NOW() - (${PERIOD_INTERVAL_CASE})
                    THEN v.value::numeric
                  ELSE 0
                END), 0)::text AS issued,
                COALESCE(SUM(CASE
                  WHEN v.claimed_at >= NOW() - (${PERIOD_INTERVAL_CASE})
                    THEN v.value::numeric
                  ELSE 0
                END), 0)::text AS claimed
           FROM ${PERIODS_VALUES_SQL}
           LEFT JOIN vouchers v
             ON v.user_id IN (${REFERRED_USERS_SQL})
            AND (
                  v.created_at >= NOW() - INTERVAL '30 days'
               OR v.claimed_at >= NOW() - INTERVAL '30 days'
            )
          GROUP BY p.period`,
        userId,
      ),

      // Lifetime snapshot — single row, six aggregates. Same formula
      // as the per-period rows but evaluated as a balance-sheet
      // SNAPSHOT, not a delta:
      //
      //   pnl = totalDeposits
      //       − totalWithdrawals (manual + card)
      //       − currentBalance (available + locked, RIGHT NOW)
      //       − currentInventory (unsold + unexchanged, RIGHT NOW)
      //       − currentVouchers (unclaimed, RIGHT NOW)
      //
      // Independent from the per-period query above — it doesn't share
      // the 30-day window hint, because lifetime needs to scan the
      // full history. Six correlated subqueries against the same
      // referred-user pool; one round-trip.
      db.$queryRawUnsafe<
        {
          total_deposits: string;
          manual_withdrawals: string;
          card_withdrawals: string;
          total_wagered: string;
          current_balance: string;
          current_inventory: string;
          current_vouchers: string;
        }[]
      >(
        `SELECT
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
            (SELECT COALESCE(SUM(lt.amount::numeric), 0)::text
               FROM ledger_transactions lt
              WHERE lt.user_id IN (${REFERRED_USERS_SQL})
                AND lt.status = 'completed'
                AND lt.type IN ${WAGER_TYPES_SQL}
            ) AS total_wagered,
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
            ) AS current_vouchers`,
        userId,
      ),
    ]);

  const ledgerByPeriod = new Map(ledgerRows.map((r) => [r.period, r]));
  const cwByPeriod = new Map(cardWithdrawalRows.map((r) => [r.period, r]));
  const invByPeriod = new Map(inventoryRows.map((r) => [r.period, r]));
  const vchByPeriod = new Map(voucherRows.map((r) => [r.period, r]));

  const byPeriod: CreatorPnlPeriod[] = PERIODS.map((period: PeriodKey) => {
    const lr = ledgerByPeriod.get(period);
    const cw = cwByPeriod.get(period);
    const iv = invByPeriod.get(period);
    const vc = vchByPeriod.get(period);

    const deposits = Number(lr?.deposits ?? 0);
    const manualWithdrawals = Number(lr?.manual_withdrawals ?? 0);
    const cardWithdrawals = Number(cw?.card_withdrawals ?? 0);
    const withdrawals = manualWithdrawals + cardWithdrawals;
    const balanceChange = Number(lr?.bal_change ?? 0);
    const inventoryChange =
      Number(iv?.obtained ?? 0) - Number(iv?.disposed ?? 0);
    const voucherChange = Number(vc?.issued ?? 0) - Number(vc?.claimed ?? 0);
    const pnl =
      deposits -
      withdrawals -
      balanceChange -
      inventoryChange -
      voucherChange;

    return {
      period,
      deposits,
      withdrawals,
      balanceChange,
      inventoryChange,
      voucherChange,
      pnl,
    };
  });

  // Lifetime snapshot — single row from the all-time aggregate
  // query. If somehow empty (no referred users), default everything
  // to 0 so the panel still renders cleanly.
  const lr = lifetimeRows[0];
  const totalDeposits = Number(lr?.total_deposits ?? 0);
  const totalWithdrawals =
    Number(lr?.manual_withdrawals ?? 0) +
    Number(lr?.card_withdrawals ?? 0);
  const totalWagered = Number(lr?.total_wagered ?? 0);
  const currentBalance = Number(lr?.current_balance ?? 0);
  const currentInventory = Number(lr?.current_inventory ?? 0);
  const currentVouchers = Number(lr?.current_vouchers ?? 0);
  const lifetime: CreatorLifetimePnl = {
    totalDeposits,
    totalWithdrawals,
    totalWagered,
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

  return { byPeriod, lifetime };
}
