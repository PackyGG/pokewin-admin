import { getDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "./_blacklist";
import { toNumber } from "@/lib/utils/decimal";

/**
 * Rewards-cost analytics.
 *
 * Aggregates every ledger payout that is a *reward* — money the house
 * GIVES users for free (bonuses, rakeback, affiliate commissions, rain /
 * race prizes, gift / promo redemptions, creator tips, signup-pack
 * balance rewards, waitlist prizes, redeemed vouchers). All of these are
 * house COSTS, so per CLAUDE.md House-POV they render ROSE everywhere.
 *
 * Reward ledger types (verified against prisma/schema.prisma
 * `ledger_transaction_type` + the existing payout buckets in
 * analytics-revenue.ts / users-financial.ts / analytics-top.ts):
 *
 *   • deposit_bonus / promo_code_redeemed / gift_card_redeemed  → bonuses
 *   • rakeback_claim                                            → rakeback
 *   • affiliate_claim                                           → affiliate
 *   • rain_win / race_prize                                     → rain/race
 *   • balance_reward_claim                                      → signup packs
 *   • creator_tip                                               → creator tips
 *   • waitlist_prize                                            → waitlist
 *   • voucher_redeemed                                          → vouchers
 *
 * Deliberately EXCLUDED (not free-gift rewards): the voucher/exchange
 * types that originate from the user's OWN gambling winnings/excess
 * (exchange_excess_to_voucher, exchange_excess_credit,
 * battle_excess_to_voucher, voucher_exchange, card_sale, card_exchange).
 * Those are handled by the gambling P&L / exchange buckets, not here.
 *
 * Staff (admin/support) excluded via the same subquery the revenue/
 * leaderboard queries use; the admin blacklist (`excluded_users`) is
 * appended too. Period-aware. All amounts use ABS(amount::numeric) so
 * they read as positive cost magnitudes.
 */

export type RewardsPeriod = "today" | "7d" | "30d" | "all";

function daysForPeriod(period: RewardsPeriod): number | null {
  switch (period) {
    case "today":
      return 1;
    case "7d":
      return 7;
    case "30d":
      return 30;
    case "all":
      return null;
  }
}

/** Stable category keys used across KPIs, the type breakdown + the chart. */
export type RewardCategoryKey =
  | "bonuses"
  | "rakeback"
  | "affiliate"
  | "rainRace"
  | "signupPack"
  | "creatorTip"
  | "waitlist"
  | "vouchers";

export type RewardCategory = {
  key: RewardCategoryKey;
  label: string;
  total: number;
  count: number;
  /** Share of total reward cost in the period (0–100). */
  share: number;
};

export type RewardsDailyPoint = {
  date: string;
  bonuses: number;
  rakeback: number;
  affiliate: number;
  rainRace: number;
  signupPack: number;
  creatorTip: number;
  waitlist: number;
  vouchers: number;
  /** Sum of all reward categories on this day. */
  total: number;
};

export type RewardRecipientRow = {
  userId: string;
  username: string | null;
  image: string | null;
  /** Total reward cost paid to this user in the period. */
  total: number;
  /** Number of reward ledger rows for this user in the period. */
  count: number;
};

export type RewardsAnalyticsData = {
  period: RewardsPeriod;
  totalCost: number;
  totalCount: number;
  categories: RewardCategory[];
  daily: RewardsDailyPoint[];
  topRecipients: RewardRecipientRow[];
};

const TOP_RECIPIENTS_LIMIT = 25;

const CATEGORY_LABELS: Record<RewardCategoryKey, string> = {
  bonuses: "Bonuses & Promos",
  rakeback: "Rakeback",
  affiliate: "Affiliate Commissions",
  rainRace: "Rain / Race Prizes",
  signupPack: "Signup / Balance Rewards",
  creatorTip: "Creator Tips",
  waitlist: "Waitlist Prizes",
  vouchers: "Vouchers",
};

// All reward ledger types as a single inlined SQL list — used for the
// per-user / per-day totals and the recipient leaderboard. Hardcoded
// enum values only (no user input), so safe to inline.
const REWARD_TYPES_SQL = `(
  'deposit_bonus','promo_code_redeemed','gift_card_redeemed',
  'rakeback_claim','affiliate_claim',
  'rain_win','race_prize','balance_reward_claim','creator_tip',
  'waitlist_prize','voucher_redeemed'
)`;

export async function getRewardsAnalytics(
  period: RewardsPeriod,
): Promise<RewardsAnalyticsData> {
  const db = await getDb();
  const days = daysForPeriod(period);
  const dateFilter =
    days !== null ? `AND lt.created_at >= NOW() - INTERVAL '${days} days'` : "";
  const excluded = await getExcludedUserIds();
  const blacklistSubquery = blacklistNotInClause("id", excluded);
  const blacklistJoinAlias = blacklistNotInClause("u.id", excluded);

  const [dailyRows, recipientRows] = await Promise.all([
    db.$queryRawUnsafe<
      {
        date: Date;
        bonuses: string;
        rakeback: string;
        affiliate: string;
        rain_race: string;
        signup_pack: string;
        creator_tip: string;
        waitlist: string;
        vouchers: string;
        bonuses_n: string;
        rakeback_n: string;
        affiliate_n: string;
        rain_race_n: string;
        signup_pack_n: string;
        creator_tip_n: string;
        waitlist_n: string;
        vouchers_n: string;
      }[]
    >(`
      SELECT
        DATE(lt.created_at) AS date,
        COALESCE(SUM(CASE WHEN lt.type IN ('deposit_bonus','promo_code_redeemed','gift_card_redeemed') THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS bonuses,
        COALESCE(SUM(CASE WHEN lt.type = 'rakeback_claim' THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS rakeback,
        COALESCE(SUM(CASE WHEN lt.type = 'affiliate_claim' THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS affiliate,
        COALESCE(SUM(CASE WHEN lt.type IN ('rain_win','race_prize') THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS rain_race,
        COALESCE(SUM(CASE WHEN lt.type = 'balance_reward_claim' THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS signup_pack,
        COALESCE(SUM(CASE WHEN lt.type = 'creator_tip' THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS creator_tip,
        COALESCE(SUM(CASE WHEN lt.type = 'waitlist_prize' THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS waitlist,
        COALESCE(SUM(CASE WHEN lt.type = 'voucher_redeemed' THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS vouchers,
        COUNT(*) FILTER (WHERE lt.type IN ('deposit_bonus','promo_code_redeemed','gift_card_redeemed'))::text AS bonuses_n,
        COUNT(*) FILTER (WHERE lt.type = 'rakeback_claim')::text AS rakeback_n,
        COUNT(*) FILTER (WHERE lt.type = 'affiliate_claim')::text AS affiliate_n,
        COUNT(*) FILTER (WHERE lt.type IN ('rain_win','race_prize'))::text AS rain_race_n,
        COUNT(*) FILTER (WHERE lt.type = 'balance_reward_claim')::text AS signup_pack_n,
        COUNT(*) FILTER (WHERE lt.type = 'creator_tip')::text AS creator_tip_n,
        COUNT(*) FILTER (WHERE lt.type = 'waitlist_prize')::text AS waitlist_n,
        COUNT(*) FILTER (WHERE lt.type = 'voucher_redeemed')::text AS vouchers_n
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type IN ${REWARD_TYPES_SQL}
        AND lt.user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin', 'support') ${blacklistSubquery})
        ${dateFilter}
      GROUP BY DATE(lt.created_at)
      ORDER BY date
    `),
    db.$queryRawUnsafe<
      {
        id: string;
        username: string | null;
        image: string | null;
        total: string;
        cnt: string;
      }[]
    >(`
      SELECT
        u.id,
        u.username,
        u.image,
        SUM(ABS(lt.amount::numeric))::text AS total,
        COUNT(*)::text AS cnt
      FROM ledger_transactions lt
      JOIN "user" u ON u.id = lt.user_id
      WHERE lt.status = 'completed'
        AND lt.type IN ${REWARD_TYPES_SQL}
        AND u.role NOT IN ('admin', 'support') ${blacklistJoinAlias}
        ${dateFilter}
      GROUP BY u.id, u.username, u.image
      ORDER BY SUM(ABS(lt.amount::numeric)) DESC
      LIMIT ${TOP_RECIPIENTS_LIMIT}
    `),
  ]);

  const daily: RewardsDailyPoint[] = dailyRows.map((r) => {
    const bonuses = toNumber(r.bonuses);
    const rakeback = toNumber(r.rakeback);
    const affiliate = toNumber(r.affiliate);
    const rainRace = toNumber(r.rain_race);
    const signupPack = toNumber(r.signup_pack);
    const creatorTip = toNumber(r.creator_tip);
    const waitlist = toNumber(r.waitlist);
    const vouchers = toNumber(r.vouchers);
    return {
      date: new Date(r.date).toISOString().split("T")[0],
      bonuses,
      rakeback,
      affiliate,
      rainRace,
      signupPack,
      creatorTip,
      waitlist,
      vouchers,
      total:
        bonuses +
        rakeback +
        affiliate +
        rainRace +
        signupPack +
        creatorTip +
        waitlist +
        vouchers,
    };
  });

  // Category totals + counts are summed from the daily rows (amounts) and
  // the per-day FILTER counts (counts), so a single grouped query feeds
  // both the time series and the breakdown without a second scan.
  const totals: Record<RewardCategoryKey, { total: number; count: number }> = {
    bonuses: { total: 0, count: 0 },
    rakeback: { total: 0, count: 0 },
    affiliate: { total: 0, count: 0 },
    rainRace: { total: 0, count: 0 },
    signupPack: { total: 0, count: 0 },
    creatorTip: { total: 0, count: 0 },
    waitlist: { total: 0, count: 0 },
    vouchers: { total: 0, count: 0 },
  };
  for (const r of dailyRows) {
    totals.bonuses.total += toNumber(r.bonuses);
    totals.bonuses.count += Number(r.bonuses_n);
    totals.rakeback.total += toNumber(r.rakeback);
    totals.rakeback.count += Number(r.rakeback_n);
    totals.affiliate.total += toNumber(r.affiliate);
    totals.affiliate.count += Number(r.affiliate_n);
    totals.rainRace.total += toNumber(r.rain_race);
    totals.rainRace.count += Number(r.rain_race_n);
    totals.signupPack.total += toNumber(r.signup_pack);
    totals.signupPack.count += Number(r.signup_pack_n);
    totals.creatorTip.total += toNumber(r.creator_tip);
    totals.creatorTip.count += Number(r.creator_tip_n);
    totals.waitlist.total += toNumber(r.waitlist);
    totals.waitlist.count += Number(r.waitlist_n);
    totals.vouchers.total += toNumber(r.vouchers);
    totals.vouchers.count += Number(r.vouchers_n);
  }

  const totalCost = Object.values(totals).reduce((a, t) => a + t.total, 0);
  const totalCount = Object.values(totals).reduce((a, t) => a + t.count, 0);

  const categoryKeys: RewardCategoryKey[] = [
    "bonuses",
    "rakeback",
    "affiliate",
    "rainRace",
    "signupPack",
    "creatorTip",
    "waitlist",
    "vouchers",
  ];
  const categories: RewardCategory[] = categoryKeys
    .map((key) => ({
      key,
      label: CATEGORY_LABELS[key],
      total: totals[key].total,
      count: totals[key].count,
      share: totalCost > 0 ? (totals[key].total / totalCost) * 100 : 0,
    }))
    .sort((a, b) => b.total - a.total);

  const topRecipients: RewardRecipientRow[] = recipientRows.map((r) => ({
    userId: r.id,
    username: r.username,
    image: r.image,
    total: toNumber(r.total),
    count: Number(r.cnt),
  }));

  return {
    period,
    totalCost,
    totalCount,
    categories,
    daily,
    topRecipients,
  };
}
