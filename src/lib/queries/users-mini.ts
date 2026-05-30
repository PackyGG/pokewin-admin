import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { calculateUserPnl } from "./pnl";

/**
 * Mini summary of a user for the LiveMoneyChat pop-up dialog. Compact,
 * cheap, and bounded:
 *   • user row     — name / email / image / role / country / signup
 *   • balance row  — cash, locked, lifetime wager/won (for RTP)
 *   • canonical P&L — via the shared `calculateUserPnl` helper so the
 *     mini dialog never drifts from /users/[id]
 *   • inventory item count
 *   • last 5 completed ledger rows for context
 *
 * Designed for sub-100ms latency on a warm connection. All queries
 * fire in parallel; the underlying indexes keep each one to a small
 * range scan.
 *
 * IMPORTANT — the mini dialog's lifetime numbers MUST go through
 * `calculateUserPnl`, not the raw `balances.total_*` columns. The
 * canonical formula sums withdrawals from BOTH the balances column
 * AND `card_withdrawal_requests` (which the raw column doesn't carry).
 * Skipping the helper made the dialog under-report withdrawals and
 * over-report house P&L vs the same user's /users/[id] page.
 */
export type UserMiniSummary = {
  user: {
    id: string;
    username: string | null;
    email: string | null;
    image: string | null;
    role: string;
    country: string | null;
    createdAt: string;
  };
  balance: {
    availableBalance: number;
    lockedBalance: number;
    totalDeposited: number;
    totalWithdrawn: number;
    totalWagered: number;
    totalWon: number;
  };
  /** Lifetime house P&L — house-POV, positive = house gained. */
  pnl: number;
  inventoryValue: number;
  inventoryCount: number;
  vouchersValue: number;
  recentTransactions: Array<{
    id: string;
    type: string;
    amount: number;
    balanceAfter: number;
    createdAt: string;
    description: string | null;
  }>;
};

export async function getUserMiniSummary(
  userId: string,
): Promise<UserMiniSummary | null> {
  const db = await getDb();

  // calculateUserPnl already fetches balances + inventory + vouchers
  // + card_withdrawal_requests internally and applies the canonical
  // formula. We piggy-back on it so the numbers match /users/[id]
  // exactly, and run a tiny separate query for the inventory COUNT +
  // wager/won (which the PnL helper doesn't expose).
  const [user, pnl, balanceExtra, inventoryCount, recentTx] =
    await Promise.all([
      db.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          username: true,
          email: true,
          image: true,
          role: true,
          country: true,
          created_at: true,
        },
      }),
      calculateUserPnl(userId),
      // Wager + won come straight from `balances` — the canonical
      // RTP formula uses them as-is. Also re-read available + locked
      // even though `calculateUserPnl` has the sum, because the UI
      // shows the per-component "cash" breakdown.
      db.balances.findUnique({
        where: { user_id: userId },
        select: {
          available_balance: true,
          locked_balance: true,
          total_wagered: true,
          total_won: true,
        },
      }),
      db.user_inventory.count({
        where: {
          user_id: userId,
          sold_at: null,
          exchanged_at: null,
          withdrawal_locked_at: null,
        },
      }),
      // Recent activity — last 5 completed ledger rows. The dialog
      // renders them as a compact mini feed for context.
      db.ledger_transactions.findMany({
        where: { user_id: userId, status: "completed" },
        orderBy: { created_at: "desc" },
        take: 5,
        select: {
          id: true,
          type: true,
          amount: true,
          balance_after: true,
          created_at: true,
          description: true,
        },
      }),
    ]);

  if (!user) return null;

  return {
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      image: user.image,
      role: user.role,
      country: user.country,
      createdAt: user.created_at.toISOString(),
    },
    balance: {
      availableBalance: balanceExtra
        ? toNumber(balanceExtra.available_balance)
        : 0,
      lockedBalance: balanceExtra ? toNumber(balanceExtra.locked_balance) : 0,
      totalDeposited: pnl.deposits,
      totalWithdrawn: pnl.withdrawals,
      totalWagered: balanceExtra ? toNumber(balanceExtra.total_wagered) : 0,
      totalWon: balanceExtra ? toNumber(balanceExtra.total_won) : 0,
    },
    pnl: pnl.pnl,
    inventoryValue: pnl.inventoryValue,
    inventoryCount,
    vouchersValue: pnl.unclaimedVouchers,
    recentTransactions: recentTx.map((r) => ({
      id: r.id,
      type: r.type,
      amount: toNumber(r.amount),
      balanceAfter: toNumber(r.balance_after),
      createdAt: r.created_at.toISOString(),
      description: r.description,
    })),
  };
}
