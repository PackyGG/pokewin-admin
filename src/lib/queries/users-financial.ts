import { queryMainRows } from "@/lib/drizzle-query";
import { toNumber } from "@/lib/utils/decimal";
import { getUserWindowedPnlMulti } from "./users-windowed-pnl";

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
  // Rolling windowed house P&L (past 24h / 3d / 7d / 14d, now − N) —
  // windowed delta form. Positive = house gain (emerald), per
  // CLAUDE.md. Four windows so the row reads as a short-to-long ladder
  // of how this user has been performing for the house. 14d added on
  // top of the original four so the Account tab's windowed P&L strip
  // can show a slightly longer baseline than 7d for medium-term trends.
  // (The 12h rung was dropped per owner request.)
  pnl24h: number;
  pnl3d: number;
  pnl7d: number;
  pnl14d: number;
  deposits24h: number;
  deposits3d: number;
  deposits7d: number;
  deposits14d: number;
  // Rolling windowed WAGER (sum of bet stakes: pack opens + battle entries +
  // upgrader bets) over the same windows, for the Account-tab wager line.
  wager24h: number;
  wager3d: number;
  wager7d: number;
  wager14d: number;
};

export async function getUserPnlBreakdown(userId: string): Promise<PnlBreakdown> {
  const nowMs = Date.now();
  // Rolling cutoffs for the four-rung ladder shown in the Rolling P&L
  // section. All are `now − N` (true rolling windows, NOT calendar
  // boundaries). Same convention as the dashboard's period selector.
  const since24h = new Date(nowMs - 24 * 60 * 60 * 1000);
  const since3d = new Date(nowMs - 3 * 24 * 60 * 60 * 1000);
  const since7d = new Date(nowMs - 7 * 24 * 60 * 60 * 1000);
  const since14d = new Date(nowMs - 14 * 24 * 60 * 60 * 1000);
  const [rows, inventoryValue, windowed, wagerWindows] = await Promise.all([
    queryMainRows<{ type: string; net: string }[]>(
      `
      SELECT type,
             COALESCE(SUM(
               CASE WHEN type::text IN ('exchange_excess_to_voucher','battle_excess_to_voucher','voucher_redeemed','voucher_exchange')
                    THEN amount
                    ELSE balance_after - balance_before
               END
             ), 0)::text AS net
      FROM ledger_transactions
      WHERE user_id = $1 AND status = 'completed'
        AND type::text IN (
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
      GROUP BY type`,
      userId,
    ),
    queryMainRows<{ value: string }[]>(
      `SELECT COALESCE(SUM(ui.value_at_obtained::numeric), 0)::text AS value
       FROM user_inventory ui
       JOIN "user" u ON u.id = ui.user_id
       WHERE ui.user_id = $1
         AND ui.sold_at IS NULL
         AND ui.exchanged_at IS NULL
         AND u.role::text <> 'creator'`,
      userId,
    ),
    // Rolling windowed house P&L for this user across all four windows
    // (past 24h / 3d / 7d / 14d) in a single composite call — 4
    // round-trips total (one per source table) instead of 4 × 4 = 16
    // from a Promise.all of four `calculateWindowedPnl` calls. Same
    // formula and same session_windows-aware upgrader correction per
    // window — see `getUserWindowedPnlMulti`. The helper packs all
    // windows into one SELECT per table via CASE-WHEN-per-window so
    // adding/dropping a rung does not change the round-trip count.
    getUserWindowedPnlMulti(userId, [
      { key: "h24", since: since24h },
      { key: "d3", since: since3d },
      { key: "d7", since: since7d },
      { key: "d14", since: since14d },
    ]),
    // Windowed WAGER: sum of bet stakes per window. Wager types are the
    // user's spend on play — pack opens, battle entries (incl. sponsored
    // host funding), and upgrader bets — taken as ABS(amount) since stakes
    // are debits (negative) on the ledger. Single round-trip, four windows
    // via CASE-WHEN; bounded to the deepest (14d) cutoff.
    queryMainRows<{ w24: string; w3d: string; w7d: string; w14d: string }[]>(
      `
      SELECT
        COALESCE(SUM(CASE WHEN created_at >= $2 THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS w24,
        COALESCE(SUM(CASE WHEN created_at >= $3 THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS w3d,
        COALESCE(SUM(CASE WHEN created_at >= $4 THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS w7d,
        COALESCE(SUM(CASE WHEN created_at >= $5 THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS w14d
      FROM ledger_transactions
      WHERE user_id = $1
        AND status = 'completed'
        AND created_at >= $5
        AND type::text IN ('pack_opening','battle_bet','battle_sponsorship','upgrader_bet')
    `,
      userId,
      since24h,
      since3d,
      since7d,
      since14d,
    ),
  ]);
  const wagerRow = wagerWindows[0];

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
  const unrealizedLiability = toNumber(inventoryValue[0]?.value);
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
    pnl24h: windowed.h24.pnl,
    pnl3d: windowed.d3.pnl,
    pnl7d: windowed.d7.pnl,
    pnl14d: windowed.d14.pnl,
    deposits24h: windowed.h24.deposits,
    deposits3d: windowed.d3.deposits,
    deposits7d: windowed.d7.deposits,
    deposits14d: windowed.d14.deposits,
    wager24h: toNumber(wagerRow?.w24),
    wager3d: toNumber(wagerRow?.w3d),
    wager7d: toNumber(wagerRow?.w7d),
    wager14d: toNumber(wagerRow?.w14d),
  };
}

export async function getUserBalanceHistory(userId: string) {
  // Pull the last `balance_after` per calendar day in a single aggregated
  // query instead of streaming every completed transaction back to Node.
  // Uses DISTINCT ON (day) + ORDER BY created_at DESC so PG returns one
  // row per day carrying the latest balance snapshot for that day.
  //
  // For a high-activity user this previously fetched thousands of rows
  // only to collapse them client-side — this keeps the payload to at most
  // one row per day the user was active.
  const rows = await queryMainRows<{ date: Date | string; balance: string }[]>(
    `
    SELECT DISTINCT ON (DATE(created_at))
      DATE(created_at) AS date,
      balance_after::text AS balance
    FROM ledger_transactions
    WHERE user_id = $1
      AND status = 'completed'
    ORDER BY DATE(created_at) ASC, created_at DESC
  `,
    userId,
  );

  return rows.map((r) => ({
    date: new Date(r.date).toISOString().slice(0, 10),
    balance: toNumber(r.balance),
  }));
}
