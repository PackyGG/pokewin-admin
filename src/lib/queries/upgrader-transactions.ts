import { queryRows } from "@/lib/drizzle-query";
import { unstable_cache } from "next/cache";
import { readDbEnv, type DbEnv } from "@/lib/db-env";
import { readDrizzleForEnv } from "@/lib/db";
import type { PaginatedResult } from "@/lib/types";
import {
  resolveUpgraderMetadata,
  upgraderTargetMultiplierSql,
} from "@/lib/utils/upgrader-metadata";

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
 *
 * ── PERFORMANCE (2026-06-14): pre-slice before the LATERALs ────────────
 * The old query ran TWO correlated `JOIN LATERAL`s over `game_sessions`
 * (≈544k rows, NO index on `game_id` — verified read-only on live prod:
 * the only secondary index is the partial `idx_game_sessions_created_at_
 * user_bet ON (user_id IS NOT NULL)`). Because `WHERE`/`ORDER`/`LIMIT`
 * were applied AFTER the joins, each LATERAL full-seq-scanned all 544k
 * rows for EVERY upgrader_games row — a 1.7-billion-cost plan that hangs
 * the segment forever (>12s; deeper OFFSET pages never completed at all).
 *
 * Fix = pre-slice the page of ids FIRST (`page_ids` CTE: the same
 * search + outcome WHERE and the same ORDER BY, then LIMIT/OFFSET), then
 * resolve the per-row data ONLY for those ≤20 games. Instead of running
 * the two LATERALs per row (which would still be 2×20 = 40 seq-scans),
 * the upgrader `game_sessions` for the whole page are materialized in a
 * SINGLE pass (`sess` CTE) and BOTH legs are derived from it:
 *   • `best_sess`  — DISTINCT ON (game_id) reproduces the old LATERAL-1
 *                    "best session" pick (prefer a row WITH
 *                    bet_ledger_tx_id, then newest) → bet_ledger_tx_id.
 *   • `pf_agg`     — the old LATERAL-2 aggregate (best/all metadata +
 *                    MAX target) over ALL PF rows of ALL upgrader
 *                    sessions for the game, GROUP BY game_id.
 * Net: ONE seq-scan of game_sessions per page instead of 40. Verified on
 * live prod (read-only): plan drops to ~0.8s and the output is
 * BYTE-IDENTICAL to the old query across all filters / sorts / pages
 * (default feed p1+deep, win, loss, multiplier sort, wonAmount sort —
 * incl. the best_metadata / all_metadata JSON + best_target columns).
 *
 * The owner-only real root fix is an index on `game_sessions(game_id)`
 * (would turn each lookup into a sub-ms index seek). MAIN is strictly
 * read-only / no-DDL, so that is an OWNER action — this rewrite makes the
 * unindexed path cheap (single scan) and the page degrade-not-hang via
 * the safeQuery timeout + unstable_cache warm path at the call site.
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
  /**
   * Target cashout multiplier the user picked BEFORE the spin
   * (e.g. 5 for "5×"). Parsed defensively from
   * `provably_fair_results.result_metadata` via
   * `parseUpgraderMetadata` — the blob shape isn't pinned by the
   * backend (see upgrader-metadata.ts notes), so this is null when
   * the key isn't present. Visible on every row, including losses,
   * so admins can read "user aimed at X×" without clicking through
   * to the detail popup. Same parser as the per-user Gaming tab and
   * the /transactions/upgrader detail dialog (commit 5f22020), so
   * the three surfaces never disagree on what they show.
   */
  targetMultiplier: number | null;
  /**
   * Target win-chance % (0–100). Either stored directly in the
   * metadata blob or derived from `targetMultiplier` (1 / multiplier
   * × 100 when no house edge is present). Null when neither path
   * resolves a value. Surfaced as a small "Win % 19.8%" sub-line on
   * the row so the configuration the user picked reads together
   * with the outcome — matches the convention on /users/[id] Gaming.
   */
  targetChance: number | null;
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

/**
 * The shaped page returned by the query — every field is a serializable
 * primitive (createdAt is already an ISO string), so the `unstable_cache`
 * JSON round-trip is lossless: no Date column survives into the cached
 * payload, so there is nothing to coerce back from a string on a cache
 * hit. (The raw `created_at` Date IS toISOString()'d inside the compute
 * fn, BEFORE it crosses the cache boundary.)
 */
async function computeUpgraderTransactions(
  env: DbEnv,
  params: {
    page?: number;
    perPage?: number;
    search?: string;
    outcome?: string;
    sortBy?: string;
  },
): Promise<PaginatedResult<UpgraderTransactionRow>> {
  const { page = 1, perPage = 20, search, outcome, sortBy } = params;
  // Resolve the Drizzle client from the threaded environment without reading
  // the request cookie inside the cached callback.
  // illegal inside unstable_cache. Env is resolved in the request scope
  // by the public entry point and passed through as a cache-key dimension
  // (mirrors getDepositTransactions in transactions.ts).
  const db = readDrizzleForEnv(env);

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

  // ── Pre-slice + single-scan data query ──────────────────────────────
  //
  // 1. `page_ids` — the EXACT page of upgrader_games rows (same search +
  //    outcome WHERE, same ORDER BY, then LIMIT/OFFSET). This is the only
  //    place the full upgrader_games table is touched for ordering; the
  //    expensive per-row work below runs ONLY for these ≤20 ids.
  //
  // 2. `sess` (MATERIALIZED) — every upgrader `game_sessions` row for the
  //    page's games, fetched in ONE scan. Joining `game_sessions` to the
  //    small `page_ids` set lets the planner do a single seq-scan over
  //    game_sessions instead of one per row. (No index on game_id exists
  //    on prod, so this single scan is the unindexed floor; an owner-side
  //    game_sessions(game_id) index would make it an index probe.)
  //
  // 3. `best_sess` — DISTINCT ON (game_id) reproduces the old LATERAL-1
  //    pick: prefer a session WITH a bet_ledger_tx_id, then the newest.
  //
  // 4. `pf_agg` — the old LATERAL-2 aggregate over ALL PF rows of ALL
  //    upgrader sessions for each game, GROUP BY game_id. best_metadata /
  //    all_metadata / best_target are computed exactly as before; the
  //    INNER JOIN to provably_fair_results means a game with no PF rows
  //    has no pf_agg row (LEFT JOIN below yields NULL) — identical to the
  //    old empty-aggregate behavior (best/target NULL, all_metadata
  //    COALESCE'd to '[]' at the SELECT).
  const pfTargetExpr = upgraderTargetMultiplierSql("pf.result_metadata");
  const userJoinForData = `LEFT JOIN "user" u ON u.id = g.user_id`;
  const dataSql = `
    WITH page_ids AS (
      SELECT g.id, g.created_at
      FROM upgrader_games g
      ${needsUserJoinForSearch ? userJoinForData : ""}
      ${baseWhere}
      ${orderBy}
      LIMIT ${safePerPage}
      OFFSET ${offset}
    ),
    sess AS MATERIALIZED (
      SELECT gs.id, gs.game_id, gs.bet_ledger_tx_id, gs.created_at
      FROM game_sessions gs
      JOIN page_ids pid ON pid.id = gs.game_id
      WHERE gs.game_type::text = 'upgrader'
    ),
    best_sess AS (
      SELECT DISTINCT ON (game_id) game_id, bet_ledger_tx_id
      FROM sess
      ORDER BY
        game_id,
        CASE WHEN bet_ledger_tx_id IS NOT NULL THEN 0 ELSE 1 END,
        created_at DESC
    ),
    pf_agg AS (
      SELECT
        s.game_id,
        (array_agg(pf.result_metadata ORDER BY
          CASE WHEN ${pfTargetExpr} IS NOT NULL THEN 0 ELSE 1 END,
          pf.cursor ASC
        ))[1] AS best_metadata,
        COALESCE(
          jsonb_agg(pf.result_metadata ORDER BY pf.cursor ASC)
            FILTER (WHERE pf.result_metadata IS NOT NULL),
          '[]'::jsonb
        ) AS all_metadata,
        MAX(${pfTargetExpr}) AS best_target
      FROM sess s
      JOIN provably_fair_results pf ON pf.game_session_id = s.id
      GROUP BY s.game_id
    )
    SELECT
      g.id::text AS id,
      g.user_id,
      u.username,
      u.image,
      g.bet_amount::text AS bet_amount,
      g.won_amount::text AS won_amount,
      g.created_at,
      bs.bet_ledger_tx_id::text AS ledger_tx_id,
      to_jsonb(g) AS upgrader_game,
      pa.best_metadata AS result_metadata,
      COALESCE(pa.all_metadata, '[]'::jsonb) AS all_metadata,
      pa.best_target::text AS sql_target_multiplier
    FROM page_ids pid
    JOIN upgrader_games g ON g.id = pid.id
    ${userJoinForData}
    LEFT JOIN best_sess bs ON bs.game_id = g.id
    LEFT JOIN pf_agg pa ON pa.game_id = g.id
    ${orderBy}
  `;

  type Raw = {
    id: string;
    user_id: string;
    username: string | null;
    image: string | null;
    bet_amount: string;
    won_amount: string;
    created_at: Date | string;
    ledger_tx_id: string | null;
    upgrader_game: unknown;
    result_metadata: unknown;
    all_metadata: unknown[] | null;
    sql_target_multiplier: string | null;
  };

  const [countResult, rows] = await Promise.all([
    queryRows<{ total: string }[]>(db, countSql, ...queryParams),
    queryRows<Raw[]>(db, dataSql, ...queryParams),
  ]);

  const total = Number(countResult[0]?.total ?? "0");

  const data: UpgraderTransactionRow[] = rows.map((r) => {
    const betAmount = Number(r.bet_amount);
    const wonAmount = Number(r.won_amount);
    const isWin = wonAmount > 0;
    // Parse the per-spin config (target multiplier + win-chance %)
    // out of the PF metadata blob. parseUpgraderMetadata is safe to
    // call on any value (returns the all-null shape on non-objects /
    // missing rows), so we don't need to guard on r.result_metadata.
    const pfAll = Array.isArray(r.all_metadata) ? r.all_metadata : [];
    const sqlMult =
      r.sql_target_multiplier != null &&
      r.sql_target_multiplier !== "" &&
      Number.isFinite(Number(r.sql_target_multiplier))
        ? Number(r.sql_target_multiplier)
        : null;
    const cfg = resolveUpgraderMetadata(
      sqlMult != null ? { target_multiplier: sqlMult } : null,
      r.result_metadata,
      ...pfAll,
      r.upgrader_game,
    );
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
      createdAt: new Date(r.created_at).toISOString(),
      ledgerTxId: r.ledger_tx_id,
      targetMultiplier: cfg.targetMultiplier,
      targetChance: cfg.targetChance,
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

/**
 * Cross-request cache layer for the Upgrader transactions list.
 *
 * Wraps {@link computeUpgraderTransactions} in a 60s `unstable_cache`
 * keyed on `(env, page, perPage, search, outcome, sortBy)` — the args
 * passed to a cached fn participate in its key, so each distinct
 * filter/page/sort combo gets its own entry and re-viewing a page is an
 * instant cache hit. `env` is the FIRST key dimension so a dev-DB-toggled
 * admin's entries never collide with prod. Mirrors the env-gated
 * `unstable_cache` list pattern in transactions.ts (getDepositTransactions).
 *
 * The cached payload is the already-shaped {@link PaginatedResult}; every
 * field is a serializable primitive (createdAt is an ISO string), so the
 * cache's JSON round-trip is lossless — no Date column survives into the
 * payload, so there is nothing to coerce back on a cache hit.
 */
const cachedUpgraderTransactions = unstable_cache(
  computeUpgraderTransactions,
  ["transactions-upgrader-list-v1"],
  { revalidate: 60, tags: ["transactions-upgrader-list"] },
);

/**
 * Public entry point for the Upgrader transactions list. Resolves the
 * request's DB env (the cookie read happens HERE, in the request scope)
 * then delegates to the cached compute fn. See
 * {@link computeUpgraderTransactions} for the query itself.
 */
export async function getUpgraderTransactions(params: {
  page?: number;
  perPage?: number;
  search?: string;
  outcome?: string;
  sortBy?: string;
}): Promise<PaginatedResult<UpgraderTransactionRow>> {
  const env = await readDbEnv();
  return cachedUpgraderTransactions(env, params);
}
