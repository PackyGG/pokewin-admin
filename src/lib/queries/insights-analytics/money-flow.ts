import "server-only";

import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";
import { REWARD_PAYOUT_TYPES, RESIDUAL_TYPES } from "@/lib/metrics";
import {
  getWindowMetrics,
  getDailyGamingMetrics,
  sumLedgerTypes,
  type MetricWindow,
} from "@/lib/metrics/queries";
import { calculateWindowedPnl } from "@/lib/metrics/realized-pnl";
import {
  periodToCutoff,
  type InsightsPeriod,
} from "@/app/(admin)/insights/analytics/types";

/**
 * Money Flow — decompose the gap between GGR and P&L over a window, built
 * on the canonical `@/lib/metrics` layer (mirrors `cost-breakdown.ts`).
 *
 * The user's mental model after staring at /ggr and /dashboard:
 *
 *   "Our GGR was $290k but P&L was only $17k — where did the other
 *    $273k go?"
 *
 * This helper surfaces every line item in that gap so the admin can
 * interpret it line-by-line. It is an ASSEMBLY of the canonical metric
 * layer, NOT new math — every gaming-margin number is sourced from
 * `src/lib/metrics`, so this tab can no longer drift from /ggr, /dashboard
 * or /insights/cost-breakdown.
 *
 *
 * ─── The canonical identity (house POV) ─────────────────────────────
 *
 *   GGR  = wager − gamingPayout          (gaming-only, inventory-delta)
 *   NGR  = GGR  − rewardCost − netRain   (house-funded giveaways)
 *
 * `gamingPayout` is the VERIFIED inventory-delta model: Σ
 * `user_inventory.value_at_obtained` for pack/battle + |battle_refund|.
 * Card conversions (`card_sale`, `card_exchange`, `reward_card_sale`, the
 * voucher-exchange variants) are NEUTRAL — disposals of value the user
 * already owns — and NEVER touch GGR's payout side. `creator_tip` is a
 * RESIDUAL pass-through (not a reward cost); `affiliate_leaderboard_prize`
 * IS a reward cost (was a gap).
 *
 *
 * ─── GGR/NGR → realized P&L ─────────────────────────────────────────
 *
 * Canonical windowed P&L (balance-sheet truth, `calculateWindowedPnl`):
 *
 *   pnl = deposits − withdrawals − Δbalance − Δinventory − Δvouchers
 *
 * The gap from NGR (a gaming-margin number) down to realized P&L is the
 * balance-sheet movement the gaming margin doesn't see:
 *   • Inventory δ — cards users won and KEPT (unrealized user winnings,
 *     a house liability).
 *   • Card withdrawals — physical cards shipped out (liability realized).
 *   • Voucher δ — outstanding voucher liability (issued − claimed).
 *   • Every RESIDUAL_TYPES ledger flow (deposit cash-in, vault transfers,
 *     rain pool funding, creator tips, admin adjustments, creator-deal
 *     fills, …) — summed (with a house-POV sign) into a named residual
 *     total so the gap is auditable.
 *
 * Everything from NGR down to realized P&L should be accounted for by the
 * three liabilities + the RESIDUAL_TYPES flows; whatever is left is the
 * honest, surfaced residual:
 *
 *   residual = pnl − (NGR − inventoryΔ − cardWd − voucherΔ
 *                     + residualNamedTotal)
 *
 * which the panel labels honestly (and flags when it's a non-trivial
 * fraction of GGR) rather than fudging to zero. This is the SAME identity
 * `cost-breakdown.ts` uses, so the two surfaces' residuals reconcile.
 *
 *
 * ─── Bonuses ──────────────────────────────────────────────────────
 *
 * Bonuses (REWARD_PAYOUT_TYPES) are the GGR → NGR step — house-funded
 * marketing / retention / community rewards. They are shown per-type as an
 * informational sub-section ("what each reward surface cost"). `rain` is
 * surfaced as its NET house cost (max(0, rain_win − rain_tip)), the
 * owner-confirmed model, so the bonus lines sum to the canonical reward
 * cost (GGR − NGR).
 *
 *
 * ─── Time series ──────────────────────────────────────────────────
 *
 * Daily series of GGR + reward cost + P&L so admins can spot whether the
 * gap is uniform across the window or driven by a single day's
 * inventory/voucher event. GGR + reward come from the canonical
 * `getDailyGamingMetrics`; the per-day P&L is the same windowed
 * balance-sheet identity `calculateWindowedPnl` uses, bucketed per day on
 * the SAME real-customer scope.
 */

export type MoneyFlowDecomposition = {
  /** Effective rolling cutoff used by every aggregate below. ISO string for serialisation. */
  cutoffIso: string;
  /** Human label of the period (e.g. "Last 24h"). */
  periodLabel: string;

  /** Canonical GGR for the window — wager − gamingPayout (inventory-delta). */
  ggr: number;
  /** Canonical NGR — GGR − reward cost (with net rain). */
  ngr: number;
  /** Total wager (informational — drives GGR's numerator). */
  wagers: number;
  /** Canonical gaming payout (inventory wins + battle_refund) — what GGR subtracts. */
  payouts: number;

  /**
   * Reward cost broken down by category — what each reward / marketing
   * surface cost the house in the window. Sum is `bonusesTotal` = the
   * canonical reward cost (GGR − NGR). This is the GGR → NGR step, NOT
   * inside GGR.
   */
  bonusesByType: Array<{ type: string; total: number }>;
  bonusesTotal: number;

  /** Gross deposits credited in the window (real customers). */
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

  /** Honest unexplained residual from the NGR → P&L identity. Should be small. */
  residual: number;

  /** Daily series of GGR + reward cost + pnl over the window. */
  timeSeries: Array<{ date: string; ggr: number; bonuses: number; pnl: number }>;
};

/**
 * House-POV sign of a RESIDUAL_TYPES flow's effect on realized P&L:
 *   +1 — a net inflow to the house (lifts P&L),
 *   −1 — a net outflow (lowers P&L),
 *    0 — a transfer / escrow that nets out.
 *
 * Mirrors `cost-breakdown.ts` `residualGroup` exactly so the two surfaces
 * treat the residual identically. `sumLedgerTypes` returns the absolute
 * magnitude, so the sign is applied here.
 */
function residualSign(type: string): 1 | -1 | 0 {
  switch (type) {
    case "deposit":
      return 1; // cash in — balance-sheet inflow
    case "card_withdrawal":
    case "admin_balance_adjustment":
    case "rain_tip":
      return -1; // outflow / funding leg
    // Vault transfers, creator-tip pass-through, borrow remainder,
    // affiliate-leaderboard escrow, creator-deal fills — net transfers.
    case "vault_lock":
    case "vault_unlock":
    case "creator_tip":
    case "pack_borrow_to_voucher":
    case "affiliate_leaderboard_creation":
    case "affiliate_leaderboard_refund":
    case "creator_deal_fill_grant":
    case "creator_fill_activation":
    case "creator_fill_spend_tip":
    case "creator_fill_spend_battle":
    case "creator_fill_refund":
    case "creator_fill_conversion":
    case "creator_fill_forfeiture":
      return 0;
    default:
      return 0;
  }
}

/**
 * Headline balance-sheet terms (deposits / manual withdrawals) + bridge
 * terms (card withdrawals, inventory δ, voucher δ) on the canonical
 * real-customer scope (admin / support / creator + admin blacklist
 * dropped). Computed here so the waterfall foot reconciles with the metric
 * scope its head started from. `$queryRawUnsafe` with a server-built scope
 * predicate (same pattern as `cost-breakdown.ts` `getBridgeTerms`); the
 * cutoff is a server-constructed Date (never user input). Cached 60s to
 * match the dashboard cadence.
 */
const cachedBridge = unstable_cache(
  async (cutoffIso: string, scopeSql: string) => {
    const db = await getDb();
    const cutoff = new Date(cutoffIso);
    const since = `'${cutoff.toISOString()}'::timestamptz`;

    type DepWdRow = { deposits: string; manual_wd: string };
    type CardRow = { total: string };
    type InvRow = { obtained: string; disposed: string };
    type VchRow = { issued: string; claimed: string };

    const [depWd, cardWd, inv, vch] = await Promise.all([
      db.$queryRawUnsafe<DepWdRow[]>(
        `SELECT
           COALESCE(SUM(CASE WHEN lt.type = 'deposit' THEN lt.amount::numeric ELSE 0 END), 0)::text AS deposits,
           COALESCE(SUM(CASE WHEN lt.type = 'admin_balance_adjustment'
                             AND lt.balance_after < lt.balance_before
                             AND lt.description ILIKE 'Manual withdrawal:%'
                                                                            THEN lt.amount::numeric ELSE 0 END), 0)::text AS manual_wd
         FROM ledger_transactions lt
         JOIN "user" u ON u.id = lt.user_id
         WHERE lt.status = 'completed' AND lt.created_at >= ${since}
           AND ${scopeSql}`,
      ),
      db.$queryRawUnsafe<CardRow[]>(
        `SELECT COALESCE(SUM(cwr.total_value_usd::numeric), 0)::text AS total
         FROM card_withdrawal_requests cwr
         JOIN "user" u ON u.id = cwr.user_id
         WHERE cwr.status IN ('completed', 'shipped')
           AND COALESCE(cwr.completed_at, cwr.shipped_at) >= ${since}
           AND ${scopeSql}`,
      ),
      db.$queryRawUnsafe<InvRow[]>(
        `SELECT
           COALESCE(SUM(CASE WHEN ui.obtained_at >= ${since} THEN ui.value_at_obtained::numeric ELSE 0 END), 0)::text AS obtained,
           COALESCE(SUM(CASE WHEN (ui.sold_at >= ${since} OR ui.exchanged_at >= ${since}) THEN ui.value_at_obtained::numeric ELSE 0 END), 0)::text AS disposed
         FROM user_inventory ui
         JOIN "user" u ON u.id = ui.user_id
         WHERE (ui.obtained_at >= ${since} OR ui.sold_at >= ${since} OR ui.exchanged_at >= ${since})
           AND ${scopeSql}`,
      ),
      db.$queryRawUnsafe<VchRow[]>(
        `SELECT
           COALESCE(SUM(CASE WHEN v.created_at >= ${since} THEN v.value::numeric ELSE 0 END), 0)::text AS issued,
           COALESCE(SUM(CASE WHEN v.claimed_at >= ${since} THEN v.value::numeric ELSE 0 END), 0)::text AS claimed
         FROM vouchers v
         JOIN "user" u ON u.id = v.user_id
         WHERE (v.created_at >= ${since} OR v.claimed_at >= ${since})
           AND ${scopeSql}`,
      ),
    ]);

    return {
      deposits: depWd[0]?.deposits ?? "0",
      manualWd: depWd[0]?.manual_wd ?? "0",
      cardWd: cardWd[0]?.total ?? "0",
      inv: inv[0] ?? { obtained: "0", disposed: "0" },
      vch: vch[0] ?? { issued: "0", claimed: "0" },
    };
  },
  ["insights-analytics-money-flow-bridge-v2"],
  { revalidate: 60, tags: ["insights-analytics", "dashboard-stats"] },
);

/**
 * Per-day windowed P&L on the canonical real-customer scope (admin /
 * support / creator + admin blacklist dropped — the SAME scope
 * `calculateWindowedPnl({ excludeUserIds })` and `getWindowMetrics` use).
 *
 * This is balance-sheet arithmetic (the windowed-P&L identity), NOT a
 * gaming-margin formula, so it is reused here rather than re-deriving GGR.
 * Per day: deposits − (manual_wd + card_wd) − Δbalance − inventoryΔ −
 * voucherΔ. `$queryRawUnsafe` with a server-built scope predicate; cached
 * because the chart anchor is whole days.
 */
const cachedDailyPnl = unstable_cache(
  async (cutoffIso: string, scopeSql: string) => {
    const db = await getDb();
    const since = `'${new Date(cutoffIso).toISOString()}'::timestamptz`;

    type SeriesRow = { date: Date; pnl: string };
    return db.$queryRawUnsafe<SeriesRow[]>(
      `WITH real_users AS (
         SELECT u.id FROM "user" u WHERE ${scopeSql}
       ),
       ledger AS (
         SELECT DATE(lt.created_at) AS d,
                lt.type, lt.amount::numeric AS amount,
                lt.balance_before, lt.balance_after, lt.description
         FROM ledger_transactions lt
         JOIN real_users ru ON ru.id = lt.user_id
         WHERE lt.status = 'completed' AND lt.created_at >= ${since}
       ),
       daily_ledger AS (
         SELECT
           d,
           COALESCE(SUM(CASE WHEN type = 'deposit' THEN amount ELSE 0 END), 0) AS deposits,
           COALESCE(SUM(CASE WHEN type = 'admin_balance_adjustment'
                             AND balance_after < balance_before
                             AND description ILIKE 'Manual withdrawal:%'
                                                                           THEN amount ELSE 0 END), 0) AS manual_wd,
           COALESCE(SUM((balance_after - balance_before)::numeric), 0) AS balance_change
         FROM ledger
         GROUP BY d
       ),
       daily_card_wd AS (
         SELECT DATE(COALESCE(cwr.completed_at, cwr.shipped_at)) AS d,
                COALESCE(SUM(cwr.total_value_usd::numeric), 0) AS card_wd
         FROM card_withdrawal_requests cwr
         JOIN real_users ru ON ru.id = cwr.user_id
         WHERE cwr.status IN ('completed', 'shipped')
           AND COALESCE(cwr.completed_at, cwr.shipped_at) >= ${since}
         GROUP BY DATE(COALESCE(cwr.completed_at, cwr.shipped_at))
       ),
       daily_inventory AS (
         SELECT d, COALESCE(SUM(obtained), 0) - COALESCE(SUM(disposed), 0) AS inv_delta
         FROM (
           SELECT DATE(ui.obtained_at) AS d, ui.value_at_obtained::numeric AS obtained, 0::numeric AS disposed
           FROM user_inventory ui
           JOIN real_users ru ON ru.id = ui.user_id
           WHERE ui.obtained_at >= ${since}
           UNION ALL
           SELECT DATE(COALESCE(ui.sold_at, ui.exchanged_at)) AS d, 0::numeric AS obtained, ui.value_at_obtained::numeric AS disposed
           FROM user_inventory ui
           JOIN real_users ru ON ru.id = ui.user_id
           WHERE (ui.sold_at >= ${since} OR ui.exchanged_at >= ${since})
         ) x
         GROUP BY d
       ),
       daily_voucher AS (
         SELECT d, COALESCE(SUM(issued), 0) - COALESCE(SUM(claimed), 0) AS vch_delta
         FROM (
           SELECT DATE(v.created_at) AS d, v.value::numeric AS issued, 0::numeric AS claimed
           FROM vouchers v
           JOIN real_users ru ON ru.id = v.user_id
           WHERE v.created_at >= ${since}
           UNION ALL
           SELECT DATE(v.claimed_at) AS d, 0::numeric AS issued, v.value::numeric AS claimed
           FROM vouchers v
           JOIN real_users ru ON ru.id = v.user_id
           WHERE v.claimed_at >= ${since}
         ) x
         GROUP BY d
       )
       SELECT
         dl.d AS date,
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
       ORDER BY dl.d`,
    );
  },
  ["insights-analytics-money-flow-daily-pnl-v1"],
  { revalidate: 60, tags: ["insights-analytics", "dashboard-stats"] },
);

/**
 * Live creator-id list — dropped from the canonical metric scope (which
 * excludes `creator` by role). Used to align `calculateWindowedPnl` (which
 * only excludes admin/support) with the `getWindowMetrics` scope so the
 * whole waterfall sits on one population.
 */
async function getCreatorIds(): Promise<string[]> {
  const db = await getDb();
  const rows = await db.user.findMany({
    where: { role: "creator" },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/**
 * Decompose the GGR → P&L gap for the selected period, entirely on the
 * canonical `@/lib/metrics` layer.
 *
 * Read-only against Main DB. Every gaming-margin figure comes from
 * `getWindowMetrics` / `getDailyGamingMetrics`; reward costs from
 * `sumLedgerTypes`; realized P&L from `calculateWindowedPnl`; the
 * balance-sheet bridge terms on the SAME real-customer + borrow-corrected
 * scope. The residual is the honest NGR → P&L gap after the named terms.
 */
export async function getMoneyFlowDecomposition(
  period: InsightsPeriod,
  periodLabel: string,
): Promise<MoneyFlowDecomposition> {
  const now = new Date();
  const cutoff = periodToCutoff(period, now);
  // Canonical window: lifetime → no lower bound; otherwise the cutoff.
  const window: MetricWindow = {
    since: period === "lifetime" ? null : cutoff,
  };

  const [excluded, creatorIds] = await Promise.all([
    getExcludedUserIds(),
    getCreatorIds(),
  ]);
  // The canonical metric scope drops creators by role; align the
  // realized-P&L and bridge-term scopes (which only drop admin/support) by
  // adding the live creator-id list to the drop set.
  const dropUserIds = [...excluded, ...creatorIds];
  // Real-customer scope predicate for the raw bridge/per-day queries —
  // drop admin/support/creator by role + the (blacklist ∪ creator-id) drop
  // list (server-built ids, escaped by `blacklistNotInClause`).
  const scopeSql = `u.role NOT IN ('admin', 'support', 'creator') ${blacklistNotInClause("u.id", dropUserIds)}`;

  const [
    metrics,
    windowedPnl,
    bridge,
    dailyMetrics,
    dailyPnl,
    rewardSums,
    residualSums,
  ] = await Promise.all([
    getWindowMetrics({ window }),
    calculateWindowedPnl({ since: cutoff, excludeUserIds: dropUserIds }),
    cachedBridge(cutoff.toISOString(), scopeSql),
    getDailyGamingMetrics(window),
    cachedDailyPnl(cutoff.toISOString(), scopeSql),
    // Reward cost per category (excl. rain — rain is netted below so the
    // bonus lines sum to the canonical reward cost GGR − NGR).
    Promise.all(
      REWARD_PAYOUT_TYPES.filter((t) => t !== "rain_win").map(async (type) => ({
        type,
        total: await sumLedgerTypes({ types: [type], window }),
      })),
    ),
    // RESIDUAL_TYPES named total — every balance-sheet / transfer / escrow
    // ledger flow excluded from the gaming margin, summed via the SAME
    // scope so the residual is auditable.
    Promise.all(
      RESIDUAL_TYPES.map(async (type) => ({
        type,
        total: await sumLedgerTypes({ types: [type], window }),
      })),
    ),
  ]);

  const wagers = metrics.wager;
  const payouts = metrics.gamingPayout;
  const ggr = metrics.ggr;
  const ngr = metrics.ngr;
  const netRainCost = metrics.rainHouseCost;

  // ── Reward / bonus categories ────────────────────────────────────
  // One line per reward ledger type (>0), plus rain as its NET house cost
  // so the lines sum to GGR − NGR.
  const bonusesByType = [
    ...rewardSums.filter((r) => r.total > 0),
    ...(netRainCost > 0 ? [{ type: "rain_win", total: netRainCost }] : []),
  ].sort((a, b) => b.total - a.total);
  // Canonical reward cost = GGR − NGR (reward-excl-rain + net rain). The
  // per-category lines above sum to this by construction.
  const bonusesTotal = ggr - ngr;

  const deposits = toNumber(bridge.deposits);
  const manualWithdrawals = toNumber(bridge.manualWd);
  const cardWithdrawals = toNumber(bridge.cardWd);
  const inventoryDelta =
    toNumber(bridge.inv.obtained) - toNumber(bridge.inv.disposed);
  const voucherDelta =
    toNumber(bridge.vch.issued) - toNumber(bridge.vch.claimed);
  const pnl = windowedPnl.pnl;

  // ── Honest residual (NGR → P&L identity) ─────────────────────────
  // Sum the RESIDUAL_TYPES flows with their house-POV sign on P&L (mirrors
  // cost-breakdown's `residualNamedTotal`).
  const residualNamedTotal = residualSums.reduce(
    (sum, { type, total }) => sum + residualSign(type) * total,
    0,
  );
  // Everything from NGR down to realized P&L should be accounted for by
  // the three liabilities + the RESIDUAL_TYPES flows. The unexplained
  // residual is whatever is left:
  //   NGR − inventoryΔ − cardWd − voucherΔ + residualNamedTotal
  //   + residual = pnl
  const explainedFromNgr =
    ngr - inventoryDelta - cardWithdrawals - voucherDelta + residualNamedTotal;
  const residual = pnl - explainedFromNgr;

  // ── Daily series ─────────────────────────────────────────────────
  // GGR + reward cost (= GGR − NGR per day) from the canonical daily
  // metrics; P&L per day from the windowed balance-sheet identity.
  const pnlByDate = new Map<string, number>();
  for (const row of dailyPnl) {
    pnlByDate.set(new Date(row.date).toISOString().slice(0, 10), toNumber(row.pnl));
  }
  const timeSeries = dailyMetrics
    .map((p) => ({
      date: p.date,
      ggr: p.ggr,
      // Reward cost booked that day = GGR − NGR for the day.
      bonuses: p.ggr - p.ngr,
      pnl: pnlByDate.get(p.date) ?? 0,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    cutoffIso: cutoff.toISOString(),
    periodLabel,
    ggr,
    ngr,
    wagers,
    payouts,
    bonusesByType,
    bonusesTotal,
    deposits,
    manualWithdrawals,
    cardWithdrawals,
    inventoryDelta,
    voucherDelta,
    pnl,
    residual,
    timeSeries,
  };
}
