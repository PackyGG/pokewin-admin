import "server-only";

import { unstable_cache } from "next/cache";

import { drizzleForEnv } from "@/lib/db";
import { queryRows } from "@/lib/drizzle-query";
import { readDbEnv, type DbEnv } from "@/lib/db-env";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { escapeBlacklistIds } from "@/lib/queries/_blacklist";
import {
  COVERING_CREATOR_SQL,
  WITHDRAWN_UNITS_SQL,
} from "@/lib/queries/creators-pnl";
import { toNumber } from "@/lib/utils/decimal";

/**
 * Past-deal variant of {@link getFrameAffiliatePnlByUser} — same
 * coverage-attributed methodology, but keyed by BOARD (a creator may have
 * many past boards / past deals, each with its own window). The user-keyed
 * version collapses one creator → one row, which is correct for the
 * Active view (one current frame per creator) but wrong for Past Deals
 * (the same creator can appear N times, once per past board).
 *
 * For a given `(boardId, creatorUserId, [start, end])` window:
 *
 *   affiliatesMadeUs = depositsInWindow − cardWithdrawalsInWindow
 *                      − affiliateClaimsInWindow
 *
 * The MEMBERSHIP cohort stays on the 365-day lifetime set (same as
 * {@link getFrameAffiliatePnlByUser} / `getCreatorPnl`), so a card
 * withdrawn during a past deal still attributes even when the producing
 * wager / first deposit predates the frame. Only the deposit/withdrawal
 * EVENT times are narrowed to the per-board window.
 *
 * MAIN/prod game DB is READ-ONLY; this only SELECTs.
 */

/** A single past-board window — the PnL is summed inside [start, end]. */
export type BoardWindow = {
  /** Backend leaderboard id (map key — unique per board, even when same creator owns multiple). */
  boardId: string;
  /** Creator whose code-cohort drives the attribution. */
  creatorUserId: string;
  /** Frame start (ISO). */
  startIso: string;
  /** Frame end (ISO) — for past boards this is in the past. */
  endIso: string;
};

const LIFETIME_LOOKBACK_DAYS = 365;

export type BoardAffiliatePnl = {
  /**
   * depositsInWindow − cardWithdrawalsInWindow − affiliateClaimsInWindow
   * (house POV: + = we kept value).
   */
  affiliatesMadeUs: number;
  deposits: number;
  cardWithdrawals: number;
  affiliateClaims: number;
};

const cachedBoardPnl = (
  env: DbEnv,
  boards: BoardWindow[],
  blacklistIds: string[],
) =>
  unstable_cache(
    async (): Promise<[string, BoardAffiliatePnl][]> => {
      const db = drizzleForEnv(env);

      // (boardId, creatorUserId, start, end) tuples — boardId is unique per
      // row; creatorUserId may repeat (same creator, multiple past boards).
      const tuples: string[] = [];
      const params: unknown[] = [];
      boards.forEach((b, i) => {
        const base = i * 4;
        tuples.push(
          `($${base + 1}::text, $${base + 2}::text, $${base + 3}::timestamptz, $${base + 4}::timestamptz)`,
        );
        params.push(b.boardId, b.creatorUserId, b.startIso, b.endIso);
      });

      const blacklistDepAnd =
        blacklistIds.length > 0
          ? ` AND dr.user_id NOT IN (${escapeBlacklistIds(blacklistIds)})`
          : "";
      const blacklistSessAnd =
        blacklistIds.length > 0
          ? ` AND u.id NOT IN (${escapeBlacklistIds(blacklistIds)})`
          : "";

      const sql = `WITH frames(board_id, cid, start_ts, end_ts) AS (
          VALUES ${tuples.join(", ")}
        ),
        bounds AS (
          SELECT MIN(start_ts) AS min_start, MAX(end_ts) AS max_end FROM frames
        ),
        -- Coverage-attributed deposits over the widest window we need.
        dep_raw AS (
          SELECT lt.user_id,
                 lt.created_at,
                 lt.amount::numeric AS amount,
                 u.role::text AS role,
                 ${COVERING_CREATOR_SQL} AS creator_id
            FROM ledger_transactions lt
            JOIN "user" u ON u.id = lt.user_id
           WHERE lt.type::text = 'deposit'
             AND lt.status = 'completed'
             AND lt.created_at >= LEAST(
                   (SELECT min_start FROM bounds),
                   NOW() - INTERVAL '${LIFETIME_LOOKBACK_DAYS} days'
                 )
             AND lt.created_at <= (SELECT max_end FROM bounds)
        ),
        -- Deposits INSIDE each board's window for that board's creator.
        dep AS (
          SELECT f.board_id,
                 COALESCE(SUM(dr.amount), 0) AS deposits
            FROM dep_raw dr
            JOIN frames f
              ON f.cid = dr.creator_id
             AND dr.created_at >= f.start_ts
             AND dr.created_at <= f.end_ts
           WHERE dr.creator_id IS NOT NULL
             AND dr.user_id <> dr.creator_id
             AND dr.role NOT IN ('admin', 'support', 'creator')${blacklistDepAnd}
           GROUP BY f.board_id
        ),
        -- 365d coverage-depositor membership per creator.
        deptors AS (
          SELECT DISTINCT dr.creator_id, dr.user_id
            FROM dep_raw dr
            JOIN frames f ON f.cid = dr.creator_id
           WHERE dr.creator_id IS NOT NULL
             AND dr.created_at >= NOW() - INTERVAL '${LIFETIME_LOOKBACK_DAYS} days'
        ),
        -- 365d wager-session membership per creator.
        sess AS (
          SELECT DISTINCT acu.affiliate_user_id AS creator_id,
                 acu.game_session_id
            FROM affiliate_code_usages acu
            JOIN "user" u ON u.id = acu.referred_user_id
            JOIN frames f ON f.cid = acu.affiliate_user_id
           WHERE acu.usage_type::text = 'wager'
             AND acu.game_session_id IS NOT NULL
             AND acu.created_at >= NOW() - INTERVAL '${LIFETIME_LOOKBACK_DAYS} days'
             AND u.role NOT IN ('admin', 'support', 'creator')
             AND u.id <> acu.affiliate_user_id${blacklistSessAnd}
        ),
        -- Withdrawn units INSIDE each board's window for cohort members.
        wd AS (
          SELECT f.board_id,
                 COALESCE(SUM(wu.value), 0) AS card_withdrawals
            FROM ${WITHDRAWN_UNITS_SQL} wu
            JOIN frames f
              ON wu.withdrawn_at >= f.start_ts
             AND wu.withdrawn_at <= f.end_ts
            JOIN deptors dp ON dp.creator_id = f.cid AND dp.user_id = wu.user_id
            JOIN sess s ON s.creator_id = f.cid AND s.game_session_id = wu.source_id
           GROUP BY f.board_id
        ),
        -- Creator's OWN affiliate_claim earnings claimed INSIDE the window.
        claims AS (
          SELECT f.board_id,
                 COALESCE(SUM(lt.amount::numeric), 0) AS affiliate_claims
            FROM ledger_transactions lt
            JOIN frames f
              ON f.cid = lt.user_id
             AND lt.created_at >= f.start_ts
             AND lt.created_at <= f.end_ts
           WHERE lt.type::text = 'affiliate_claim'
             AND lt.status = 'completed'
           GROUP BY f.board_id
        )
        SELECT f.board_id,
               COALESCE(d.deposits, 0)::text AS deposits,
               COALESCE(w.card_withdrawals, 0)::text AS card_withdrawals,
               COALESCE(cl.affiliate_claims, 0)::text AS affiliate_claims
          FROM frames f
          LEFT JOIN dep d ON d.board_id = f.board_id
          LEFT JOIN wd w ON w.board_id = f.board_id
          LEFT JOIN claims cl ON cl.board_id = f.board_id`;

      const rows = await queryRows<
          {
            board_id: string;
            deposits: string;
            card_withdrawals: string;
            affiliate_claims: string;
          }[]
        >(db, sql, ...params);

      return rows.map((r) => {
        const deposits = toNumber(r.deposits);
        const cardWithdrawals = toNumber(r.card_withdrawals);
        const affiliateClaims = toNumber(r.affiliate_claims);
        return [
          r.board_id,
          {
            deposits,
            cardWithdrawals,
            affiliateClaims,
            affiliatesMadeUs: deposits - cardWithdrawals - affiliateClaims,
          },
        ] satisfies [string, BoardAffiliatePnl];
      });
    },
    [
      "profitability-board-affiliate-pnl-v1",
      env,
      ...boards.map(
        (b) => `${b.boardId}:${b.creatorUserId}:${b.startIso}:${b.endIso}`,
      ),
      ...blacklistIds,
    ],
    { revalidate: 300, tags: ["profitability-board-affiliate-pnl"] },
  );

/**
 * Per-board affiliate-PnL. Returns a Map keyed by `boardId` → PnL legs
 * computed strictly inside that board's window using the creator's
 * 365-day coverage cohort. Boards absent from the result map have no
 * activity (0 across the board) — callers default to 0.
 */
export async function getBoardAffiliatePnl(
  boards: BoardWindow[],
): Promise<Map<string, BoardAffiliatePnl>> {
  if (boards.length === 0) return new Map();
  const env = await readDbEnv();
  const blacklistIds = await getExcludedUserIds();
  const entries = await cachedBoardPnl(env, boards, blacklistIds)();
  return new Map(entries);
}
