import "server-only";

import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { toNumber } from "@/lib/utils/decimal";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";
import { getCreatorSessionWindowsCte } from "@/lib/queries/creator-session-windows";
import {
  WAGER_TYPES_SQL,
  PAYOUT_TYPES_SQL,
} from "@/lib/queries/_wager-payout-types";
import {
  periodToCutoff,
  type InsightsPeriod,
} from "@/app/(admin)/insights/analytics/types";

/**
 * Money Flow — decompose the gap between GGR and P&L over a window.
 *
 * The user's mental model after staring at /ggr and /dashboard:
 *
 *   "Our GGR was $290k but P&L was only $17k — where did the other
 *    $273k go?"
 *
 * This helper surfaces every line item that sits in that gap so the
 * admin can interpret it line-by-line. Nothing here changes the
 * canonical GGR or P&L formulas — those still live in dashboard.ts +
 * pnl.ts and remain the single source of truth.
 *
 *
 * ─── The identity ─────────────────────────────────────────────────
 *
 * Canonical windowed P&L (from `pnl.ts → calculateWindowedPnl`):
 *
 *   PnL = deposits − (manual_wd + card_wd) − balanceΔ − inventoryΔ − voucherΔ
 *
 * The ledger gives `balanceΔ` directly: every completed row carries
 * `balance_after − balance_before`. Summing across the window gives
 * the Δbalance term.
 *
 * Now decompose `balanceΔ` by ledger type. Every credit type bumps
 * balance up, every debit type bumps it down. Splitting the per-type
 * sums into:
 *
 *   deposits        — credit, balance up
 *   manual_wd       — admin_balance_adjustment Manual withdrawal rows, debit
 *   wagers          — pack_opening, battle_bet, …, debit
 *   payouts         — battle_refund, deposit_bonus, …, credit
 *   other_credits   — admin_balance_adjustment credits NOT manual_wd
 *   other_debits    — other admin_balance_adjustment debits, fees, etc.
 *
 * gives `balanceΔ = deposits − manual_wd + payouts_all − wagers_all + other`,
 * where `wagers_all` / `payouts_all` are the UNFILTERED wager/payout
 * sums (creator on-stream legs included — they still moved balance).
 *
 * Substituting back into PnL:
 *
 *   PnL = deposits − manual_wd − card_wd
 *         − (deposits − manual_wd + payouts_all − wagers_all + other)
 *         − inventoryΔ − voucherΔ
 *
 *       = (wagers_all − payouts_all) − card_wd − inventoryΔ − voucherΔ − other
 *
 *       = GGR_unfiltered − card_wd − inventoryΔ − voucherΔ − other
 *
 * where `GGR_unfiltered = (wagers_all − payouts_all)`.
 *
 * The HEADLINE GGR shown on /ggr and the dashboard FILTERS creator on-
 * stream sessions out of BOTH the wager and payout side (so creator
 * stream sponsorship doesn't pollute customer GGR). That is what the
 * `ggr` field below returns.
 *
 * The gap between headline GGR and P&L is therefore:
 *
 *   card_withdrawals + inventoryΔ + voucherΔ + (GGR − GGR_unfiltered) + other
 *                                              └─────────┬────────┘
 *                                              creator on-stream GGR
 *
 * which we collect into a single `residual` line so admins see exactly
 * what the four named terms don't account for. The residual is
 * dominated by:
 *   • Creator on-stream GGR (filtered out of `ggr` but not balanceΔ)
 *   • admin_balance_adjustment rows that aren't tagged Manual withdrawal
 *   • fee types outside `withdrawal_shipping_fee`
 *   • off-window timing edge cases
 *
 *
 * ─── Bonuses ──────────────────────────────────────────────────────
 *
 * Bonuses are NOT a separate term in the gap — they're already inside
 * the GGR formula's payout subtraction (deposit_bonus, rakeback_claim,
 * race_prize, etc. are payout-side ledger types). They reduce GGR
 * directly.
 *
 * We still show a per-type bonus breakdown as an informational
 * sub-section because the user wants to see "how much did each
 * marketing/reward surface cost us in this window". The breakdown sums
 * to a subset of `payouts` already inside the GGR formula — it's
 * pedagogical, not additive.
 *
 *
 * ─── Time series ──────────────────────────────────────────────────
 *
 * Daily series of GGR + bonuses + P&L so admins can spot whether the
 * gap is uniform across the window or driven by a single day's
 * inventory/voucher event.
 */

export type MoneyFlowDecomposition = {
  /** Effective rolling cutoff used by every aggregate below. ISO string for serialisation. */
  cutoffIso: string;
  /** Human label of the period (e.g. "Last 24h"). */
  periodLabel: string;

  /** GGR for the window — wagers − payouts (same definition as the headline). */
  ggr: number;
  /** Total wagers (informational — drives GGR's numerator). */
  wagers: number;
  /** Total payouts (informational — what GGR's denominator subtracts). */
  payouts: number;

  /**
   * Bonus subset of `payouts` broken down by ledger type — what each
   * reward / marketing surface cost the house in the window. Sum is
   * `bonusesTotal`. NOT a separate term in the GGR→P&L gap, but the
   * user asked for it.
   */
  bonusesByType: Array<{ type: string; total: number }>;
  bonusesTotal: number;

  /** Gross deposits credited in the window. */
  deposits: number;
  /** Manual + card withdrawals settled in the window. */
  manualWithdrawals: number;
  cardWithdrawals: number;

  /** Inventory δ — obtained − disposed (sold/exchanged). Positive = users got cards they kept. */
  inventoryDelta: number;
  /** Voucher δ — issued − claimed. Positive = vouchers grew. */
  voucherDelta: number;

  /** Windowed P&L using the canonical formula. */
  pnl: number;

  /** Residual = GGR − cardWithdrawals − inventoryΔ − voucherΔ − pnl. Should be small. */
  residual: number;

  /** Daily series of GGR + bonusesTotal + pnl over the window. */
  timeSeries: Array<{ date: string; ggr: number; bonuses: number; pnl: number }>;
};

/**
 * Ledger types we treat as "bonuses" — costs that exist purely because
 * we choose to fund marketing / retention / community rewards.
 *
 * Subset of `WAGER_PAYOUT_PAYOUT_TYPES`. Battle refunds, card sales,
 * card exchanges, exchange-excess credits, and upgrader payouts are
 * NOT in this list — those are gameplay payouts (the user's own
 * winnings), not marketing cost.
 */
const BONUS_TYPES = [
  "deposit_bonus",
  "rakeback_claim",
  "voucher_redeemed",
  "gift_card_redeemed",
  "promo_code_redeemed",
  "race_prize",
  "rain_win",
  "waitlist_prize",
  "creator_tip",
  "balance_reward_claim",
  "affiliate_claim",
  "voucher_exchange",
  "exchange_excess_to_voucher",
  "battle_excess_to_voucher",
] as const;

const BONUS_TYPES_SQL = `(${BONUS_TYPES.map((t) => `'${t}'`).join(",")})`;

/**
 * Cached inner query — one trip to the DB per (period, blacklist,
 * sessions) tuple. 60s revalidate matches the dashboard auto-refresh
 * cadence so the Money Flow tab tracks the same freshness window as
 * the headline cards on /ggr and /dashboard.
 */
const cachedMoneyFlow = unstable_cache(
  async (
    cutoffIso: string,
    blacklistIdNotIn: string,
    blacklistUidNotIn: string,
    sessionWindowsCte: string,
  ) => {
    const db = await getDb();
    const cutoff = new Date(cutoffIso);

    const wagerIn = Prisma.raw(WAGER_TYPES_SQL);
    const payoutIn = Prisma.raw(PAYOUT_TYPES_SQL);
    const bonusIn = Prisma.raw(BONUS_TYPES_SQL);

    // ── Headline aggregates ──────────────────────────────────────
    // Single GROUP BY scan over the period slice of
    // `ledger_transactions` for everything that comes from the
    // ledger. Inventory + voucher + card-withdrawal are their own
    // tables and run in parallel below. Same in_session filter as
    // the headline GGR (drops creator on-stream rows symmetrically).
    type AggRow = {
      wagers: string;
      payouts: string;
      bonuses: string;
      deposits: string;
      manual_wd: string;
    };
    type BonusByTypeRow = { type: string; total: string };
    type CardWdRow = { total: string };
    type InvRow = { obtained: string; disposed: string };
    type VchRow = { issued: string; claimed: string };
    type SeriesRow = {
      date: Date;
      ggr: string;
      bonuses: string;
      pnl: string;
    };

    const [agg, bonusByType, cardWd, inv, vch, series] = await Promise.all([
      db.$queryRaw<AggRow[]>`
        WITH real_users AS (
          SELECT u.id, u.role
          FROM "user" u
          WHERE u.role NOT IN ('admin', 'support') ${Prisma.raw(blacklistIdNotIn)}
        ),
        ${Prisma.raw(sessionWindowsCte)},
        base AS (
          SELECT lt.type, lt.amount::numeric AS amount, lt.created_at,
                 lt.balance_before, lt.balance_after, lt.description,
                 CASE WHEN ru.role = 'creator'
                      THEN EXISTS (
                        SELECT 1 FROM session_windows sw
                        WHERE sw.uid = lt.user_id
                          AND lt.created_at >= sw.win_start
                          AND lt.created_at <  sw.win_end
                      )
                      ELSE false END AS in_session
          FROM ledger_transactions lt
          JOIN real_users ru ON ru.id = lt.user_id
          WHERE lt.status = 'completed' AND lt.created_at >= ${cutoff}
        )
        SELECT
          COALESCE(SUM(CASE WHEN type IN ${wagerIn}  AND NOT in_session THEN ABS(amount) ELSE 0 END), 0)::text AS wagers,
          COALESCE(SUM(CASE WHEN type IN ${payoutIn} AND NOT in_session THEN ABS(amount) ELSE 0 END), 0)::text AS payouts,
          COALESCE(SUM(CASE WHEN type IN ${bonusIn}                       THEN ABS(amount) ELSE 0 END), 0)::text AS bonuses,
          COALESCE(SUM(CASE WHEN type = 'deposit'                         THEN amount ELSE 0 END), 0)::text AS deposits,
          COALESCE(SUM(CASE WHEN type = 'admin_balance_adjustment'
                            AND balance_after < balance_before
                            AND description ILIKE 'Manual withdrawal:%'
                                                                          THEN amount ELSE 0 END), 0)::text AS manual_wd
        FROM base
      `,
      db.$queryRaw<BonusByTypeRow[]>`
        WITH real_users AS (
          SELECT u.id FROM "user" u
          WHERE u.role NOT IN ('admin', 'support') ${Prisma.raw(blacklistIdNotIn)}
        )
        SELECT lt.type::text AS type,
               COALESCE(SUM(ABS(lt.amount::numeric)), 0)::text AS total
        FROM ledger_transactions lt
        JOIN real_users ru ON ru.id = lt.user_id
        WHERE lt.status = 'completed'
          AND lt.created_at >= ${cutoff}
          AND lt.type IN ${bonusIn}
        GROUP BY lt.type
        ORDER BY total DESC
      `,
      db.$queryRaw<CardWdRow[]>`
        SELECT COALESCE(SUM(cwr.total_value_usd::numeric), 0)::text AS total
        FROM card_withdrawal_requests cwr
        JOIN "user" u ON u.id = cwr.user_id
        WHERE cwr.status IN ('completed', 'shipped')
          AND COALESCE(cwr.completed_at, cwr.shipped_at) >= ${cutoff}
          AND u.role NOT IN ('admin', 'support')
          ${Prisma.raw(blacklistUidNotIn)}
      `,
      db.$queryRaw<InvRow[]>`
        SELECT
          COALESCE(SUM(CASE WHEN ui.obtained_at >= ${cutoff} THEN ui.value_at_obtained::numeric ELSE 0 END), 0)::text AS obtained,
          COALESCE(SUM(CASE WHEN (ui.sold_at >= ${cutoff} OR ui.exchanged_at >= ${cutoff}) THEN ui.value_at_obtained::numeric ELSE 0 END), 0)::text AS disposed
        FROM user_inventory ui
        JOIN "user" u ON u.id = ui.user_id
        WHERE (ui.obtained_at >= ${cutoff} OR ui.sold_at >= ${cutoff} OR ui.exchanged_at >= ${cutoff})
          AND u.role NOT IN ('admin', 'support')
          ${Prisma.raw(blacklistUidNotIn)}
      `,
      db.$queryRaw<VchRow[]>`
        SELECT
          COALESCE(SUM(CASE WHEN v.created_at >= ${cutoff} THEN v.value::numeric ELSE 0 END), 0)::text AS issued,
          COALESCE(SUM(CASE WHEN v.claimed_at >= ${cutoff} THEN v.value::numeric ELSE 0 END), 0)::text AS claimed
        FROM vouchers v
        JOIN "user" u ON u.id = v.user_id
        WHERE (v.created_at >= ${cutoff} OR v.claimed_at >= ${cutoff})
          AND u.role NOT IN ('admin', 'support')
          ${Prisma.raw(blacklistUidNotIn)}
      `,
      // Daily time series of GGR, bonuses, and P&L. Built from the
      // same primitives as the headline aggregates but bucketed per
      // day. Card withdrawals + inventory + voucher movements are
      // their own per-day terms via UNION ALL so the P&L identity
      // can be assembled per day in JS.
      db.$queryRaw<SeriesRow[]>`
        WITH real_users AS (
          SELECT u.id, u.role
          FROM "user" u
          WHERE u.role NOT IN ('admin', 'support') ${Prisma.raw(blacklistIdNotIn)}
        ),
        ${Prisma.raw(sessionWindowsCte)},
        base AS (
          SELECT DATE(lt.created_at) AS d,
                 lt.type, lt.amount::numeric AS amount,
                 lt.balance_before, lt.balance_after, lt.description,
                 lt.user_id,
                 CASE WHEN ru.role = 'creator'
                      THEN EXISTS (
                        SELECT 1 FROM session_windows sw
                        WHERE sw.uid = lt.user_id
                          AND lt.created_at >= sw.win_start
                          AND lt.created_at <  sw.win_end
                      )
                      ELSE false END AS in_session
          FROM ledger_transactions lt
          JOIN real_users ru ON ru.id = lt.user_id
          WHERE lt.status = 'completed' AND lt.created_at >= ${cutoff}
        ),
        daily_ledger AS (
          SELECT
            d,
            COALESCE(SUM(CASE WHEN type IN ${wagerIn}  AND NOT in_session THEN ABS(amount) ELSE 0 END), 0) AS wagers,
            COALESCE(SUM(CASE WHEN type IN ${payoutIn} AND NOT in_session THEN ABS(amount) ELSE 0 END), 0) AS payouts,
            COALESCE(SUM(CASE WHEN type IN ${bonusIn}                       THEN ABS(amount) ELSE 0 END), 0) AS bonuses,
            COALESCE(SUM(CASE WHEN type = 'deposit'                         THEN amount ELSE 0 END), 0) AS deposits,
            COALESCE(SUM(CASE WHEN type = 'admin_balance_adjustment'
                              AND balance_after < balance_before
                              AND description ILIKE 'Manual withdrawal:%'
                                                                            THEN amount ELSE 0 END), 0) AS manual_wd,
            COALESCE(SUM((balance_after - balance_before)::numeric), 0) AS balance_change
          FROM base
          GROUP BY d
        ),
        daily_card_wd AS (
          SELECT DATE(COALESCE(cwr.completed_at, cwr.shipped_at)) AS d,
                 COALESCE(SUM(cwr.total_value_usd::numeric), 0) AS card_wd
          FROM card_withdrawal_requests cwr
          JOIN "user" u ON u.id = cwr.user_id
          WHERE cwr.status IN ('completed', 'shipped')
            AND COALESCE(cwr.completed_at, cwr.shipped_at) >= ${cutoff}
            AND u.role NOT IN ('admin', 'support')
            ${Prisma.raw(blacklistUidNotIn)}
          GROUP BY DATE(COALESCE(cwr.completed_at, cwr.shipped_at))
        ),
        daily_inventory AS (
          SELECT d, COALESCE(SUM(obtained), 0) - COALESCE(SUM(disposed), 0) AS inv_delta
          FROM (
            SELECT DATE(ui.obtained_at) AS d, ui.value_at_obtained::numeric AS obtained, 0::numeric AS disposed
            FROM user_inventory ui
            JOIN "user" u ON u.id = ui.user_id
            WHERE ui.obtained_at >= ${cutoff}
              AND u.role NOT IN ('admin', 'support')
              ${Prisma.raw(blacklistUidNotIn)}
            UNION ALL
            SELECT DATE(COALESCE(ui.sold_at, ui.exchanged_at)) AS d, 0::numeric AS obtained, ui.value_at_obtained::numeric AS disposed
            FROM user_inventory ui
            JOIN "user" u ON u.id = ui.user_id
            WHERE (ui.sold_at >= ${cutoff} OR ui.exchanged_at >= ${cutoff})
              AND u.role NOT IN ('admin', 'support')
              ${Prisma.raw(blacklistUidNotIn)}
          ) x
          GROUP BY d
        ),
        daily_voucher AS (
          SELECT d, COALESCE(SUM(issued), 0) - COALESCE(SUM(claimed), 0) AS vch_delta
          FROM (
            SELECT DATE(v.created_at) AS d, v.value::numeric AS issued, 0::numeric AS claimed
            FROM vouchers v
            JOIN "user" u ON u.id = v.user_id
            WHERE v.created_at >= ${cutoff}
              AND u.role NOT IN ('admin', 'support')
              ${Prisma.raw(blacklistUidNotIn)}
            UNION ALL
            SELECT DATE(v.claimed_at) AS d, 0::numeric AS issued, v.value::numeric AS claimed
            FROM vouchers v
            JOIN "user" u ON u.id = v.user_id
            WHERE v.claimed_at >= ${cutoff}
              AND u.role NOT IN ('admin', 'support')
              ${Prisma.raw(blacklistUidNotIn)}
          ) x
          GROUP BY d
        )
        SELECT
          dl.d AS date,
          (dl.wagers - dl.payouts)::text AS ggr,
          dl.bonuses::text AS bonuses,
          -- Per-day P&L = deposits − (manual_wd + card_wd) − balanceΔ
          --   − inventoryΔ − voucherΔ (matches calculateWindowedPnl).
          (
            dl.deposits
            - (dl.manual_wd + COALESCE(cw.card_wd, 0))
            - dl.balance_change
            - COALESCE(di.inv_delta, 0)
            - COALESCE(dv.vch_delta, 0)
          )::text AS pnl
        FROM daily_ledger dl
        LEFT JOIN daily_card_wd cw ON cw.d = dl.d
        LEFT JOIN daily_inventory di ON di.d = dl.d
        LEFT JOIN daily_voucher dv ON dv.d = dl.d
        ORDER BY dl.d
      `,
    ]);

    return {
      agg: agg[0] ?? {
        wagers: "0",
        payouts: "0",
        bonuses: "0",
        deposits: "0",
        manual_wd: "0",
      },
      bonusByType,
      cardWd: cardWd[0]?.total ?? "0",
      inv: inv[0] ?? { obtained: "0", disposed: "0" },
      vch: vch[0] ?? { issued: "0", claimed: "0" },
      series,
    };
  },
  ["insights-analytics-money-flow-v1"],
  { revalidate: 60, tags: ["insights-analytics", "dashboard-stats"] },
);

/**
 * Decompose the GGR → P&L gap for the selected period.
 *
 * Read-only against Main DB. Every aggregate excludes staff + the
 * admin-managed blacklist (same scope as /ggr and /dashboard's GGR
 * card) so the headline numbers match those pages by construction.
 *
 * Returns the per-line-item totals + a residual term that surfaces
 * what the identity can't explain (admin adjustments, fee types not
 * in the wager set, edge-case timings). The residual is honest —
 * if it's large, the panel labels it as such instead of hiding it.
 */
export async function getMoneyFlowDecomposition(
  period: InsightsPeriod,
  periodLabel: string,
): Promise<MoneyFlowDecomposition> {
  const now = new Date();
  const cutoff = periodToCutoff(period, now);

  const [excluded, sessionWindowsCte] = await Promise.all([
    getExcludedUserIds(),
    getCreatorSessionWindowsCte(),
  ]);
  const blacklistIdNotIn = blacklistNotInClause("id", excluded);
  const blacklistUidNotIn = blacklistNotInClause("u.id", excluded);

  const { agg, bonusByType, cardWd, inv, vch, series } = await cachedMoneyFlow(
    cutoff.toISOString(),
    blacklistIdNotIn,
    blacklistUidNotIn,
    sessionWindowsCte,
  );

  const wagers = toNumber(agg.wagers);
  const payouts = toNumber(agg.payouts);
  const ggr = wagers - payouts;
  const bonusesTotal = toNumber(agg.bonuses);
  const deposits = toNumber(agg.deposits);
  const manualWithdrawals = toNumber(agg.manual_wd);
  const cardWithdrawals = toNumber(cardWd);
  const inventoryDelta = toNumber(inv.obtained) - toNumber(inv.disposed);
  const voucherDelta = toNumber(vch.issued) - toNumber(vch.claimed);

  // P&L using the canonical windowed formula — for the totals we
  // can short-circuit via the algebraic identity:
  //   pnl ≈ GGR − cardWd − inventoryΔ − voucherΔ
  // but to keep the residual honest, compute pnl from the
  // ledger-derived balance change instead — that way the
  // residual surfaces ledger flows the wager/payout sets don't
  // cover. We compute pnl via the timeSeries sum below.
  const pnlFromSeries = series.reduce((sum, row) => sum + toNumber(row.pnl), 0);
  const pnl = pnlFromSeries;

  // The identity: GGR − card_wd − inventoryΔ − voucherΔ − pnl = residual.
  // residual ≠ 0 means the balance ledger moved through paths not
  // captured by the wager/payout type sets (admin adjustments not
  // tagged Manual withdrawal, asymmetry between creator on-stream
  // filtering on the wager+payout side vs. the actual balance ledger,
  // fee types outside `withdrawal_shipping_fee`, etc.).
  const residual = ggr - cardWithdrawals - inventoryDelta - voucherDelta - pnl;

  return {
    cutoffIso: cutoff.toISOString(),
    periodLabel,
    ggr,
    wagers,
    payouts,
    bonusesByType: bonusByType.map((row) => ({
      type: row.type,
      total: toNumber(row.total),
    })),
    bonusesTotal,
    deposits,
    manualWithdrawals,
    cardWithdrawals,
    inventoryDelta,
    voucherDelta,
    pnl,
    residual,
    timeSeries: series.map((row) => ({
      date: new Date(row.date).toISOString().slice(0, 10),
      ggr: toNumber(row.ggr),
      bonuses: toNumber(row.bonuses),
      pnl: toNumber(row.pnl),
    })),
  };
}
