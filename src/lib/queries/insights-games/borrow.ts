import "server-only";

import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import { getCreatorSessionWindowsCte } from "../creator-session-windows";
import {
  type GamesPeriod,
  hoursForPeriod,
  realCustomersScopeSql,
} from "./_shared";

/**
 * Borrow-play analytics for the period — the SAME data the other
 * tabs DROP, surfaced here so admins can quantify the borrow
 * activity itself.
 *
 *   • totals.borrowedAmountSum — total sticker exposure house
 *     fronted across all borrow plays in the period (the part NOT
 *     billed through the ledger).
 *   • totals.cashPaidSum — what the user actually paid out of
 *     their balance for the same plays.
 *   • totals.stickerSum  — cashPaidSum + borrowedAmountSum (the
 *     "headline" exposure that includes house-fronted dollars).
 *   • totals.borrowedPlaysCount — number of plays that used
 *     borrow > 0%.
 *   • totals.borrowSharePct — borrowedAmountSum / stickerSum × 100
 *     (what fraction of total exposure was borrow-funded).
 *
 *   • topUsers — top borrowers in the period: total borrow they
 *     drew, total paid, and ratio.
 *
 * Distinguishes solo borrow opens (ledger description carries the
 * "X% borrowed" tag) and battle borrow opens (battles.borrow_percentage
 * > 0). For solo opens we read the % off
 * `provably_fair_results.result_metadata.borrow_percentage` (the
 * convention used in `users-transactions.ts`). For battles the
 * percentage is on the battle row itself.
 *
 * Creator-on-stream rows are excluded so the figures here are
 * customer-only — matches the rest of the page.
 */

export type BorrowTopUserRow = {
  userId: string;
  username: string | null;
  image: string | null;
  borrowedAmountSum: number;
  cashPaidSum: number;
  borrowPlays: number;
  avgBorrowPct: number;
};

export type BorrowAnalyticsData = {
  period: GamesPeriod;
  totals: {
    borrowedPlaysCount: number;
    cashPaidSum: number;
    borrowedAmountSum: number;
    stickerSum: number;
    borrowSharePct: number;
    totalPlaysIncludingNonBorrow: number;
    borrowShareOfPlaysPct: number;
  };
  topUsers: BorrowTopUserRow[];
};

export async function getBorrowAnalytics(
  period: GamesPeriod,
): Promise<BorrowAnalyticsData> {
  return withTiming("insights-games.borrow", async () => {
    const db = await getDb();
    const scope = await realCustomersScopeSql();
    const sessionWindowsCte = await getCreatorSessionWindowsCte();
    const hours = hoursForPeriod(period);
    const ltCutoff =
      hours !== null
        ? `AND lt.created_at >= NOW() - INTERVAL '${hours} hours'`
        : "";

    type TotalRow = {
      borrow_plays: string;
      total_plays: string;
      cash_paid_sum: string;
      borrowed_amount_sum: string;
      sticker_sum: string;
    };
    type TopUserRow = {
      user_id: string;
      username: string | null;
      image: string | null;
      borrowed_sum: string;
      cash_paid_sum: string;
      borrow_plays: string;
      avg_borrow_pct: string;
    };

    // The per-row borrow % is read like the rest of the site:
    //   • For solo pack opens — JSON extract `provably_fair_results
    //     .result_metadata->>'borrow_percentage'` cast to numeric.
    //     One PF result per session shares the % (matches the
    //     extraction convention in users-transactions.ts:476-495).
    //   • For battles — `battles.borrow_percentage` direct.
    //
    // borrowed_usd per row = cash_paid * (pct / (100 - pct)) when
    // pct in (0, 100). The ledger amount is what was billed AFTER
    // the borrow cut — so if a $1k pack at 90% borrow billed the
    // user $100, then borrowed = 100 * (90 / 10) = $900. Sum these
    // per-row to get total borrow exposure. Sticker per row =
    // cash_paid + borrowed = $100 + $900 = $1000.
    //
    // (We never trust pct=100 — that would mean fully sponsored,
    // not borrow; the LEAST(...) clamp keeps the math finite.)
    const [totalRows, topUserRows] = await Promise.all([
      db.$queryRawUnsafe<TotalRow[]>(
        `WITH ${sessionWindowsCte},
              base AS (
           SELECT
             lt.id,
             lt.user_id,
             ABS(lt.amount::numeric) AS cash_paid,
             CASE
               WHEN lt.type = 'pack_opening'
                 THEN COALESCE(
                   (
                     SELECT NULLIF(pf.result_metadata->>'borrow_percentage', '')::numeric
                     FROM provably_fair_results pf
                     WHERE pf.game_session_id = lt.game_session_id
                     LIMIT 1
                   ),
                   0
                 )
               WHEN lt.type IN ('battle_bet','battle_sponsorship')
                 THEN COALESCE(
                   (
                     SELECT COALESCE(b.borrow_percentage, 0)::numeric
                     FROM battle_participants bp
                     JOIN battles b ON b.id = bp.battle_id
                     WHERE bp.game_session_id = lt.game_session_id
                     LIMIT 1
                   ),
                   0
                 )
               ELSE 0
             END AS borrow_pct
           FROM ledger_transactions lt
           WHERE lt.status = 'completed'
             AND lt.type IN ('pack_opening','battle_bet','battle_sponsorship')
             AND lt.user_id IN ${scope}
             AND NOT EXISTS (
               SELECT 1 FROM session_windows sw
               WHERE sw.uid = lt.user_id
                 AND lt.created_at >= sw.win_start
                 AND lt.created_at <  sw.win_end
             )
             ${ltCutoff}
         )
         SELECT
           COUNT(*) FILTER (WHERE borrow_pct > 0)::text AS borrow_plays,
           COUNT(*)::text AS total_plays,
           COALESCE(SUM(cash_paid) FILTER (WHERE borrow_pct > 0), 0)::text AS cash_paid_sum,
           COALESCE(SUM(
             CASE
               WHEN borrow_pct > 0 AND borrow_pct < 100
                 THEN cash_paid * (borrow_pct / (100 - borrow_pct))
               ELSE 0
             END
           ), 0)::text AS borrowed_amount_sum,
           COALESCE(SUM(
             CASE
               WHEN borrow_pct > 0 AND borrow_pct < 100
                 THEN cash_paid * (100 / (100 - borrow_pct))
               WHEN borrow_pct = 0 THEN cash_paid
               ELSE cash_paid
             END
           ), 0)::text AS sticker_sum
         FROM base`,
      ),
      db.$queryRawUnsafe<TopUserRow[]>(
        `WITH ${sessionWindowsCte},
              base AS (
           SELECT
             lt.user_id,
             ABS(lt.amount::numeric) AS cash_paid,
             CASE
               WHEN lt.type = 'pack_opening'
                 THEN COALESCE(
                   (
                     SELECT NULLIF(pf.result_metadata->>'borrow_percentage', '')::numeric
                     FROM provably_fair_results pf
                     WHERE pf.game_session_id = lt.game_session_id
                     LIMIT 1
                   ),
                   0
                 )
               WHEN lt.type IN ('battle_bet','battle_sponsorship')
                 THEN COALESCE(
                   (
                     SELECT COALESCE(b.borrow_percentage, 0)::numeric
                     FROM battle_participants bp
                     JOIN battles b ON b.id = bp.battle_id
                     WHERE bp.game_session_id = lt.game_session_id
                     LIMIT 1
                   ),
                   0
                 )
               ELSE 0
             END AS borrow_pct
           FROM ledger_transactions lt
           WHERE lt.status = 'completed'
             AND lt.type IN ('pack_opening','battle_bet','battle_sponsorship')
             AND lt.user_id IN ${scope}
             AND NOT EXISTS (
               SELECT 1 FROM session_windows sw
               WHERE sw.uid = lt.user_id
                 AND lt.created_at >= sw.win_start
                 AND lt.created_at <  sw.win_end
             )
             ${ltCutoff}
         ),
         per_user AS (
           SELECT user_id,
                  SUM(
                    CASE
                      WHEN borrow_pct > 0 AND borrow_pct < 100
                        THEN cash_paid * (borrow_pct / (100 - borrow_pct))
                      ELSE 0
                    END
                  ) AS borrowed_sum,
                  SUM(CASE WHEN borrow_pct > 0 THEN cash_paid ELSE 0 END) AS cash_paid_sum,
                  COUNT(*) FILTER (WHERE borrow_pct > 0) AS borrow_plays,
                  AVG(borrow_pct) FILTER (WHERE borrow_pct > 0) AS avg_borrow_pct
           FROM base
           GROUP BY user_id
           HAVING SUM(CASE WHEN borrow_pct > 0 THEN 1 ELSE 0 END) > 0
         )
         SELECT
           pu.user_id::text AS user_id,
           u.username AS username,
           u.image AS image,
           pu.borrowed_sum::text AS borrowed_sum,
           pu.cash_paid_sum::text AS cash_paid_sum,
           pu.borrow_plays::text AS borrow_plays,
           COALESCE(pu.avg_borrow_pct, 0)::text AS avg_borrow_pct
         FROM per_user pu
         JOIN "user" u ON u.id = pu.user_id
         ORDER BY pu.borrowed_sum DESC NULLS LAST
         LIMIT 25`,
      ),
    ]);

    const t = totalRows[0];
    const cashPaidSum = toNumber(t?.cash_paid_sum);
    const borrowedAmountSum = toNumber(t?.borrowed_amount_sum);
    const stickerSum = toNumber(t?.sticker_sum);
    const borrowedPlaysCount = Number(t?.borrow_plays ?? "0");
    const totalPlaysIncludingNonBorrow = Number(t?.total_plays ?? "0");
    const borrowSharePct =
      stickerSum > 0 ? (borrowedAmountSum / stickerSum) * 100 : 0;
    const borrowShareOfPlaysPct =
      totalPlaysIncludingNonBorrow > 0
        ? (borrowedPlaysCount / totalPlaysIncludingNonBorrow) * 100
        : 0;

    const topUsers: BorrowTopUserRow[] = topUserRows.map((r) => ({
      userId: r.user_id,
      username: r.username,
      image: r.image,
      borrowedAmountSum: toNumber(r.borrowed_sum),
      cashPaidSum: toNumber(r.cash_paid_sum),
      borrowPlays: Number(r.borrow_plays),
      avgBorrowPct: toNumber(r.avg_borrow_pct),
    }));

    return {
      period,
      totals: {
        borrowedPlaysCount,
        cashPaidSum,
        borrowedAmountSum,
        stickerSum,
        borrowSharePct,
        totalPlaysIncludingNonBorrow,
        borrowShareOfPlaysPct,
      },
      topUsers,
    };
  });
}
