import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { safeQuery } from "@/lib/errors/safe-query";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { calculateUserPnl, computeHousePnl, type UserPnl } from "./pnl";

// Withdrawal ledger types surfaced by the live money/activity feeds. For a
// blacklisted (excluded_users) user these rows — and the lifetime withdrawn
// figure — are suppressed in the mini preview, mirroring the wholesale
// suppression on /users/[id] (see users-detail.ts). Kept as a Set for O(1)
// membership checks while filtering the recent-tx list.
const WITHDRAWAL_TX_TYPES = new Set<string>([
  "card_withdrawal",
  "balance_withdrawal",
  "withdrawal_shipping_fee",
]);

const USER_MINI_PNL_TIMEOUT_MS = 8_000;
const USER_MINI_TX_TIMEOUT_MS = 5_000;

const EMPTY_PNL: UserPnl = {
  deposits: 0,
  withdrawals: 0,
  onSiteBalance: 0,
  inventoryValue: 0,
  unclaimedVouchers: 0,
  pnl: 0,
};

async function resolveCanonicalUserId(
  db: Awaited<ReturnType<typeof getDb>>,
  userId: string,
): Promise<string | null> {
  const user = await db.user.findFirst({
    where: {
      OR: [{ id: userId }, { id: { equals: userId, mode: "insensitive" } }],
    },
    select: { id: true },
  });
  return user?.id ?? null;
}

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
  /** Set when a non-critical leg timed out — preview still renders. */
  degraded?: {
    pnl?: boolean;
    recentTransactions?: boolean;
  };
};

export async function getUserMiniSummary(
  userId: string,
): Promise<UserMiniSummary | null> {
  const db = await getDb();
  const canonicalUserId = await resolveCanonicalUserId(db, userId);
  if (!canonicalUserId) return null;

  // WITHDRAWAL SUPPRESSION for blacklisted (excluded_users) users — the mini
  // preview opens from the live money/activity feeds and would otherwise leak
  // a blacklisted user's lifetime withdrawn total AND their individual
  // withdrawal ledger rows (amount + balanceAfter + timestamp). Mirror the
  // wholesale suppression already applied on /users/[id] (users-detail.ts):
  // zero the withdrawn figure + recompute the displayed P&L as if withdrawals
  // were 0, and drop every withdrawal-type recent-tx row. Deposits + the
  // P&L-ex-withdrawal stay visible (the dialog is NOT hidden).
  //
  // Gated GENERICALLY on blacklist membership (no hardcoded id), applied for
  // EVERYONE viewing — there is no per-admin override. `getExcludedUserIds`
  // reads the ADMIN DB (allowed), is React-cache()'d, and fails CLOSED.
  const isBlacklisted = (await getExcludedUserIds()).includes(canonicalUserId);

  // calculateUserPnl already fetches balances + inventory + vouchers
  // + card_withdrawal_requests internally and applies the canonical
  // formula. We piggy-back on it so the numbers match /users/[id]
  // exactly, and run a tiny separate query for the inventory COUNT +
  // wager/won (which the PnL helper doesn't expose).
  const [user, pnlResult, balanceExtra, inventoryCount, recentTxResult] =
    await Promise.all([
      db.user.findUnique({
        where: { id: canonicalUserId },
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
      safeQuery(
        () => calculateUserPnl(canonicalUserId),
        EMPTY_PNL,
        "users.mini.pnl",
        USER_MINI_PNL_TIMEOUT_MS,
      ),
      // Wager + won come straight from `balances` — the canonical
      // RTP formula uses them as-is. Also re-read available + locked
      // even though `calculateUserPnl` has the sum, because the UI
      // shows the per-component "cash" breakdown.
      db.balances.findUnique({
        where: { user_id: canonicalUserId },
        select: {
          available_balance: true,
          locked_balance: true,
          total_wagered: true,
          total_won: true,
        },
      }),
      db.user_inventory.count({
        where: {
          user_id: canonicalUserId,
          sold_at: null,
          exchanged_at: null,
          withdrawal_locked_at: null,
        },
      }),
      safeQuery(
        () =>
          db.ledger_transactions.findMany({
            where: { user_id: canonicalUserId, status: "completed" },
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
        [],
        "users.mini.recentTx",
        USER_MINI_TX_TIMEOUT_MS,
      ),
    ]);

  if (!user) return null;

  const pnl = pnlResult.data;
  const recentTx = recentTxResult.data;
  const degraded: UserMiniSummary["degraded"] = {};
  if (pnlResult.error) degraded.pnl = true;
  if (recentTxResult.error) degraded.recentTransactions = true;

  // Blacklisted → zero the withdrawn figure and recompute the displayed P&L
  // from the SAME canonical formula (computeHousePnl) with the withdrawals
  // term set to 0, so the shown withdrawn total, the P&L, and the tx list
  // stay internally consistent — never a stale/original withdrawal number.
  const displayedWithdrawn = isBlacklisted ? 0 : pnl.withdrawals;
  const displayedPnl = isBlacklisted
    ? computeHousePnl({ ...pnl, withdrawals: 0 })
    : pnl.pnl;
  const displayedRecentTx = isBlacklisted
    ? recentTx.filter((r) => !WITHDRAWAL_TX_TYPES.has(r.type))
    : recentTx;

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
      totalWithdrawn: displayedWithdrawn,
      totalWagered: balanceExtra ? toNumber(balanceExtra.total_wagered) : 0,
      totalWon: balanceExtra ? toNumber(balanceExtra.total_won) : 0,
    },
    pnl: displayedPnl,
    inventoryValue: pnl.inventoryValue,
    inventoryCount,
    vouchersValue: pnl.unclaimedVouchers,
    recentTransactions: displayedRecentTx.map((r) => ({
      id: r.id,
      type: r.type,
      amount: toNumber(r.amount),
      balanceAfter: toNumber(r.balance_after),
      createdAt: r.created_at.toISOString(),
      description: r.description,
    })),
    ...(Object.keys(degraded).length > 0 ? { degraded } : {}),
  };
}
