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
  /**
   * `ledger_transactions.id` for the upgrader_bet row that paid this
   * game's stake. Sourced via `game_sessions.bet_ledger_tx_id` so the
   * row can deep-link to the canonical /transactions/[id] page (which
   * surfaces the PF roll + the card the ticket landed on). `null` for
   * any game whose game_sessions row hasn't been wired up yet —
   * defensive, doesn't normally happen in prod.
   */
  ledgerTxId: string | null;
};

export type UpgraderOutcomeFilter = "all" | "win" | "loss";

const VALID_OUTCOMES = new Set<UpgraderOutcomeFilter>(["all", "win", "loss"]);

/**
 * Sort modes for the upgrader transactions list:
 *
 *   • "recent"     — default chronological feed (created_at DESC).
 *   • "multiplier" — biggest realized multiplier on a win first
 *                    (won_amount / bet_amount DESC). Losses (won_amount
 *                    = 0) and rows with bet_amount = 0 sort to the
 *                    bottom — NULLS LAST in the CASE expression below.
 *   • "wonAmount"  — biggest absolute dollar payout to the user first
 *                    (won_amount DESC). Losses tie at 0 and pile up at
 *                    the bottom of the result set.
 *
 * Sorting runs in SQL so it covers ALL matching rows, not just the
 * current page slice — the user sees the global top results when
 * either button is active, with the existing LIMIT/OFFSET pagination
 * walking the sorted dataset.
 */
export type UpgraderSortBy = "recent" | "multiplier" | "wonAmount";

const VALID_SORTS = new Set<UpgraderSortBy>(["recent", "multiplier", "wonAmount"]);

export async function getUpgraderTransactions(params: {
  page?: number;
  perPage?: number;
  search?: string;
  outcome?: string;
  sortBy?: string;
}): Promise<PaginatedResult<UpgraderTransactionRow>> {
  const { page = 1, perPage = 20, search, outcome, sortBy } = params;
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

  // Sort mode — whitelisted (never string-interpolate user input into
  // SQL). The three modes drive distinct ORDER BY clauses below; the
  // sort runs against the FULL filtered set inside the same SQL pass,
  // so pagination walks the globally-sorted dataset rather than just
  // re-ordering the visible page.
  const sortKey =
    sortBy && VALID_SORTS.has(sortBy as UpgraderSortBy)
      ? (sortBy as UpgraderSortBy)
      : "recent";
  let orderBy: string;
  if (sortKey === "multiplier") {
    // Realized multiplier = won / bet, only meaningful on wins with a
    // non-zero stake. CASE returns NULL for losses + zero-stake rows so
    // NULLS LAST pushes them after every ranked winner. Tiebreaker on
    // created_at keeps the order deterministic across same-multiplier
    // rows (and stable across paginated requests).
    orderBy = `ORDER BY
        CASE
          WHEN g.bet_amount::numeric > 0 AND g.won_amount::numeric > 0
            THEN g.won_amount::numeric / g.bet_amount::numeric
          ELSE NULL
        END DESC NULLS LAST,
        g.created_at DESC`;
  } else if (sortKey === "wonAmount") {
    // Absolute dollar payout to the user. Losses (won_amount = 0) all
    // tie at the bottom; deterministic tiebreaker on created_at.
    orderBy = `ORDER BY g.won_amount::numeric DESC, g.created_at DESC`;
  } else {
    orderBy = `ORDER BY g.created_at DESC`;
  }

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
      g.created_at,
      -- Bet-side ledger transaction id for this game. Walked through
      -- game_sessions, where game_id = upgrader_games.id and
      -- bet_ledger_tx_id is the upgrader_bet row that paid the stake.
      -- Lets the UI deep-link each row to the canonical
      -- /transactions/[id] detail page (which already surfaces the PF
      -- roll + the card the ticket landed on).
      gs.bet_ledger_tx_id::text AS ledger_tx_id
    FROM upgrader_games g
    LEFT JOIN "user" u ON u.id = g.user_id
    LEFT JOIN game_sessions gs
      ON gs.game_type = 'upgrader' AND gs.game_id = g.id
    ${baseWhere}
    ${orderBy}
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
    ledger_tx_id: string | null;
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
      ledgerTxId: r.ledger_tx_id,
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
