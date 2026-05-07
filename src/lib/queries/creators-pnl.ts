import { getDb } from "@/lib/db";
import type { CreatorPnlData, CreatorPnlPeriod } from "./creators-types";
import { WAGER_TYPES_SQL, PAYOUT_TYPES_SQL } from "./_wager-payout-types";

const PNL_PERIODS = ["3h", "12h", "24h", "3d", "7d", "14d", "30d"] as const;

// Shared with dashboard.ts via _wager-payout-types.ts so creator GGR and
// global GGR agree on what counts. Previously the creators-pnl set was a
// strict subset of dashboard's, so the same user's wagers contributed
// differently to the two surfaces.
const WAGER_TYPES = WAGER_TYPES_SQL;
const PAYOUT_TYPES = PAYOUT_TYPES_SQL;
// Costs are still creator-specific: these are the ledger types that
// represent payouts the creator's referred users took out (not the
// raw house-payout list above). They are the subset we treat as a
// "cost the creator caused us" via their referral pool.
const COST_TYPES = `('deposit_bonus','promo_code_redeemed','gift_card_redeemed','waitlist_prize',
  'rakeback_claim','affiliate_claim',
  'rain_win','race_prize','balance_reward_claim','creator_tip',
  'voucher_redeemed','voucher_exchange','exchange_excess_credit',
  'exchange_excess_to_voucher','battle_excess_to_voucher')`;

export async function getCreatorPnl(userId: string): Promise<CreatorPnlData> {
  const db = await getDb();
  // Combined all-time + by-period scan in a single round-trip. Previously
  // Queries A and B were two separate queries scanning the same source
  // (ledger_transactions joined to the IN-list of referred users). They
  // share the same JOIN condition + filters, so collapsing them via a
  // UNION-style VALUES list (with 'all' meaning "no time filter") halves
  // the work on a hot ledger table without changing the per-bucket math.
  //
  // Staff (admin + support) are filtered out of the IN-list so this matches
  // the rest of the creator-facing analytics (see getCreatorDetail's
  // realAffiliateAgg, getCodeReferrals, etc.). Internal accounts shouldn't
  // skew the per-creator GGR / cost numbers.
  const [allBucketRows, creatorCostRows] = await Promise.all([
    // Query A+B (combined): All-time + by-period PnL from referred users.
    // 'all' bucket has no time filter; the others apply NOW() − INTERVAL.
    db.$queryRawUnsafe<{ period: string; ggr: string; costs: string }[]>(`
      SELECT
        p.period,
        (COALESCE(SUM(CASE WHEN lt.type IN ${WAGER_TYPES} THEN ABS(lt.amount::numeric) ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN lt.type IN ${PAYOUT_TYPES} THEN ABS(lt.amount::numeric) ELSE 0 END), 0))::text AS ggr,
        COALESCE(SUM(CASE WHEN lt.type IN ${COST_TYPES} THEN (lt.balance_after - lt.balance_before)::numeric ELSE 0 END), 0)::text AS costs
      FROM (VALUES ('all'),('3h'),('12h'),('24h'),('3d'),('7d'),('14d'),('30d')) AS p(period)
      LEFT JOIN ledger_transactions lt
        ON lt.status = 'completed'
        AND lt.user_id IN (
          SELECT DISTINCT acu.referred_user_id
          FROM affiliate_code_usages acu
          JOIN "user" u ON u.id = acu.referred_user_id
          WHERE acu.affiliate_user_id = $1
            AND u.role NOT IN ('admin', 'support')
        )
        AND (
          p.period = 'all'
          OR lt.created_at >= NOW() - CASE p.period
            WHEN '3h'  THEN INTERVAL '3 hours'
            WHEN '12h' THEN INTERVAL '12 hours'
            WHEN '24h' THEN INTERVAL '24 hours'
            WHEN '3d'  THEN INTERVAL '3 days'
            WHEN '7d'  THEN INTERVAL '7 days'
            WHEN '14d' THEN INTERVAL '14 days'
            WHEN '30d' THEN INTERVAL '30 days'
          END
        )
      GROUP BY p.period
    `, userId),

    // Query C: Creator's own cost to platform
    //
    // Disambiguation note: `admin_balance_adjustment` is overloaded —
    // both manual balance fills (creator deal payouts, support credits)
    // AND manual withdrawals are recorded with this type. Manual
    // withdrawals are tagged in the description with "Manual withdrawal:%"
    // (set by the withdrawal action). Filter them out so `fills` only
    // counts what the platform actually paid into the creator, not what
    // the creator pulled out as a manual withdrawal.
    db.$queryRawUnsafe<{ commission: string; tips: string; fills: string }[]>(`
      SELECT
        COALESCE(SUM(CASE WHEN type = 'affiliate_claim' THEN (balance_after - balance_before)::numeric ELSE 0 END), 0)::text AS commission,
        COALESCE(SUM(CASE WHEN type = 'creator_tip' THEN (balance_after - balance_before)::numeric ELSE 0 END), 0)::text AS tips,
        COALESCE(SUM(
          CASE WHEN type = 'admin_balance_adjustment'
                AND (description IS NULL OR description NOT ILIKE 'Manual withdrawal:%')
               THEN (balance_after - balance_before)::numeric
               ELSE 0 END
        ), 0)::text AS fills
      FROM ledger_transactions
      WHERE user_id = $1 AND status = 'completed'
    `, userId),
  ]);

  // Split the combined result back into "all-time" + "per period" rows for
  // the consumer-facing CreatorPnlData shape.
  const allTimeRow = allBucketRows.find((r) => r.period === "all");
  const periodRows = allBucketRows.filter((r) => r.period !== "all");

  const totalGgr = Number(allTimeRow?.ggr ?? 0);
  const totalCosts = Number(allTimeRow?.costs ?? 0);
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
