import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { calculateWindowedPnl } from "./pnl";

export type PnlBreakdown = {
  // Gambling revenue (platform perspective, positive = platform earned)
  packRevenue: number;
  battleRevenue: number;
  upgraderRevenue: number;
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
    affiliateLeaderboard: number;
  };
  // Net
  netPnlRealized: number;
  netPnlTrue: number;
  // Rolling windowed house P&L (past 24h / 7d, now − N) — windowed
  // delta form. Positive = house gain (emerald), per CLAUDE.md.
  pnl24h: number;
  pnl7d: number;
};

export async function getUserPnlBreakdown(userId: string): Promise<PnlBreakdown> {
  const db = await getDb();
  const nowMs = Date.now();
  const since24h = new Date(nowMs - 24 * 60 * 60 * 1000);
  const since7d = new Date(nowMs - 7 * 24 * 60 * 60 * 1000);
  const [rows, inventoryValue, windowed24h, windowed7d] = await Promise.all([
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
          'upgrader_bet','upgrader_payout',
          'card_sale','reward_card_sale','card_exchange',
          'deposit_bonus','promo_code_redeemed','gift_card_redeemed','waitlist_prize',
          'rakeback_claim','affiliate_claim',
          'rain_win','race_prize','balance_reward_claim','creator_tip',
          'voucher_redeemed','voucher_exchange','exchange_excess_credit',
          'exchange_excess_to_voucher','battle_excess_to_voucher',
          'affiliate_leaderboard_creation','affiliate_leaderboard_refund',
          'affiliate_leaderboard_prize')
      GROUP BY type
    `,
    db.user_inventory.aggregate({
      where: { user_id: userId, sold_at: null, exchanged_at: null },
      _sum: { value_at_obtained: true },
    }),
    // Rolling windowed house P&L for this user (past 24h / 7d).
    calculateWindowedPnl({ userId, since: since24h }),
    calculateWindowedPnl({ userId, since: since7d }),
  ]);

  const byType = new Map(rows.map((r) => [r.type, parseFloat(r.net) || 0]));
  const sum = (...types: string[]) => types.reduce((acc, t) => acc + (byType.get(t) ?? 0), 0);

  // Gambling revenue: user loses money → net is negative → negate for platform perspective
  const packRevenue = -sum("pack_opening");
  const battleRevenue = -sum("battle_bet", "battle_sponsorship", "battle_refund");
  // Upgrader: bet (user loses balance → negative) netted against payout
  // (user gains balance → positive). Negate for platform perspective so
  // a winning Upgrader user reads negative (house lost) and a losing
  // one reads positive (house gained).
  const upgraderRevenue = -sum("upgrader_bet", "upgrader_payout");
  // Card sales: user gets money back → net is positive → negate = negative (cost to platform)
  const cardSalesPayouts = -sum("card_sale", "reward_card_sale", "card_exchange");
  const gamblingPnlRealized =
    packRevenue + battleRevenue + upgraderRevenue + cardSalesPayouts;

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
    // Affiliate leaderboards: creator buy-in (house gain → negative net)
    // netted against prize payouts + buy-in refunds (house cost → positive
    // net). One net category so the breakdown reconciles with the balance-
    // sheet realized P&L, which already captures these via balance deltas.
    affiliateLeaderboard: sum(
      "affiliate_leaderboard_creation",
      "affiliate_leaderboard_refund",
      "affiliate_leaderboard_prize",
    ),
  };
  const otherCosts = Object.values(otherCostsDetail).reduce((a, b) => a + b, 0);

  const totalCosts = bonusesCost + rakebackCost + affiliateCost + otherCosts;
  const netPnlRealized = gamblingPnlRealized - totalCosts;
  const netPnlTrue = gamblingPnlTrue - totalCosts;

  return {
    packRevenue, battleRevenue, upgraderRevenue, cardSalesPayouts,
    gamblingPnlRealized, unrealizedLiability, gamblingPnlTrue,
    bonusesCost, rakebackCost, affiliateCost, otherCosts, otherCostsDetail,
    netPnlRealized, netPnlTrue,
    pnl24h: windowed24h.pnl,
    pnl7d: windowed7d.pnl,
  };
}

export async function getUserBalanceHistory(userId: string) {
  const db = await getDb();
  // Pull the last `balance_after` per calendar day in a single aggregated
  // query instead of streaming every completed transaction back to Node.
  // Uses DISTINCT ON (day) + ORDER BY created_at DESC so PG returns one
  // row per day carrying the latest balance snapshot for that day.
  //
  // For a high-activity user this previously fetched thousands of rows
  // only to collapse them client-side — this keeps the payload to at most
  // one row per day the user was active.
  const rows = await db.$queryRaw<{ date: Date; balance: string }[]>`
    SELECT DISTINCT ON (DATE(created_at))
      DATE(created_at) AS date,
      balance_after::text AS balance
    FROM ledger_transactions
    WHERE user_id = ${userId}
      AND status = 'completed'
    ORDER BY DATE(created_at) ASC, created_at DESC
  `;

  return rows.map((r) => ({
    date: new Date(r.date).toISOString().slice(0, 10),
    balance: toNumber(r.balance),
  }));
}
