import { queryMainRows } from "@/lib/drizzle-query";
import "server-only";

import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import { getCreatorSessionWindowsCte } from "../creator-session-windows";
import {
  ggr as ggrFormula,
  empiricalRtp,
} from "@/lib/metrics/formulas";
import {
  type GamesPeriod,
  periodCutoffSqlCapped,
  realCustomersScopeSql,
} from "./_shared";
import { REWARD_PACK_SESSIONS } from "@/lib/metrics/gaming-sql";
import { ratioToPct } from "./_metrics";

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

export type BorrowTopUserDeepRow = BorrowTopUserRow & {
  totalWagerOnPage: number;
  borrowShareOfWagerPct: number;
};

export type BiggestBorrowPlayRow = {
  ledgerTxId: string;
  userId: string;
  username: string | null;
  image: string | null;
  type: "pack_opening" | "battle_bet" | "battle_sponsorship";
  cashPaid: number;
  borrowedAmount: number;
  stickerExposure: number;
  borrowPct: number;
  createdAt: string;
};

export type BorrowCohortRow = {
  label: "Borrowers" | "Non-borrowers";
  users: number;
  totalWager: number;
  totalPayout: number;
  avgWagerPerUser: number;
  avgPayoutPerUser: number;
  avgPnlPerUser: number;
  /** Empirical RTP % — null below MIN_SAMPLE plays in the cohort. */
  rtpPct: number | null;
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
  topUsers: BorrowTopUserDeepRow[];
  biggestPlay: BiggestBorrowPlayRow | null;
  cohorts: BorrowCohortRow[];
};

export async function getBorrowAnalytics(
  period: GamesPeriod,
): Promise<BorrowAnalyticsData> {
  return withTiming("insights-games.borrow", async () => {
    const scope = await realCustomersScopeSql();
    const sessionWindowsCte = await getCreatorSessionWindowsCte();
    // Lifetime (`all`) capped to 365d via periodCutoffSqlCapped so the
    // borrow ledger / inventory / upgrader scans never run unbounded
    // (CLAUDE.md "Performance & Daten-Laden"). Finite windows unchanged.
    const ltCutoff = periodCutoffSqlCapped("lt.created_at", period);
    const uiCutoff = periodCutoffSqlCapped("ui.obtained_at", period);
    const ugCutoff = periodCutoffSqlCapped("ug.created_at", period);

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
      total_wager_paid: string;
    };
    type BiggestPlayRow = {
      ledger_tx_id: string;
      user_id: string;
      username: string | null;
      image: string | null;
      type: string;
      cash_paid: string;
      borrow_pct: string;
      created_at: Date;
    };
    type CohortRow = {
      is_borrower: string;
      users: string;
      total_wager: string;
      total_payout: string;
      total_plays: string;
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
    const [totalRows, topUserRows, biggestPlayRows, cohortRows] = await Promise.all([
      queryMainRows<TotalRow[]>(
        `WITH ${sessionWindowsCte},
              base AS (
           SELECT
             lt.id,
             lt.user_id,
             ABS(lt.amount::numeric) AS cash_paid,
             CASE
               WHEN lt.type::text = 'pack_opening'
                 THEN COALESCE(
                   (
                     SELECT NULLIF(pf.result_metadata->>'borrow_percentage', '')::numeric
                     FROM provably_fair_results pf
                     WHERE pf.game_session_id = lt.game_session_id
                     LIMIT 1
                   ),
                   0
                 )
               WHEN lt.type::text IN ('battle_bet','battle_sponsorship')
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
             AND lt.type::text IN ('pack_opening','battle_bet','battle_sponsorship')
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
      queryMainRows<TopUserRow[]>(
        `WITH ${sessionWindowsCte},
              base AS (
           SELECT
             lt.user_id,
             ABS(lt.amount::numeric) AS cash_paid,
             CASE
               WHEN lt.type::text = 'pack_opening'
                 THEN COALESCE(
                   (
                     SELECT NULLIF(pf.result_metadata->>'borrow_percentage', '')::numeric
                     FROM provably_fair_results pf
                     WHERE pf.game_session_id = lt.game_session_id
                     LIMIT 1
                   ),
                   0
                 )
               WHEN lt.type::text IN ('battle_bet','battle_sponsorship')
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
             AND lt.type::text IN ('pack_opening','battle_bet','battle_sponsorship')
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
                  AVG(borrow_pct) FILTER (WHERE borrow_pct > 0) AS avg_borrow_pct,
                  SUM(cash_paid) AS total_wager_paid
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
           COALESCE(pu.avg_borrow_pct, 0)::text AS avg_borrow_pct,
           pu.total_wager_paid::text AS total_wager_paid
         FROM per_user pu
         JOIN "user" u ON u.id = pu.user_id
         ORDER BY pu.borrowed_sum DESC NULLS LAST
         LIMIT 25`,
      ),
      // Biggest single borrow play in the period — by absolute
      // borrow amount (cash_paid × borrow_pct / (100 − borrow_pct)),
      // so a 90%-borrow $100 cash-paid open ($900 fronted) ranks above
      // a 50%-borrow $200 cash-paid open ($200 fronted).
      queryMainRows<BiggestPlayRow[]>(
        `WITH ${sessionWindowsCte},
              base AS (
           SELECT
             lt.id::text AS ledger_tx_id,
             lt.user_id,
             lt.type::text AS type,
             ABS(lt.amount::numeric) AS cash_paid,
             lt.created_at,
             CASE
               WHEN lt.type::text = 'pack_opening'
                 THEN COALESCE(
                   (
                     SELECT NULLIF(pf.result_metadata->>'borrow_percentage', '')::numeric
                     FROM provably_fair_results pf
                     WHERE pf.game_session_id = lt.game_session_id
                     LIMIT 1
                   ),
                   0
                 )
               WHEN lt.type::text IN ('battle_bet','battle_sponsorship')
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
             AND lt.type::text IN ('pack_opening','battle_bet','battle_sponsorship')
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
           b.ledger_tx_id,
           b.user_id::text AS user_id,
           u.username AS username,
           u.image AS image,
           b.type,
           b.cash_paid::text AS cash_paid,
           b.borrow_pct::text AS borrow_pct,
           b.created_at
         FROM base b
         JOIN "user" u ON u.id = b.user_id
         WHERE b.borrow_pct > 0 AND b.borrow_pct < 100
         ORDER BY (b.cash_paid * (b.borrow_pct / (100 - b.borrow_pct))) DESC
         LIMIT 1`,
      ),
      // Borrow vs non-borrow user cohort — for each user, classify them
      // as borrower (≥1 borrow play in period) or non-borrower (0
      // borrow plays). Sum wager + payout across all their games (not
      // just the borrowed legs — the cohort comparison is total user
      // economics). Includes upgrader on both sides since
      // borrowers/non-borrowers can also play upgrader.
      queryMainRows<CohortRow[]>(
        `WITH ${sessionWindowsCte},
              non_borrow_pack_sessions AS (
           SELECT game_session_id FROM ledger_transactions
           WHERE type::text = 'pack_opening' AND status = 'completed'
             AND game_session_id IS NOT NULL
             AND (description IS NULL OR description NOT ILIKE '%borrow%')
         ),
         non_borrow_battle_sessions AS (
           SELECT bp.game_session_id FROM battle_participants bp
           JOIN battles b ON b.id = bp.battle_id
           WHERE COALESCE(b.borrow_percentage, 0) = 0
         ),
         borrowers AS (
           SELECT DISTINCT lt.user_id
           FROM ledger_transactions lt
           WHERE lt.status = 'completed'
             AND lt.user_id IN ${scope}
             AND NOT EXISTS (
               SELECT 1 FROM session_windows sw
               WHERE sw.uid = lt.user_id
                 AND lt.created_at >= sw.win_start
                 AND lt.created_at <  sw.win_end
             )
             ${ltCutoff}
             AND (
               (lt.type::text = 'pack_opening' AND lt.description ILIKE '%borrow%')
               OR (lt.type::text IN ('battle_bet','battle_sponsorship')
                   AND lt.game_session_id IN (
                     SELECT bp.game_session_id FROM battle_participants bp
                     JOIN battles b ON b.id = bp.battle_id
                     WHERE COALESCE(b.borrow_percentage, 0) > 0
                   ))
             )
         ),
         per_user_wager AS (
           -- Pack/battle wager only — upgrader wager is sourced from
           -- upgrader_games below (it is NOT booked to the ledger).
           -- Canonical gaming legs (matches overview.ts / @/lib/metrics):
           --   • pack_opening: non-borrow AND not a reward/daily pack
           --     (Fix 2 — REWARD_PACK_SESSIONS, NULL-guarded).
           --   • battle_bet: borrow-gated by its game_session.
           --   • battle_sponsorship: counted DIRECTLY (Fix 1) — its rows
           --     have game_session_id = NULL so the IN-gate would drop
           --     them; all sponsored battles are borrow_percentage=0.
           SELECT lt.user_id,
                  COALESCE(SUM(ABS(lt.amount::numeric)), 0) AS wager,
                  COUNT(*) AS plays
           FROM ledger_transactions lt
           WHERE lt.status = 'completed'
             AND lt.type::text IN ('pack_opening','battle_bet','battle_sponsorship')
             AND lt.user_id IN ${scope}
             AND (
               (lt.type::text = 'pack_opening'
                AND (lt.description IS NULL OR lt.description NOT ILIKE '%borrow%')
                AND (lt.game_session_id IS NULL OR lt.game_session_id NOT IN ${REWARD_PACK_SESSIONS}))
               OR (lt.type::text = 'battle_bet' AND lt.game_session_id IN (SELECT game_session_id FROM non_borrow_battle_sessions))
               OR lt.type::text = 'battle_sponsorship'
             )
             AND NOT EXISTS (
               SELECT 1 FROM session_windows sw
               WHERE sw.uid = lt.user_id
                 AND lt.created_at >= sw.win_start
                 AND lt.created_at <  sw.win_end
             )
             ${ltCutoff}
           GROUP BY lt.user_id
         ),
         per_user_inv_payout AS (
           SELECT ui.user_id,
                  COALESCE(SUM(ui.value_at_obtained::numeric), 0) AS payout
           FROM user_inventory ui
           WHERE ui.source_type IN ('pack','battle')
             AND ui.user_id IN ${scope}
             AND (
               (ui.source_type = 'pack' AND ui.source_id IN (SELECT game_session_id FROM non_borrow_pack_sessions))
               OR (ui.source_type = 'battle' AND ui.source_id IN (SELECT game_session_id FROM non_borrow_battle_sessions))
             )
             -- Drop reward/daily-pack won cards (Fix 2), keyed on source_id
             -- (the originating game_session_id) — symmetric with the wager
             -- side so the cohort P&L matches the canonical gaming legs.
             AND (ui.source_id IS NULL OR ui.source_id NOT IN ${REWARD_PACK_SESSIONS})
             AND NOT EXISTS (
               SELECT 1 FROM session_windows sw
               WHERE sw.uid = ui.user_id
                 AND ui.obtained_at >= sw.win_start
                 AND ui.obtained_at <  sw.win_end
             )
             ${uiCutoff}
           GROUP BY ui.user_id
         ),
         per_user_ug AS (
           -- Upgrader wager + payout + play count from upgrader_games
           -- (the canonical upgrader source — both sides come from here).
           SELECT ug.user_id,
                  COALESCE(SUM(ug.bet_amount::numeric), 0) AS wager,
                  COALESCE(SUM(ug.won_amount::numeric), 0) AS payout,
                  COUNT(*) AS plays
           FROM upgrader_games ug
           WHERE ug.user_id IN ${scope}
             AND NOT EXISTS (
               SELECT 1 FROM session_windows sw
               WHERE sw.uid = ug.user_id
                 AND ug.created_at >= sw.win_start
                 AND ug.created_at <  sw.win_end
             )
             ${ugCutoff}
           GROUP BY ug.user_id
         ),
         all_users AS (
           SELECT user_id FROM per_user_wager
           UNION
           SELECT user_id FROM per_user_inv_payout
           UNION
           SELECT user_id FROM per_user_ug
         ),
         per_user_pnl AS (
           SELECT u.user_id,
                  COALESCE(w.wager, 0) + COALESCE(g.wager, 0) AS wager,
                  COALESCE(p.payout, 0) + COALESCE(g.payout, 0) AS payout,
                  COALESCE(w.plays, 0) + COALESCE(g.plays, 0) AS plays
           FROM all_users u
           LEFT JOIN per_user_wager w ON w.user_id = u.user_id
           LEFT JOIN per_user_inv_payout p ON p.user_id = u.user_id
           LEFT JOIN per_user_ug g ON g.user_id = u.user_id
         )
         SELECT
           CASE WHEN b.user_id IS NOT NULL THEN '1' ELSE '0' END AS is_borrower,
           COUNT(*)::text AS users,
           COALESCE(SUM(p.wager), 0)::text AS total_wager,
           COALESCE(SUM(p.payout), 0)::text AS total_payout,
           COALESCE(SUM(p.plays), 0)::text AS total_plays
         FROM per_user_pnl p
         LEFT JOIN borrowers b ON b.user_id = p.user_id
         GROUP BY (b.user_id IS NOT NULL)`,
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

    const topUsers: BorrowTopUserDeepRow[] = topUserRows.map((r) => {
      const totalWagerOnPage = toNumber(r.total_wager_paid);
      const borrowedAmountSum = toNumber(r.borrowed_sum);
      const cashPaidSum = toNumber(r.cash_paid_sum);
      // Borrow share of sticker — the house-fronted dollars as a
      // fraction of the user's full sticker exposure (cash paid for
      // every play + house-fronted borrow). Tells the operator how
      // much of the user's total bet volume was on credit.
      const stickerExposure = totalWagerOnPage + borrowedAmountSum;
      const borrowShareOfWagerPct =
        stickerExposure > 0 ? (borrowedAmountSum / stickerExposure) * 100 : 0;
      return {
        userId: r.user_id,
        username: r.username,
        image: r.image,
        borrowedAmountSum,
        cashPaidSum,
        borrowPlays: Number(r.borrow_plays),
        avgBorrowPct: toNumber(r.avg_borrow_pct),
        totalWagerOnPage,
        borrowShareOfWagerPct,
      };
    });

    // Biggest single borrow play in the period.
    const biggestRow = biggestPlayRows[0];
    let biggestPlay: BiggestBorrowPlayRow | null = null;
    if (biggestRow) {
      const cashPaid = toNumber(biggestRow.cash_paid);
      const borrowPct = toNumber(biggestRow.borrow_pct);
      const borrowedAmount =
        borrowPct > 0 && borrowPct < 100
          ? cashPaid * (borrowPct / (100 - borrowPct))
          : 0;
      biggestPlay = {
        ledgerTxId: biggestRow.ledger_tx_id,
        userId: biggestRow.user_id,
        username: biggestRow.username,
        image: biggestRow.image,
        type: biggestRow.type as BiggestBorrowPlayRow["type"],
        cashPaid,
        borrowedAmount,
        stickerExposure: cashPaid + borrowedAmount,
        borrowPct,
        createdAt: biggestRow.created_at.toISOString(),
      };
    }

    // Cohort comparison — split users into borrowers (≥1 borrow play
    // in period) and non-borrowers; report avg wager / payout / P&L
    // per user so the two cohorts can be compared apples-to-apples.
    const cohortMap: Record<"1" | "0", BorrowCohortRow> = {
      "1": {
        label: "Borrowers",
        users: 0,
        totalWager: 0,
        totalPayout: 0,
        avgWagerPerUser: 0,
        avgPayoutPerUser: 0,
        avgPnlPerUser: 0,
        rtpPct: 0,
      },
      "0": {
        label: "Non-borrowers",
        users: 0,
        totalWager: 0,
        totalPayout: 0,
        avgWagerPerUser: 0,
        avgPayoutPerUser: 0,
        avgPnlPerUser: 0,
        rtpPct: 0,
      },
    };
    for (const r of cohortRows) {
      const key = r.is_borrower === "1" ? "1" : "0";
      const acc = cohortMap[key];
      acc.users = Number(r.users);
      acc.totalWager = toNumber(r.total_wager);
      acc.totalPayout = toNumber(r.total_payout);
      const plays = Number(r.total_plays);
      acc.avgWagerPerUser = acc.users > 0 ? acc.totalWager / acc.users : 0;
      acc.avgPayoutPerUser = acc.users > 0 ? acc.totalPayout / acc.users : 0;
      // Per-user P&L = avg wager − avg payout; expressed via the
      // canonical GGR helper (house POV) so the sign convention matches
      // the rest of the metric layer. RTP routes through the canonical
      // sample-guarded helper (null below MIN_SAMPLE plays in the cohort).
      acc.avgPnlPerUser = ggrFormula({
        wager: acc.avgWagerPerUser,
        gamingPayout: acc.avgPayoutPerUser,
      });
      acc.rtpPct = ratioToPct(
        empiricalRtp({
          gamingPayout: acc.totalPayout,
          wager: acc.totalWager,
          bets: plays,
        }),
      );
    }
    const cohorts: BorrowCohortRow[] = [cohortMap["1"], cohortMap["0"]];

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
      biggestPlay,
      cohorts,
    };
  });
}
