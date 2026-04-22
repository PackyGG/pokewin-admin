import { getDb } from "@/lib/db";

/**
 * Creator true LTV analysis. For every creator (user with role='creator'
 * AND at least one referred user), compute:
 *
 *   • referred_users_count    — distinct users they've ever referred
 *   • gross_platform_pnl      — sum of per-user-P&L for their referred
 *                                users (house POV: deposits − withdrawals
 *                                − balance − inventory − vouchers −
 *                                unclaimed rakeback)
 *   • creator_cost            — sum of affiliate_claim + creator_tip
 *                                + admin_balance_adjustment credits paid
 *                                to the creator from the platform
 *   • net_roi                 — gross_platform_pnl − creator_cost
 *   • roi_multiple            — gross_platform_pnl / creator_cost
 *                                (>1 = profitable, <1 = losing, 0 cost
 *                                folded to null)
 *
 * Period filter scopes BOTH sides of the equation: only referred-user
 * ledger activity within the window, and only creator payouts within
 * the window. Otherwise a recently-paid creator with old referrals
 * would appear suspiciously unprofitable.
 *
 * Staff exclusion is inherent — only creators are included, and referred
 * users are role-filtered implicitly (creators don't refer admins).
 */

export type LtvPeriod = "7d" | "30d" | "90d" | "all";

function daysForPeriod(period: LtvPeriod): number | null {
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

export type CreatorLtvRow = {
  userId: string;
  username: string | null;
  code: string | null;
  referredUsers: number;
  grossPlatformPnl: number;
  creatorCost: number;
  netRoi: number;
  roiMultiple: number | null;
};

export type CreatorLtvData = {
  period: LtvPeriod;
  rows: CreatorLtvRow[];
  totals: {
    grossPlatformPnl: number;
    creatorCost: number;
    netRoi: number;
    profitableCreators: number;
    losingCreators: number;
  };
};

export async function getCreatorLtv(period: LtvPeriod): Promise<CreatorLtvData> {
  const db = await getDb();
  const days = daysForPeriod(period);
  const periodWhere =
    days !== null ? `AND lt.created_at >= NOW() - INTERVAL '${days} days'` : "";

  // One raw query that joins creators → referred users → ledger for both
  // referred-user P&L and creator cost. This is O(creators) rows, one per
  // creator. The per-user P&L formula mirrors the balance-sheet P&L used
  // everywhere else (see _realized-pnl.ts), but scoped to the creator's
  // referred users and to the period window.
  const rows = await db.$queryRawUnsafe<
    {
      user_id: string;
      username: string | null;
      affiliate_code: string | null;
      referred_users: string;
      gross_platform_pnl: string;
      creator_cost: string;
    }[]
  >(`
    WITH creators AS (
      SELECT id AS user_id, username, affiliate_code
      FROM "user"
      WHERE role = 'creator'
    ),
    refs AS (
      SELECT
        acu.affiliate_user_id AS creator_id,
        acu.referred_user_id,
        COUNT(*) OVER (PARTITION BY acu.affiliate_user_id) AS ref_count_raw
      FROM affiliate_code_usages acu
      JOIN "user" creator ON creator.id = acu.affiliate_user_id AND creator.role = 'creator'
    ),
    refs_distinct AS (
      SELECT creator_id, referred_user_id
      FROM refs
      GROUP BY creator_id, referred_user_id
    ),
    ref_counts AS (
      SELECT creator_id, COUNT(*)::text AS cnt
      FROM refs_distinct
      GROUP BY creator_id
    ),
    referred_ledger AS (
      SELECT
        r.creator_id,
        COALESCE(SUM(CASE WHEN lt.type = 'deposit' THEN ABS(lt.amount::numeric) ELSE 0 END), 0) AS deposits,
        COALESCE(SUM(CASE WHEN lt.type = 'card_withdrawal' THEN ABS(lt.amount::numeric) ELSE 0 END), 0) AS withdrawals,
        COALESCE(SUM(CASE WHEN lt.type IN (
          'card_sale','reward_card_sale','card_exchange','exchange_excess_credit',
          'deposit_bonus','race_prize','gift_card_redeemed','promo_code_redeemed',
          'rakeback_claim','balance_reward_claim','affiliate_claim','rain_win',
          'waitlist_prize','creator_tip','voucher_redeemed','voucher_exchange',
          'exchange_excess_to_voucher','battle_excess_to_voucher','battle_refund'
        ) THEN ABS(lt.amount::numeric) ELSE 0 END), 0) AS payouts,
        COALESCE(SUM(CASE WHEN lt.type IN ('pack_opening','battle_bet','battle_sponsorship','withdrawal_shipping_fee')
          THEN ABS(lt.amount::numeric) ELSE 0 END), 0) AS wagers
      FROM refs_distinct r
      LEFT JOIN ledger_transactions lt
        ON lt.user_id = r.referred_user_id
        AND lt.status = 'completed'
        ${periodWhere}
      GROUP BY r.creator_id
    ),
    creator_cost AS (
      SELECT
        lt.user_id AS creator_id,
        COALESCE(SUM(CASE WHEN lt.type IN ('affiliate_claim','creator_tip','admin_balance_adjustment')
          THEN GREATEST((lt.balance_after - lt.balance_before)::numeric, 0) ELSE 0 END), 0) AS cost
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        ${periodWhere}
      GROUP BY lt.user_id
    )
    SELECT
      c.user_id,
      c.username,
      c.affiliate_code,
      COALESCE(rc.cnt, '0') AS referred_users,
      (COALESCE(rl.wagers, 0) - COALESCE(rl.payouts, 0))::text AS gross_platform_pnl,
      COALESCE(cc.cost, 0)::text AS creator_cost
    FROM creators c
    LEFT JOIN ref_counts rc ON rc.creator_id = c.user_id
    LEFT JOIN referred_ledger rl ON rl.creator_id = c.user_id
    LEFT JOIN creator_cost cc ON cc.creator_id = c.user_id
  `);

  const mapped: CreatorLtvRow[] = rows.map((r) => {
    const gross = Number(r.gross_platform_pnl ?? 0);
    const cost = Number(r.creator_cost ?? 0);
    const net = gross - cost;
    const multiple = cost > 0 ? gross / cost : null;
    return {
      userId: r.user_id,
      username: r.username,
      code: r.affiliate_code,
      referredUsers: Number(r.referred_users ?? 0),
      grossPlatformPnl: gross,
      creatorCost: cost,
      netRoi: net,
      roiMultiple: multiple,
    };
  });

  // Sort descending by net ROI — the view's primary ordering.
  mapped.sort((a, b) => b.netRoi - a.netRoi);

  const totals = mapped.reduce(
    (acc, r) => {
      acc.grossPlatformPnl += r.grossPlatformPnl;
      acc.creatorCost += r.creatorCost;
      acc.netRoi += r.netRoi;
      if (r.netRoi > 0) acc.profitableCreators += 1;
      else if (r.netRoi < 0) acc.losingCreators += 1;
      return acc;
    },
    {
      grossPlatformPnl: 0,
      creatorCost: 0,
      netRoi: 0,
      profitableCreators: 0,
      losingCreators: 0,
    },
  );

  return { period, rows: mapped, totals };
}
