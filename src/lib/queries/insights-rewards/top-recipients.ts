import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";
import { toNumber } from "@/lib/utils/decimal";
import {
  daysForInsightsPeriod,
  cacheTtlForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "./_period";

/**
 * Top reward recipients across ALL categories combined for the active
 * window. Used by the "Top spenders on rewards" tab — the 25 users who
 * received the largest reward $ total.
 *
 * Each row carries:
 *   - userId / username (link target for /users/[id])
 *   - total reward $
 *   - per-category split (bonuses / rakeback / affiliate / rainRace /
 *     signupPack / creatorTip / waitlist) so the breakdown popover
 *     can render without a second query
 *   - distinct category count
 *   - the user's wager / payout / GGR in the SAME window
 *
 * Staff + blacklist excluded. Read-only. Limited to 25 — matches the
 * spec.
 */

const ALL_REWARD_TYPES_SQL = `(
  'deposit_bonus','promo_code_redeemed','gift_card_redeemed',
  'rakeback_claim','affiliate_claim',
  'rain_win','race_prize','balance_reward_claim','creator_tip',
  'waitlist_prize'
)`;

const WAGER_TYPES_SQL = `(
  'pack_opening','battle_bet','battle_sponsorship','upgrader_bet'
)`;

const PAYOUT_TYPES_SQL = `('battle_refund','upgrader_payout')`;

const TOP_LIMIT = 25;

export type TopRecipientRow = {
  userId: string;
  username: string | null;
  total: number;
  categoryCount: number;
  perCategory: {
    bonuses: number;
    rakeback: number;
    affiliate: number;
    rainRace: number;
    signupPack: number;
    creatorTip: number;
    waitlist: number;
  };
  wagerTotal: number;
  payoutTotal: number;
  /** wager − payouts in the same window — gameplay GGR for the user. */
  ggrInWindow: number;
};

async function computeTopRecipients(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<TopRecipientRow[]> {
  const db = await getDb();
  const days = daysForInsightsPeriod(period);
  const dateFilter =
    days !== null ? `AND lt.created_at >= NOW() - INTERVAL '${days} days'` : "";
  const blacklistJoin = blacklistNotInClause("u.id", blacklistIds);

  // Single CTE-based pivot. The per-category SUM(CASE) buckets the
  // amounts; the WHERE filter keeps the cost rollup symmetric with
  // the per-category helpers (status, type, staff/blacklist).
  const rows = await db.$queryRawUnsafe<
    {
      user_id: string;
      username: string | null;
      total: string;
      categories: string;
      bonuses: string;
      rakeback: string;
      affiliate: string;
      rain_race: string;
      signup_pack: string;
      creator_tip: string;
      waitlist: string;
      wager_total: string;
      payout_total: string;
    }[]
  >(`
    WITH per_user AS (
      SELECT
        lt.user_id,
        SUM(ABS(lt.amount::numeric)) AS total,
        COUNT(DISTINCT CASE
          WHEN lt.type::text IN ('deposit_bonus','promo_code_redeemed','gift_card_redeemed') THEN 'bonuses'
          WHEN lt.type::text = 'rakeback_claim' THEN 'rakeback'
          WHEN lt.type::text = 'affiliate_claim' THEN 'affiliate'
          WHEN lt.type::text IN ('rain_win','race_prize') THEN 'rainRace'
          WHEN lt.type::text = 'balance_reward_claim' THEN 'signupPack'
          WHEN lt.type::text = 'creator_tip' THEN 'creatorTip'
          WHEN lt.type::text = 'waitlist_prize' THEN 'waitlist'
        END) AS categories,
        SUM(CASE WHEN lt.type::text IN ('deposit_bonus','promo_code_redeemed','gift_card_redeemed') THEN ABS(lt.amount::numeric) ELSE 0 END) AS bonuses,
        SUM(CASE WHEN lt.type::text = 'rakeback_claim' THEN ABS(lt.amount::numeric) ELSE 0 END) AS rakeback,
        SUM(CASE WHEN lt.type::text = 'affiliate_claim' THEN ABS(lt.amount::numeric) ELSE 0 END) AS affiliate,
        SUM(CASE WHEN lt.type::text IN ('rain_win','race_prize') THEN ABS(lt.amount::numeric) ELSE 0 END) AS rain_race,
        SUM(CASE WHEN lt.type::text = 'balance_reward_claim' THEN ABS(lt.amount::numeric) ELSE 0 END) AS signup_pack,
        SUM(CASE WHEN lt.type::text = 'creator_tip' THEN ABS(lt.amount::numeric) ELSE 0 END) AS creator_tip,
        SUM(CASE WHEN lt.type::text = 'waitlist_prize' THEN ABS(lt.amount::numeric) ELSE 0 END) AS waitlist
      FROM ledger_transactions lt
      JOIN "user" u ON u.id = lt.user_id
      WHERE lt.status = 'completed'
        AND lt.type::text IN ${ALL_REWARD_TYPES_SQL}
        AND u.role NOT IN ('admin', 'support') ${blacklistJoin}
        ${dateFilter}
      GROUP BY lt.user_id
    ),
    user_wager AS (
      SELECT lt.user_id, SUM(ABS(lt.amount::numeric)) AS wager_total
      FROM ledger_transactions lt
      JOIN "user" u ON u.id = lt.user_id
      WHERE lt.status = 'completed'
        AND lt.type::text IN ${WAGER_TYPES_SQL}
        AND u.role NOT IN ('admin', 'support') ${blacklistJoin}
        ${dateFilter}
      GROUP BY lt.user_id
    ),
    user_payout AS (
      SELECT lt.user_id, SUM(ABS(lt.amount::numeric)) AS payout_total
      FROM ledger_transactions lt
      JOIN "user" u ON u.id = lt.user_id
      WHERE lt.status = 'completed'
        AND lt.type::text IN ${PAYOUT_TYPES_SQL}
        AND u.role NOT IN ('admin', 'support') ${blacklistJoin}
        ${dateFilter}
      GROUP BY lt.user_id
    )
    SELECT
      pu.user_id,
      u.username,
      pu.total::text AS total,
      pu.categories::text AS categories,
      COALESCE(pu.bonuses, 0)::text AS bonuses,
      COALESCE(pu.rakeback, 0)::text AS rakeback,
      COALESCE(pu.affiliate, 0)::text AS affiliate,
      COALESCE(pu.rain_race, 0)::text AS rain_race,
      COALESCE(pu.signup_pack, 0)::text AS signup_pack,
      COALESCE(pu.creator_tip, 0)::text AS creator_tip,
      COALESCE(pu.waitlist, 0)::text AS waitlist,
      COALESCE(uw.wager_total, 0)::text AS wager_total,
      COALESCE(up.payout_total, 0)::text AS payout_total
    FROM per_user pu
    JOIN "user" u ON u.id = pu.user_id
    LEFT JOIN user_wager uw ON uw.user_id = pu.user_id
    LEFT JOIN user_payout up ON up.user_id = pu.user_id
    ORDER BY pu.total DESC
    LIMIT ${TOP_LIMIT}
  `);

  return rows.map((r) => {
    const wagerTotal = toNumber(r.wager_total);
    const payoutTotal = toNumber(r.payout_total);
    return {
      userId: r.user_id,
      username: r.username,
      total: toNumber(r.total),
      categoryCount: Number(r.categories ?? 0),
      perCategory: {
        bonuses: toNumber(r.bonuses),
        rakeback: toNumber(r.rakeback),
        affiliate: toNumber(r.affiliate),
        rainRace: toNumber(r.rain_race),
        signupPack: toNumber(r.signup_pack),
        creatorTip: toNumber(r.creator_tip),
        waitlist: toNumber(r.waitlist),
      },
      wagerTotal,
      payoutTotal,
      ggrInWindow: wagerTotal - payoutTotal,
    };
  });
}

const cachedTopRecipients = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeTopRecipients(period, blacklistIds),
  ["insights-rewards-top-recipients-v1"],
  { revalidate: 60, tags: ["rewards-analytics", "insights-rewards"] },
);

const cachedTopRecipientsLifetime = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeTopRecipients(period, blacklistIds),
  ["insights-rewards-top-recipients-lifetime-v1"],
  { revalidate: 300, tags: ["rewards-analytics", "insights-rewards"] },
);

export async function getRewardsTopRecipients(
  period: InsightsRewardsPeriod,
): Promise<TopRecipientRow[]> {
  const blacklist = await getExcludedUserIds();
  const sorted = [...blacklist].sort();
  const ttl = cacheTtlForInsightsPeriod(period);
  return ttl >= 300
    ? cachedTopRecipientsLifetime(period, sorted)
    : cachedTopRecipients(period, sorted);
}
