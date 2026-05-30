import { getDb } from "@/lib/db";
import type { PaginatedResult } from "@/lib/types";

/**
 * Upgrader transactions query — paginated list of upgrader_games rows.
 *
 * Why source from `upgrader_games` and NOT `ledger_transactions`:
 *   The backend debits the wager as an `upgrader_bet` ledger row but
 *   never emits a matching `upgrader_payout` credit on a win (the
 *   service uses a balance-update path, not a paired ledger row). So
 *   pairing bet/payout rows off the ledger would only show wagers and
 *   read every game as a 100% house loss — exactly the same pitfall
 *   the dashboard-upgrader.ts query already avoided.
 *
 *   `upgrader_games` has both `bet_amount` (what the player risked)
 *   and `won_amount` (gross value returned on a win, 0 on a loss) on
 *   the same row, so each row is a self-contained outcome record.
 *
 * Mirrors the pagination / search / status filter shape of the existing
 * transactions queries so the page layer reads the same way.
 */

export type UpgraderTransactionRow = {
  id: string;
  userId: string;
  username: string | null;
  image: string | null;
  betAmount: number;
  wonAmount: number;
  /**
   * Per-row house P&L from the gameplay outcome:
   *   pnl = betAmount − wonAmount
   * House POV → positive = house gain (emerald), negative = house loss
   * (rose). Matches the convention used across /transactions and
   * /battles.
   */
  housePnl: number;
  /**
   * Realized multiplier on a winning game (`wonAmount / betAmount`).
   * `null` on a loss (won_amount = 0) so the column renders "—" instead
   * of "0×".
   */
  multiplier: number | null;
  /**
   * Outcome derived from `won_amount`:
   *   won_amount > 0  → "win"  (user took money out — house loss)
   *   won_amount = 0  → "loss" (player risked, house kept it all)
   */
  outcome: "win" | "loss";
  createdAt: string;
};

export type UpgraderOutcomeFilter = "all" | "win" | "loss";

const VALID_OUTCOMES = new Set<UpgraderOutcomeFilter>(["all", "win", "loss"]);

export async function getUpgraderTransactions(params: {
  page?: number;
  perPage?: number;
  search?: string;
  outcome?: string;
}): Promise<PaginatedResult<UpgraderTransactionRow>> {
  const { page = 1, perPage = 20, search, outcome } = params;
  const db = await getDb();

  const safePerPage = Math.max(1, Math.min(200, Math.floor(perPage)));
  const safePage = Math.max(1, Math.floor(page));
  const offset = (safePage - 1) * safePerPage;

  // Bind user-supplied values via positional parameters — never
  // interpolate them into the SQL string. Status / outcome is
  // whitelisted before inlining.
  const queryParams: unknown[] = [];

  // Search by UUID (game id or user id) or username — same shape as
  // getDepositTransactions, including the username-join gate to skip
  // the LEFT JOIN on UUID-only searches.
  let searchFilter = "";
  let needsUserJoinForSearch = false;
  if (search) {
    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        search,
      );
    if (isUuid) {
      queryParams.push(search);
      const idx = queryParams.length;
      searchFilter = `AND (g.id::text = $${idx} OR g.user_id = $${idx})`;
    } else {
      queryParams.push(`%${search.toLowerCase()}%`);
      const idx = queryParams.length;
      searchFilter = `AND LOWER(u.username) LIKE $${idx}`;
      needsUserJoinForSearch = true;
    }
  }

  // Outcome filter — derived from won_amount sign. Whitelisted so
  // arbitrary URL values don't smuggle SQL.
  const outcomeKey =
    outcome && VALID_OUTCOMES.has(outcome as UpgraderOutcomeFilter)
      ? (outcome as UpgraderOutcomeFilter)
      : "all";
  let outcomeFilter = "";
  if (outcomeKey === "win") outcomeFilter = "AND g.won_amount::numeric > 0";
  else if (outcomeKey === "loss") outcomeFilter = "AND g.won_amount::numeric = 0";

  // Always LEFT JOIN "user" for the data query (we need username +
  // image). For COUNT we only join when the search is by username.
  const baseWhere = `
    WHERE 1 = 1
      ${searchFilter}
      ${outcomeFilter}
  `;

  const countSql = `
    SELECT COUNT(*)::text AS total
    FROM upgrader_games g
    ${needsUserJoinForSearch ? `LEFT JOIN "user" u ON u.id = g.user_id` : ""}
    ${baseWhere}
  `;

  const dataSql = `
    SELECT
      g.id::text AS id,
      g.user_id,
      u.username,
      u.image,
      g.bet_amount::text AS bet_amount,
      g.won_amount::text AS won_amount,
      g.created_at
    FROM upgrader_games g
    LEFT JOIN "user" u ON u.id = g.user_id
    ${baseWhere}
    ORDER BY g.created_at DESC
    LIMIT ${safePerPage}
    OFFSET ${offset}
  `;

  type Raw = {
    id: string;
    user_id: string;
    username: string | null;
    image: string | null;
    bet_amount: string;
    won_amount: string;
    created_at: Date;
  };

  const [countResult, rows] = await Promise.all([
    db.$queryRawUnsafe<{ total: string }[]>(countSql, ...queryParams),
    db.$queryRawUnsafe<Raw[]>(dataSql, ...queryParams),
  ]);

  const total = Number(countResult[0]?.total ?? "0");

  const data: UpgraderTransactionRow[] = rows.map((r) => {
    const betAmount = Number(r.bet_amount);
    const wonAmount = Number(r.won_amount);
    const isWin = wonAmount > 0;
    return {
      id: r.id,
      userId: r.user_id,
      username: r.username,
      image: r.image,
      betAmount,
      wonAmount,
      housePnl: betAmount - wonAmount,
      multiplier: isWin && betAmount > 0 ? wonAmount / betAmount : null,
      outcome: isWin ? "win" : "loss",
      createdAt: r.created_at.toISOString(),
    };
  });

  return {
    data,
    total,
    page: safePage,
    perPage: safePerPage,
    totalPages: Math.ceil(total / safePerPage),
  };
}
