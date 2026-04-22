import { getDb } from "@/lib/db";
import type { CreatorPnlData, CreatorPnlPeriod } from "./creators-types";

const PNL_PERIODS = ["3h", "12h", "24h", "3d", "7d", "14d", "30d"] as const;

const WAGER_TYPES = "('pack_opening','battle_bet','battle_sponsorship')";
const PAYOUT_TYPES = "('battle_refund','card_sale','reward_card_sale')";
const COST_TYPES = `('deposit_bonus','promo_code_redeemed','gift_card_redeemed','waitlist_prize',
  'rakeback_claim','affiliate_claim',
  'rain_win','race_prize','balance_reward_claim','creator_tip',
  'voucher_redeemed','voucher_exchange','exchange_excess_credit',
  'exchange_excess_to_voucher','battle_excess_to_voucher')`;

export async function getCreatorPnl(userId: string): Promise<CreatorPnlData> {
  const db = await getDb();
  const [allTimeRows, periodRows, creatorCostRows] = await Promise.all([
    // Query A: All-time PnL from referred users
    db.$queryRawUnsafe<{ ggr: string; costs: string }[]>(`
      SELECT
        (COALESCE(SUM(CASE WHEN lt.type IN ${WAGER_TYPES} THEN ABS(lt.amount::numeric) ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN lt.type IN ${PAYOUT_TYPES} THEN ABS(lt.amount::numeric) ELSE 0 END), 0))::text AS ggr,
        COALESCE(SUM(CASE WHEN lt.type IN ${COST_TYPES} THEN (lt.balance_after - lt.balance_before)::numeric ELSE 0 END), 0)::text AS costs
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.user_id IN (
          SELECT DISTINCT referred_user_id FROM affiliate_code_usages WHERE affiliate_user_id = $1
        )
    `, userId),

    // Query B: PnL by period
    db.$queryRawUnsafe<{ period: string; ggr: string; costs: string }[]>(`
      SELECT
        p.period,
        (COALESCE(SUM(CASE WHEN lt.type IN ${WAGER_TYPES} THEN ABS(lt.amount::numeric) ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN lt.type IN ${PAYOUT_TYPES} THEN ABS(lt.amount::numeric) ELSE 0 END), 0))::text AS ggr,
        COALESCE(SUM(CASE WHEN lt.type IN ${COST_TYPES} THEN (lt.balance_after - lt.balance_before)::numeric ELSE 0 END), 0)::text AS costs
      FROM (VALUES ('3h'),('12h'),('24h'),('3d'),('7d'),('14d'),('30d')) AS p(period)
      LEFT JOIN ledger_transactions lt
        ON lt.status = 'completed'
        AND lt.user_id IN (
          SELECT DISTINCT referred_user_id FROM affiliate_code_usages WHERE affiliate_user_id = $1
        )
        AND lt.created_at >= NOW() - CASE p.period
          WHEN '3h'  THEN INTERVAL '3 hours'
          WHEN '12h' THEN INTERVAL '12 hours'
          WHEN '24h' THEN INTERVAL '24 hours'
          WHEN '3d'  THEN INTERVAL '3 days'
          WHEN '7d'  THEN INTERVAL '7 days'
          WHEN '14d' THEN INTERVAL '14 days'
          WHEN '30d' THEN INTERVAL '30 days'
        END
      GROUP BY p.period
    `, userId),

    // Query C: Creator's own cost to platform
    db.$queryRawUnsafe<{ commission: string; tips: string; fills: string }[]>(`
      SELECT
        COALESCE(SUM(CASE WHEN type = 'affiliate_claim' THEN (balance_after - balance_before)::numeric ELSE 0 END), 0)::text AS commission,
        COALESCE(SUM(CASE WHEN type = 'creator_tip' THEN (balance_after - balance_before)::numeric ELSE 0 END), 0)::text AS tips,
        COALESCE(SUM(CASE WHEN type = 'admin_balance_adjustment' THEN (balance_after - balance_before)::numeric ELSE 0 END), 0)::text AS fills
      FROM ledger_transactions
      WHERE user_id = $1 AND status = 'completed'
    `, userId),
  ]);

  const totalGgr = Number(allTimeRows[0]?.ggr ?? 0);
  const totalCosts = Number(allTimeRows[0]?.costs ?? 0);
  const totalNetPnl = totalGgr - totalCosts;

  const commission = Number(creatorCostRows[0]?.commission ?? 0);
  const tips = Number(creatorCostRows[0]?.tips ?? 0);
  const fills = Number(creatorCostRows[0]?.fills ?? 0);
  const creatorCost = commission + tips + fills;

  const byPeriod: CreatorPnlPeriod[] = PNL_PERIODS.map((period) => {
    const row = periodRows.find((r) => r.period === period);
    const ggr = Number(row?.ggr ?? 0);
    const costs = Number(row?.costs ?? 0);
    return { period, ggr, costs, netPnl: ggr - costs };
  });

  return {
    totalGgr,
    totalCosts,
    totalNetPnl,
    creatorCost,
    truePlatformPnl: totalNetPnl - creatorCost,
    byPeriod,
  };
}
