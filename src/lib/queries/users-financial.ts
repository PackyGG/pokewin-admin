import { db } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";

export type PnlBreakdown = {
  // Gambling revenue (platform perspective, positive = platform earned)
  packRevenue: number;
  battleRevenue: number;
  cardSalesPayouts: number;
  gamblingPnlRealized: number;
  unrealizedLiability: number;
  gamblingPnlTrue: number;
  // Costs (positive = cost to platform)
  bonusesCost: number;
  rakebackCost: number;
  affiliateCost: number;
  otherCosts: number;
  otherCostsDetail: {
    rainWin: number;
    racePrize: number;
    balanceRewardClaim: number;
    creatorTip: number;
    voucherRedeemed: number;
    voucherExchange: number;
    exchangeExcessCredit: number;
    exchangeExcessToVoucher: number;
    battleExcessToVoucher: number;
  };
  // Net
  netPnlRealized: number;
  netPnlTrue: number;
};

export async function getUserPnlBreakdown(userId: string): Promise<PnlBreakdown> {
  const [rows, inventoryValue] = await Promise.all([
    db.$queryRaw<{ type: string; net: string }[]>`
      SELECT type,
             COALESCE(SUM(
               CASE WHEN type IN ('exchange_excess_to_voucher','battle_excess_to_voucher','voucher_redeemed','voucher_exchange')
                    THEN amount
                    ELSE balance_after - balance_before
               END
             ), 0)::text AS net
      FROM ledger_transactions
      WHERE user_id = ${userId} AND status = 'completed'
        AND type IN (
          'pack_opening','battle_bet','battle_sponsorship','battle_refund',
          'card_sale','reward_card_sale','card_exchange',
          'deposit_bonus','promo_code_redeemed','gift_card_redeemed','waitlist_prize',
          'rakeback_claim','affiliate_claim',
          'rain_win','race_prize','balance_reward_claim','creator_tip',
          'voucher_redeemed','voucher_exchange','exchange_excess_credit',
          'exchange_excess_to_voucher','battle_excess_to_voucher')
      GROUP BY type
    `,
    db.user_inventory.aggregate({
      where: { user_id: userId, sold_at: null, exchanged_at: null },
      _sum: { value_at_obtained: true },
    }),
  ]);

  const byType = new Map(rows.map((r) => [r.type, parseFloat(r.net) || 0]));
  const sum = (...types: string[]) => types.reduce((acc, t) => acc + (byType.get(t) ?? 0), 0);

  // Gambling revenue: user loses money → net is negative → negate for platform perspective
  const packRevenue = -sum("pack_opening");
  const battleRevenue = -sum("battle_bet", "battle_sponsorship", "battle_refund");
  // Card sales: user gets money back → net is positive → negate = negative (cost to platform)
  const cardSalesPayouts = -sum("card_sale", "reward_card_sale", "card_exchange");
  const gamblingPnlRealized = packRevenue + battleRevenue + cardSalesPayouts;

  // Unrealized: cards the user still holds = future liability
  const unrealizedLiability = inventoryValue._sum.value_at_obtained
    ? toNumber(inventoryValue._sum.value_at_obtained)
    : 0;
  const gamblingPnlTrue = gamblingPnlRealized - unrealizedLiability;

  // Costs to platform (user gains money → positive net)
  const bonusesCost = sum("deposit_bonus", "promo_code_redeemed", "gift_card_redeemed", "waitlist_prize");
  const rakebackCost = sum("rakeback_claim");
  const affiliateCost = sum("affiliate_claim");
  const otherCostsDetail = {
    rainWin: sum("rain_win"),
    racePrize: sum("race_prize"),
    balanceRewardClaim: sum("balance_reward_claim"),
    creatorTip: sum("creator_tip"),
    voucherRedeemed: sum("voucher_redeemed"),
    voucherExchange: sum("voucher_exchange"),
    exchangeExcessCredit: sum("exchange_excess_credit"),
    exchangeExcessToVoucher: sum("exchange_excess_to_voucher"),
    battleExcessToVoucher: sum("battle_excess_to_voucher"),
  };
  const otherCosts = Object.values(otherCostsDetail).reduce((a, b) => a + b, 0);

  const totalCosts = bonusesCost + rakebackCost + affiliateCost + otherCosts;
  const netPnlRealized = gamblingPnlRealized - totalCosts;
  const netPnlTrue = gamblingPnlTrue - totalCosts;

  return {
    packRevenue, battleRevenue, cardSalesPayouts,
    gamblingPnlRealized, unrealizedLiability, gamblingPnlTrue,
    bonusesCost, rakebackCost, affiliateCost, otherCosts, otherCostsDetail,
    netPnlRealized, netPnlTrue,
  };
}

export async function getUserBalanceHistory(userId: string) {
  const transactions = await db.ledger_transactions.findMany({
    where: { user_id: userId, status: "completed" },
    orderBy: { created_at: "asc" },
    select: {
      balance_after: true,
      created_at: true,
    },
  });

  // Aggregate by date — keep last balance_after per day
  const byDate = new Map<string, number>();
  for (const t of transactions) {
    const date = t.created_at.toISOString().slice(0, 10);
    byDate.set(date, toNumber(t.balance_after));
  }

  return Array.from(byDate, ([date, balance]) => ({ date, balance }));
}
