import "server-only";

import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import {
  getWindowMetrics,
  getGamingLegs,
  upgraderMetrics,
  sumLedgerTypes,
  type MetricWindow,
} from "@/lib/metrics/queries";
import {
  REWARD_PAYOUT_TYPES,
  NEUTRAL_TYPES,
  FEE_TYPES,
  GAMING_PAYOUT_TYPES,
  ledgerTypesToSqlList,
  type LedgerTransactionType,
} from "@/lib/metrics";
import { realCustomersScopeSql } from "./insights-games/_shared";

/**
 * Revenue-by-source analysis — MIGRATED onto the canonical `@/lib/metrics`
 * layer.
 *
 * The headline GGR/NGR are the canonical gaming-margin numbers
 * (`getWindowMetrics`): GGR = wager − gamingPayout where the dominant
 * pack/battle payout is the `user_inventory.value_at_obtained` delta (NOT
 * a ledger type), `battle_refund` is the only ledger cash gaming-payout
 * leg, card conversions are NEUTRAL, and upgrader comes from
 * `upgrader_games` (NEVER ledger `upgrader_payout`). Scope = real
 * customers (admin/support/creator dropped + blacklist), borrow plays
 * excluded — identical to analytics.ts / dashboard / /ggr.
 *
 * The source-category breakdown below is a presentational split of the
 * ledger flow into buckets, every bucket sourced from the canonical type
 * sets (`@/lib/metrics` `ledger-sets`) through the canonical real-customer
 * scope (`realCustomersScopeSql`). It deliberately separates:
 *
 *   • Gaming revenue (house keeps) — wager in, gaming payout out. GGR is
 *     the delta of these two and matches `getWindowMetrics().ggr` exactly.
 *   • Reward / marketing spend (REWARD_PAYOUT_TYPES) — reduces NGR, NOT
 *     GGR. Broken into sub-rows for the chart from the canonical set.
 *   • Neutral conversions (NEUTRAL_TYPES — card_sale / card_exchange /
 *     voucher↔balance, etc.) — value the user already owns changing form.
 *     Surfaced for visibility but EXCLUDED from GGR and NGR.
 *
 * The previous version treated card sales as an outflow that reduced GGR
 * and pulled upgrader payouts from the ledger — both wrong under the
 * verified booking model. Those are corrected here.
 *
 * Per-day series + totals. Period-aware.
 */

export type RevenuePeriod = "7d" | "30d" | "90d" | "all";

function periodToMetricWindow(period: RevenuePeriod): MetricWindow {
  if (period === "all") return { since: null };
  const days = daysForPeriod(period);
  return { since: new Date(Date.now() - days * 24 * 60 * 60 * 1000) };
}

function daysForPeriod(period: RevenuePeriod): number {
  switch (period) {
    case "7d":
      return 7;
    case "30d":
      return 30;
    case "90d":
      return 90;
    case "all":
      // Lifetime — only used to build the `created_at >= …` chart filter;
      // the canonical metric window is `{ since: null }` (no lower bound).
      return 36500;
  }
}

/** Inline `AND created_at >= NOW() - INTERVAL …` for the daily chart query. */
function dateFilterForPeriod(period: RevenuePeriod): string {
  if (period === "all") return "";
  return `AND created_at >= NOW() - INTERVAL '${daysForPeriod(period)} days'`;
}

export type RevenueSource = {
  key: string;
  label: string;
  direction: "inflow" | "outflow" | "neutral";
  total: number;
};

export type RevenueData = {
  period: RevenuePeriod;
  /** House revenue captured from the user (wager + shipping fee). */
  inflows: RevenueSource[];
  /** Gaming payout returned to the user (inventory keep + battle_refund). */
  gamingOutflows: RevenueSource[];
  /** House-funded reward / marketing spend (reduces NGR, not GGR). */
  rewardOutflows: RevenueSource[];
  /** Inventory↔balance / voucher↔balance conversions — neutral to GGR/NGR. */
  neutral: RevenueSource[];
  totalInflow: number;
  /** Total gaming payout (the payout side of GGR). */
  totalGamingPayout: number;
  /** Total house-funded reward spend (the gap between GGR and NGR). */
  totalRewardSpend: number;
  /** Total neutral conversion volume (informational; excluded from GGR/NGR). */
  totalNeutral: number;
  /** Canonical GGR = wager − gamingPayout (gaming-only, house POV). */
  ggr: number;
  /** Canonical NGR = GGR − reward spend − net rain (house POV). */
  ngr: number;
  // For the stacked area charts (per-day category series over time):
  daily: {
    date: string;
    packWager: number;
    battleWager: number;
    battleSponsorship: number;
    shippingFees: number;
    battleRefund: number;
    cardSale: number;
    bonuses: number;
    rakeback: number;
    affiliate: number;
    rainRace: number;
    signupPack: number;
    creatorTip: number;
    vouchers: number;
    waitlist: number;
  }[];
};

// ─── Chart sub-category groupings ────────────────────────────────────
//
// The stacked chart breaks the coarse canonical buckets into finer rows
// for readability. Every member below is drawn from the canonical
// `REWARD_PAYOUT_TYPES` / `NEUTRAL_TYPES` arrays (single source of truth)
// — no parallel literal list is authored here, so they can never drift
// from the canonical partition. `creator_tip` is a RESIDUAL pass-through
// (user→user, $0 net house cost) and is surfaced only as an informational
// chart series, never folded into GGR/NGR.
const rewardSubset = (
  ...members: LedgerTransactionType[]
): LedgerTransactionType[] =>
  REWARD_PAYOUT_TYPES.filter((t) => members.includes(t));

const BONUS_TYPES = rewardSubset(
  "deposit_bonus",
  "promo_code_redeemed",
  "gift_card_redeemed",
);
const RAKEBACK_TYPES = rewardSubset("rakeback_claim");
const AFFILIATE_TYPES = rewardSubset("affiliate_claim");
const RAIN_RACE_TYPES = rewardSubset("rain_win", "race_prize");
const SIGNUP_PACK_TYPES = rewardSubset("balance_reward_claim");
const WAITLIST_TYPES = rewardSubset("waitlist_prize");
// `voucher_redeemed` is a REWARD (house-funded voucher → reduces NGR);
// `affiliate_leaderboard_prize` is also a reward. Both are part of the
// canonical `REWARD_PAYOUT_TYPES` set and are surfaced in the reward
// breakdown so it sums to the full reward cost.
const VOUCHER_REDEEMED_TYPES = rewardSubset("voucher_redeemed");
const LEADERBOARD_PRIZE_TYPES = rewardSubset("affiliate_leaderboard_prize");
// Chart `vouchers` series = the NEUTRAL voucher↔balance conversions only
// (value the user already owns changing form). `voucher_redeemed` is NOT
// here — it is a reward, handled above. The filter intersects against the
// canonical NEUTRAL_TYPES array so it can never drift.
const VOUCHER_CONVERSION_TYPES = NEUTRAL_TYPES.filter((t) =>
  (
    [
      "voucher_exchange",
      "exchange_excess_to_voucher",
      "battle_excess_to_voucher",
    ] as LedgerTransactionType[]
  ).includes(t),
);
const CREATOR_TIP_TYPES: LedgerTransactionType[] = ["creator_tip"];

/** Build a `COALESCE(SUM(CASE WHEN type IN (...) …))` daily column. */
function dailyCol(
  types: readonly LedgerTransactionType[],
  alias: string,
): string {
  if (types.length === 0) {
    return `0::numeric::text AS ${alias}`;
  }
  return `COALESCE(SUM(CASE WHEN type IN ${ledgerTypesToSqlList(
    types,
  )} THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS ${alias}`;
}

/**
 * Runs the canonical metric reads (headline + legs + upgrader) plus ONE
 * presentational per-day breakdown query (canonical scope + canonical
 * type sets) for the stacked charts.
 */
export async function getRevenueBreakdown(
  period: RevenuePeriod,
): Promise<RevenueData> {
  const db = await getDb();
  const window = periodToMetricWindow(period);
  const scope = await realCustomersScopeSql();
  const dateFilter = dateFilterForPeriod(period);

  const [
    windowMetrics,
    legs,
    upgrader,
    neutralTotal,
    voucherRedeemedTotal,
    leaderboardPrizeTotal,
    dailyRows,
  ] = await Promise.all([
      getWindowMetrics({ window }),
      getGamingLegs(window),
      upgraderMetrics(window),
      sumLedgerTypes({ types: NEUTRAL_TYPES, window }),
      sumLedgerTypes({ types: VOUCHER_REDEEMED_TYPES, window }),
      sumLedgerTypes({ types: LEADERBOARD_PRIZE_TYPES, window }),
      db.$queryRawUnsafe<
        {
          date: Date;
          pack_wager: string;
          battle_wager: string;
          battle_sponsorship: string;
          shipping_fees: string;
          battle_refund: string;
          card_sale: string;
          bonuses: string;
          rakeback: string;
          affiliate: string;
          rain_race: string;
          signup_pack: string;
          creator_tip: string;
          vouchers: string;
          waitlist: string;
        }[]
      >(`
        SELECT
          DATE(created_at) AS date,
          COALESCE(SUM(CASE WHEN type::text = 'pack_opening' THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS pack_wager,
          COALESCE(SUM(CASE WHEN type::text = 'battle_bet' THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS battle_wager,
          COALESCE(SUM(CASE WHEN type::text = 'battle_sponsorship' THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS battle_sponsorship,
          ${dailyCol(FEE_TYPES, "shipping_fees")},
          ${dailyCol(GAMING_PAYOUT_TYPES, "battle_refund")},
          ${dailyCol(NEUTRAL_TYPES, "card_sale")},
          ${dailyCol(BONUS_TYPES, "bonuses")},
          ${dailyCol(RAKEBACK_TYPES, "rakeback")},
          ${dailyCol(AFFILIATE_TYPES, "affiliate")},
          ${dailyCol(RAIN_RACE_TYPES, "rain_race")},
          ${dailyCol(SIGNUP_PACK_TYPES, "signup_pack")},
          ${dailyCol(CREATOR_TIP_TYPES, "creator_tip")},
          ${dailyCol(VOUCHER_CONVERSION_TYPES, "vouchers")},
          ${dailyCol(WAITLIST_TYPES, "waitlist")}
        FROM ledger_transactions
        WHERE status = 'completed'
          AND user_id IN ${scope}
          ${dateFilter}
        GROUP BY DATE(created_at)
        ORDER BY date
      `),
    ]);

  const daily = dailyRows.map((r) => ({
    date: new Date(r.date).toISOString().split("T")[0],
    packWager: toNumber(r.pack_wager),
    battleWager: toNumber(r.battle_wager),
    battleSponsorship: toNumber(r.battle_sponsorship),
    shippingFees: toNumber(r.shipping_fees),
    battleRefund: toNumber(r.battle_refund),
    cardSale: toNumber(r.card_sale),
    bonuses: toNumber(r.bonuses),
    rakeback: toNumber(r.rakeback),
    affiliate: toNumber(r.affiliate),
    rainRace: toNumber(r.rain_race),
    signupPack: toNumber(r.signup_pack),
    creatorTip: toNumber(r.creator_tip),
    vouchers: toNumber(r.vouchers),
    waitlist: toNumber(r.waitlist),
  }));

  const sumDaily = (pick: (d: (typeof daily)[number]) => number): number =>
    daily.reduce((a, d) => a + pick(d), 0);

  // ─── Inflows (house revenue captured from the user) ───
  // Wager comes from the canonical legs (borrow-corrected, real-customer
  // scope). Upgrader wager comes from `upgrader_games` (NOT ledger) and is
  // only present once the upgrader table exists in the connected DB.
  const upgraderWager = upgrader?.wager ?? 0;
  const shippingFees = sumDaily((d) => d.shippingFees);
  const inflows: RevenueSource[] = [
    {
      key: "wager",
      label: "Pack / Battle Wagers",
      direction: "inflow",
      total: legs.wager,
    },
    {
      key: "upgrader_wager",
      label: "Upgrader Wagers",
      direction: "inflow",
      total: upgraderWager,
    },
    {
      key: "shipping_fees",
      label: "Shipping Fees",
      direction: "inflow",
      total: shippingFees,
    },
  ];
  const totalInflow = inflows.reduce((a, s) => a + s.total, 0);

  // ─── Gaming outflows (the payout side of GGR) ───
  // Inventory keep is the dominant pack/battle payout; battle_refund is
  // the ledger cash leg; upgrader payout from `upgrader_games`.
  const upgraderPayout = upgrader?.payout ?? 0;
  const gamingOutflows: RevenueSource[] = [
    {
      key: "inventory_keep",
      label: "Cards Kept (inventory)",
      direction: "outflow",
      total: legs.inventoryPayout,
    },
    {
      key: "battle_refund",
      label: "Battle Refunds",
      direction: "outflow",
      total: legs.battleRefund,
    },
    {
      key: "upgrader_payout",
      label: "Upgrader Payouts",
      direction: "outflow",
      total: upgraderPayout,
    },
  ];
  const totalGamingPayout = windowMetrics.gamingPayout;

  // ─── Reward / marketing spend (the GGR→NGR gap) ───
  // rain_race here shows the FULL rain_win + race_prize magnitude for
  // transparency; the NGR figure nets rain against rain_tip per the
  // canonical model (`getWindowMetrics`), so totalRewardSpend (display)
  // and (GGR − NGR) can differ by the netted rain tip — intentional.
  const rewardOutflows: RevenueSource[] = [
    {
      key: "bonuses",
      label: "Bonuses & Promos",
      direction: "outflow",
      total: sumDaily((d) => d.bonuses),
    },
    {
      key: "rakeback",
      label: "Rakeback",
      direction: "outflow",
      total: sumDaily((d) => d.rakeback),
    },
    {
      key: "affiliate",
      label: "Affiliate Commissions",
      direction: "outflow",
      total: sumDaily((d) => d.affiliate),
    },
    {
      key: "rain_race",
      label: "Rain / Race Prizes",
      direction: "outflow",
      total: sumDaily((d) => d.rainRace),
    },
    {
      key: "signup_pack",
      label: "Signup Packs",
      direction: "outflow",
      total: sumDaily((d) => d.signupPack),
    },
    {
      key: "waitlist",
      label: "Waitlist Prizes",
      direction: "outflow",
      total: sumDaily((d) => d.waitlist),
    },
    {
      key: "voucher_redeemed",
      label: "Vouchers Redeemed",
      direction: "outflow",
      total: voucherRedeemedTotal,
    },
    {
      key: "leaderboard_prize",
      label: "Leaderboard Prizes",
      direction: "outflow",
      total: leaderboardPrizeTotal,
    },
  ];
  const totalRewardSpend = rewardOutflows.reduce((a, s) => a + s.total, 0);

  // ─── Neutral conversions (excluded from GGR/NGR) ───
  // card_sale / reward_card_sale / card_exchange / excess-credit and the
  // voucher↔balance variants: value the user already owns changing form.
  // Summed via the canonical NEUTRAL_TYPES set; surfaced for visibility.
  const neutral: RevenueSource[] = [
    {
      key: "card_conversions",
      label: "Card / Voucher Conversions",
      direction: "neutral",
      total: neutralTotal,
    },
  ];

  return {
    period,
    inflows,
    gamingOutflows,
    rewardOutflows,
    neutral,
    totalInflow,
    totalGamingPayout,
    totalRewardSpend,
    totalNeutral: neutralTotal,
    ggr: windowMetrics.ggr,
    ngr: windowMetrics.ngr,
    daily,
  };
}
