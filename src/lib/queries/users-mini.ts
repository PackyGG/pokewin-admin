import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";

/**
 * Mini summary of a user for the LiveMoneyChat pop-up dialog. Compact,
 * cheap, and bounded:
 *   • user row     — name / email / image / role / country / signup
 *   • balance row  — cash, locked, lifetime totals
 *   • aggregates   — inventory value + count, unclaimed voucher value
 *   • recent       — last 5 completed ledger rows for context
 *
 * Designed for sub-100ms latency on a warm connection. All five
 * queries fire in parallel; the underlying indexes (user_id PK,
 * `(user_id, created_at)` on ledger) keep each one to a small range
 * scan. No full-table aggregates, no joins beyond the user PK.
 *
 * House-POV math (P&L) lives elsewhere — the mini dialog deliberately
 * doesn't try to compute realized P&L because that requires the full
 * snapshot helper. Operators who need the precise number open the
 * full /users/[id] page from the dialog's footer link.
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

  const [user, balance, inventoryAgg, vouchersAgg, recentTx] =
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
      db.balances.findUnique({
        where: { user_id: userId },
        select: {
          available_balance: true,
          locked_balance: true,
          total_deposited: true,
          total_withdrawn: true,
          total_wagered: true,
          total_won: true,
        },
      }),
      // Live (unsold, non-exchanged, non-withdrawal-locked) inventory.
      // Mirrors the scope the /users/[id] balance panel uses for the
      // "Inventory" liability line, so the two numbers match.
      db.user_inventory.aggregate({
        where: {
          user_id: userId,
          sold_at: null,
          exchanged_at: null,
          withdrawal_locked_at: null,
        },
        _sum: { value_at_obtained: true },
        _count: true,
      }),
      // Outstanding (unclaimed) voucher liability.
      db.vouchers.aggregate({
        where: { user_id: userId, claimed_at: null },
        _sum: { value: true },
      }),
      // Recent activity — just the last 5 completed ledger rows. The
      // dialog renders them as a compact mini feed for context;
      // operators tap through to /users/[id] for the full history.
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
      availableBalance: balance ? toNumber(balance.available_balance) : 0,
      lockedBalance: balance ? toNumber(balance.locked_balance) : 0,
      totalDeposited: balance ? toNumber(balance.total_deposited) : 0,
      totalWithdrawn: balance ? toNumber(balance.total_withdrawn) : 0,
      totalWagered: balance ? toNumber(balance.total_wagered) : 0,
      totalWon: balance ? toNumber(balance.total_won) : 0,
    },
    inventoryValue: toNumber(inventoryAgg._sum.value_at_obtained),
    inventoryCount: inventoryAgg._count,
    vouchersValue: toNumber(vouchersAgg._sum.value),
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
