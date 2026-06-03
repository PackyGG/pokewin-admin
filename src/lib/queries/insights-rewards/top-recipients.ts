import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";
import { toNumber } from "@/lib/utils/decimal";
import { resolveRainHouseCost } from "@/lib/metrics";
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
 *     signupPack / waitlist) so the breakdown popover can render
 *     without a second query
 *   - distinct category count
 *   - the user's wager / payout / GGR in the SAME window
 *
 * CANONICAL CONSISTENCY (matches cross-category-summary / category-spend-
 * breakdown / roi on the same page):
 *   • `creator_tip` is NOT a reward — it is a verified user→user
 *     pass-through (RESIDUAL, $0 net house cost; ledger-sets.ts). It is
 *     excluded from the reward-type set and the per-category pivot so a
 *     recipient's total reward $ is not inflated by a fabricated cost.
 *   • Rain is NETTED to its house slice `max(0, Σ|rain_win| − Σ|rain_tip|)`
 *     per user (owner-confirmed) before folding into the rainRace bucket —
 *     NOT counted gross. `rain_tip` is the user/founder funding leg, never
 *     the house's money.
 *
 * Staff + blacklist excluded. Read-only. Limited to 25 — matches the
 * spec.
 */

// Reward ledger types counted toward a recipient's total. `creator_tip`
// is deliberately omitted (RESIDUAL pass-through). `rain_tip` is included
// so the rain house slice can be netted (`max(0, rain_win − rain_tip)`);
// it is never a category of its own (it is the rain FUNDING leg).
const ALL_REWARD_TYPES_SQL = `(
  'deposit_bonus','promo_code_redeemed','gift_card_redeemed',
  'rakeback_claim','affiliate_claim',
  'rain_win','rain_tip','race_prize','balance_reward_claim',
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
    /** race_prize + net rain (max(0, rain_win − rain_tip)) for this user. */
    rainRace: number;
    signupPack: number;
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
  // the per-category helpers (status, type, staff/blacklist). Rain is
  // bucketed into separate rain_win / rain_tip columns + race_prize so
  // the per-user house slice can be netted in JS (max(0, win − tip))
  // before folding into rainRace — mirrors category-spend-breakdown.ts.
  // ORDER BY uses the gross reward sum (a cheap top-25 ranking heuristic);
  // the DISPLAYED `total` below is recomputed from the netted categories.
  const rows = await db.$queryRawUnsafe<
    {
      user_id: string;
      username: string | null;
      gross_total: string;
      bonuses: string;
      rakeback: string;
      affiliate: string;
      race: string;
      rain_win: string;
      rain_tip: string;
      signup_pack: string;
      waitlist: string;
      wager_total: string;
      payout_total: string;
    }[]
  >(`
    WITH per_user AS (
      SELECT
        lt.user_id,
        -- Gross reward sum EXCLUDING rain_tip (the funding leg, never a
        -- payout) — used only for the top-25 ORDER BY.
        SUM(CASE WHEN lt.type::text <> 'rain_tip' THEN ABS(lt.amount::numeric) ELSE 0 END) AS gross_total,
        SUM(CASE WHEN lt.type::text IN ('deposit_bonus','promo_code_redeemed','gift_card_redeemed') THEN ABS(lt.amount::numeric) ELSE 0 END) AS bonuses,
        SUM(CASE WHEN lt.type::text = 'rakeback_claim' THEN ABS(lt.amount::numeric) ELSE 0 END) AS rakeback,
        SUM(CASE WHEN lt.type::text = 'affiliate_claim' THEN ABS(lt.amount::numeric) ELSE 0 END) AS affiliate,
        SUM(CASE WHEN lt.type::text = 'race_prize' THEN ABS(lt.amount::numeric) ELSE 0 END) AS race,
        SUM(CASE WHEN lt.type::text = 'rain_win' THEN ABS(lt.amount::numeric) ELSE 0 END) AS rain_win,
        SUM(CASE WHEN lt.type::text = 'rain_tip' THEN ABS(lt.amount::numeric) ELSE 0 END) AS rain_tip,
        SUM(CASE WHEN lt.type::text = 'balance_reward_claim' THEN ABS(lt.amount::numeric) ELSE 0 END) AS signup_pack,
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
      pu.gross_total::text AS gross_total,
      COALESCE(pu.bonuses, 0)::text AS bonuses,
      COALESCE(pu.rakeback, 0)::text AS rakeback,
      COALESCE(pu.affiliate, 0)::text AS affiliate,
      COALESCE(pu.race, 0)::text AS race,
      COALESCE(pu.rain_win, 0)::text AS rain_win,
      COALESCE(pu.rain_tip, 0)::text AS rain_tip,
      COALESCE(pu.signup_pack, 0)::text AS signup_pack,
      COALESCE(pu.waitlist, 0)::text AS waitlist,
      COALESCE(uw.wager_total, 0)::text AS wager_total,
      COALESCE(up.payout_total, 0)::text AS payout_total
    FROM per_user pu
    JOIN "user" u ON u.id = pu.user_id
    LEFT JOIN user_wager uw ON uw.user_id = pu.user_id
    LEFT JOIN user_payout up ON up.user_id = pu.user_id
    ORDER BY pu.gross_total DESC
    LIMIT ${TOP_LIMIT}
  `);

  return rows.map((r) => {
    const wagerTotal = toNumber(r.wager_total);
    const payoutTotal = toNumber(r.payout_total);
    const bonuses = toNumber(r.bonuses);
    const rakeback = toNumber(r.rakeback);
    const affiliate = toNumber(r.affiliate);
    const signupPack = toNumber(r.signup_pack);
    const waitlist = toNumber(r.waitlist);
    // Net rain to the house slice (owner-confirmed), then fold into
    // rainRace alongside race_prize — same treatment as the breakdown.
    const netRain = resolveRainHouseCost({
      kind: "net",
      rainWinTotal: toNumber(r.rain_win),
      rainTipTotal: toNumber(r.rain_tip),
    });
    const rainRace = toNumber(r.race) + netRain;
    const perCategory = {
      bonuses,
      rakeback,
      affiliate,
      rainRace,
      signupPack,
      waitlist,
    };
    // Total = sum of the (rain-netted) house-cost categories, so it never
    // counts the rain funding leg or a fabricated creator_tip cost. Distinct
    // category count derived from the same netted buckets.
    const total =
      bonuses + rakeback + affiliate + rainRace + signupPack + waitlist;
    const categoryCount = Object.values(perCategory).filter(
      (v) => v > 0,
    ).length;
    return {
      userId: r.user_id,
      username: r.username,
      total,
      categoryCount,
      perCategory,
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
