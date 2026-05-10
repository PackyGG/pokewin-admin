import { getDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { toNumber } from "@/lib/utils/decimal";

/**
 * Revenue-by-source analysis.
 *
 * Source breakdown = same ledger types the GGR query uses, grouped into
 * categories for the stacked area chart and contribution table.
 *
 *   Inflows (house revenue):
 *     • pack_opening         → Pack wagers
 *     • battle_bet           → Battle wagers
 *     • battle_sponsorship   → Battle sponsorship
 *     • withdrawal_shipping_fee → Shipping fees
 *
 *   Outflows (paid to users, reduce GGR):
 *     • battle_refund        → Battle refunds
 *     • card_sale / reward_card_sale → Card sales (cashed-out inventory)
 *     • card_exchange / exchange_excess_credit → Card exchanges
 *     • deposit_bonus / promo_code_redeemed / gift_card_redeemed →
 *       Bonuses & promos
 *     • rakeback_claim       → Rakeback
 *     • affiliate_claim      → Affiliate commissions
 *     • rain_win / race_prize → Rain / race rewards
 *     • balance_reward_claim → Signup packs
 *     • creator_tip          → Creator tips
 *     • voucher_* / *_to_voucher → Vouchers
 *     • waitlist_prize       → Waitlist prizes
 *
 * Per-day series + totals. Staff excluded. Period-aware.
 */

export type RevenuePeriod = "7d" | "30d" | "90d" | "all";

function daysForPeriod(period: RevenuePeriod): number | null {
  switch (period) {
    case "7d":
      return 7;
    case "30d":
      return 30;
    case "90d":
      return 90;
    case "all":
      return null;
  }
}

export type RevenueSource = {
  key: string;
  label: string;
  direction: "inflow" | "outflow";
  total: number;
};

export type RevenueData = {
  period: RevenuePeriod;
  inflows: RevenueSource[];
  outflows: RevenueSource[];
  totalInflow: number;
  totalOutflow: number;
  ggr: number;
  // For stacked area chart (top source series over time):
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

/**
 * Runs one aggregated query returning all category totals + daily rows.
 * All amounts are positive (we use ABS); "direction" tracks which way
 * they move GGR.
 */
export async function getRevenueBreakdown(
  period: RevenuePeriod,
): Promise<RevenueData> {
  const db = await getDb();
  const days = daysForPeriod(period);
  const dateFilter =
    days !== null ? `AND created_at >= NOW() - INTERVAL '${days} days'` : "";
  const excluded = await getExcludedUserIds();
  const blacklistIdNotIn =
    excluded.length > 0
      ? `AND id NOT IN (${excluded
          .map((id) => `'${id.replace(/'/g, "''")}'`)
          .join(",")})`
      : "";

  const dailyRows = await db.$queryRawUnsafe<
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
      COALESCE(SUM(CASE WHEN type = 'pack_opening' THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS pack_wager,
      COALESCE(SUM(CASE WHEN type = 'battle_bet' THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS battle_wager,
      COALESCE(SUM(CASE WHEN type = 'battle_sponsorship' THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS battle_sponsorship,
      COALESCE(SUM(CASE WHEN type = 'withdrawal_shipping_fee' THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS shipping_fees,
      COALESCE(SUM(CASE WHEN type = 'battle_refund' THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS battle_refund,
      COALESCE(SUM(CASE WHEN type IN ('card_sale','reward_card_sale','card_exchange','exchange_excess_credit') THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS card_sale,
      COALESCE(SUM(CASE WHEN type IN ('deposit_bonus','promo_code_redeemed','gift_card_redeemed') THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS bonuses,
      COALESCE(SUM(CASE WHEN type = 'rakeback_claim' THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS rakeback,
      COALESCE(SUM(CASE WHEN type = 'affiliate_claim' THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS affiliate,
      COALESCE(SUM(CASE WHEN type IN ('rain_win','race_prize') THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS rain_race,
      COALESCE(SUM(CASE WHEN type = 'balance_reward_claim' THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS signup_pack,
      COALESCE(SUM(CASE WHEN type = 'creator_tip' THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS creator_tip,
      COALESCE(SUM(CASE WHEN type IN ('voucher_redeemed','voucher_exchange','exchange_excess_to_voucher','battle_excess_to_voucher') THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS vouchers,
      COALESCE(SUM(CASE WHEN type = 'waitlist_prize' THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS waitlist
    FROM ledger_transactions
    WHERE status = 'completed'
      AND user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin', 'support') ${blacklistIdNotIn})
      ${dateFilter}
    GROUP BY DATE(created_at)
    ORDER BY date
  `);

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

  const sum = (pick: (d: (typeof daily)[number]) => number): number =>
    daily.reduce((a, d) => a + pick(d), 0);

  const inflows: RevenueSource[] = [
    { key: "pack_wager", label: "Pack Wagers", direction: "inflow", total: sum((d) => d.packWager) },
    { key: "battle_wager", label: "Battle Wagers", direction: "inflow", total: sum((d) => d.battleWager) },
    { key: "battle_sponsorship", label: "Battle Sponsorship", direction: "inflow", total: sum((d) => d.battleSponsorship) },
    { key: "shipping_fees", label: "Shipping Fees", direction: "inflow", total: sum((d) => d.shippingFees) },
  ];

  const outflows: RevenueSource[] = [
    { key: "card_sale", label: "Card Sales / Exchanges", direction: "outflow", total: sum((d) => d.cardSale) },
    { key: "battle_refund", label: "Battle Refunds", direction: "outflow", total: sum((d) => d.battleRefund) },
    { key: "bonuses", label: "Bonuses & Promos", direction: "outflow", total: sum((d) => d.bonuses) },
    { key: "rakeback", label: "Rakeback", direction: "outflow", total: sum((d) => d.rakeback) },
    { key: "affiliate", label: "Affiliate Commissions", direction: "outflow", total: sum((d) => d.affiliate) },
    { key: "rain_race", label: "Rain / Race Prizes", direction: "outflow", total: sum((d) => d.rainRace) },
    { key: "signup_pack", label: "Signup Packs", direction: "outflow", total: sum((d) => d.signupPack) },
    { key: "creator_tip", label: "Creator Tips", direction: "outflow", total: sum((d) => d.creatorTip) },
    { key: "vouchers", label: "Vouchers", direction: "outflow", total: sum((d) => d.vouchers) },
    { key: "waitlist", label: "Waitlist Prizes", direction: "outflow", total: sum((d) => d.waitlist) },
  ];

  const totalInflow = inflows.reduce((a, s) => a + s.total, 0);
  const totalOutflow = outflows.reduce((a, s) => a + s.total, 0);

  return {
    period,
    inflows,
    outflows,
    totalInflow,
    totalOutflow,
    ggr: totalInflow - totalOutflow,
    daily,
  };
}
