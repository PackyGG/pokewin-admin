import { daysAgoFilter, queryRows, realCustomersScopeDrizzle, sql } from "@/lib/queries/insights-rewards/_drizzle-query";
import "server-only";

import { unstable_cache } from "next/cache";
import { getReadDrizzleDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { toNumber } from "@/lib/utils/decimal";
import { resolveRainHouseCost } from "@/lib/metrics";
import { withTiming } from "@/lib/observability/query-timings";
import {
  daysForInsightsPeriodCapped,
  cacheTtlForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "./_period";

/**
 * program-recipients.ts — who the reward budget actually goes to, keyed on
 * the SAME programs as `program-spend.ts`.
 *
 * Replaces the ranking behind the old "Top spenders" tab
 * (`top-recipients.ts`), which was built against the previous category set
 * and therefore missed the two largest live programs: it never scanned
 * `affiliate_leaderboard_prize` (leaderboards) or the categorised
 * `admin_balance_adjustment` credits (lossback / manual deposit bonus). A
 * top-recipient list that omits the biggest payouts ranks the wrong people,
 * so this is a correctness fix, not a re-skin.
 *
 * Per player, in the active window:
 *   • total reward received, split per program
 *   • how many distinct programs they drew from
 *   • their gameplay GGR over the same window
 *   • net = GGR − reward cost. House-POV: positive = the house is ahead on
 *     this player despite what we paid them (emerald); negative = we are
 *     down on them (rose).
 *
 * ─── SCOPE / MODEL ──────────────────────────────────────────────────
 *
 * `realCustomersScopeDrizzle()` (staff + creators + blacklist dropped) — this
 * is a PLAYER leaderboard, so the customer scope is the right one. That
 * deliberately excludes the creator tips/sponsorship pool, whose spend is
 * attributed to creators rather than to the players ranked here; it is
 * reported on the Overview / Programs views instead.
 *
 * DAILY PACKS are likewise not part of the ranking: they book no ledger row
 * and their per-player value is cents (≈$0.19 per open across ~12.5k
 * claimers), so folding in a second heavy `user_inventory` sweep would cost
 * a scan without moving any position. The UI states this explicitly rather
 * than implying the total is every program.
 *
 * Rain is netted per player to its house slice `max(0, rain_win − rain_tip)`
 * via the canonical `resolveRainHouseCost`, same as everywhere else.
 *
 * Rides `idx_ledger_tx_created_at`; lifetime capped to
 * `INSIGHTS_LIFETIME_LOOKBACK_DAYS`. Read-only, two-layer cached.
 */

const TOP_LIMIT = 25;

const WAGER_TYPES_SQL = `(
  'pack_opening','battle_bet','battle_sponsorship','upgrader_bet'
)`;
const PAYOUT_TYPES_SQL = `('battle_refund','upgrader_payout')`;

/** Programs a PLAYER can personally receive (creator pool excluded — see header). */
export const RECIPIENT_PROGRAM_KEYS = [
  "depositBonus",
  "rakeback",
  "lossback",
  "leaderboards",
  "races",
  "other",
] as const;

export type RecipientProgramKey = (typeof RECIPIENT_PROGRAM_KEYS)[number];

export type RewardRecipientRow = {
  userId: string;
  username: string | null;
  /** Σ reward received across every program in the window. */
  total: number;
  /** How many distinct programs paid this player. */
  programCount: number;
  perProgram: Record<RecipientProgramKey, number>;
  /** Wager − payouts over the same window (gameplay GGR, House-POV). */
  ggrInWindow: number;
  /** ggrInWindow − total. Positive = house ahead on this player. */
  netToHouse: number;
};

async function computeRecipients(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<RewardRecipientRow[]> {
  void blacklistIds; // consumed by realCustomersScopeDrizzle; kept for the cache key
  return withTiming("insights-rewards.program-recipients", async () => {
    const db = await getReadDrizzleDb();
    const days = daysForInsightsPeriodCapped(period);
    const dateFilter = daysAgoFilter("lt.created_at", days);
    const scope = await realCustomersScopeDrizzle();

    // One pass, pivoted per program. Rain legs stay split so the per-player
    // house slice can be netted below before it joins `other`. Ranking uses
    // the GROSS reward sum (a cheap top-N heuristic); the DISPLAYED total is
    // recomputed from the netted programs, so a rain-heavy player can shift
    // slightly within the list but never enters it on rain that was
    // user-funded.
    const rows = await queryRows<
      {
        user_id: string;
        username: string | null;
        deposit_bonus: string;
        rakeback: string;
        lossback: string;
        leaderboards: string;
        races: string;
        other_base: string;
        rain_win: string;
        rain_tip: string;
        wager_total: string;
        payout_total: string;
      }[]
    >(db, sql`
      WITH rewards AS (
        SELECT
          lt.user_id,
          SUM(CASE
            WHEN lt.type::text = 'deposit_bonus' THEN ABS(lt.amount::numeric)
            WHEN lt.type::text = 'admin_balance_adjustment' AND lt.amount::numeric > 0
                 AND lt.metadata->>'adjustment_category' = 'deposit_bonus' THEN ABS(lt.amount::numeric)
            ELSE 0 END) AS deposit_bonus,
          SUM(CASE WHEN lt.type::text = 'rakeback_claim' THEN ABS(lt.amount::numeric) ELSE 0 END) AS rakeback,
          SUM(CASE
            WHEN lt.type::text = 'admin_balance_adjustment' AND lt.amount::numeric > 0
                 AND lt.metadata->>'adjustment_category' = 'lossback' THEN ABS(lt.amount::numeric)
            ELSE 0 END) AS lossback,
          SUM(CASE WHEN lt.type::text = 'affiliate_leaderboard_prize' THEN ABS(lt.amount::numeric) ELSE 0 END) AS leaderboards,
          SUM(CASE WHEN lt.type::text = 'race_prize' THEN ABS(lt.amount::numeric) ELSE 0 END) AS races,
          SUM(CASE
            WHEN lt.type::text IN ('promo_code_redeemed','gift_card_redeemed','balance_reward_claim','waitlist_prize','affiliate_claim')
              THEN ABS(lt.amount::numeric)
            WHEN lt.type::text = 'voucher_redeemed' AND lt.metadata->>'origin' = 'manual' THEN ABS(lt.amount::numeric)
            WHEN lt.type::text = 'admin_balance_adjustment' AND lt.amount::numeric > 0
                 AND lt.metadata->>'adjustment_category' IN
                   ('bonus','reload','giveaway','deposit_problem','withdrawal_failed','bugs','trivia')
              THEN ABS(lt.amount::numeric)
            ELSE 0 END) AS other_base,
          SUM(CASE WHEN lt.type::text = 'rain_win' THEN ABS(lt.amount::numeric) ELSE 0 END) AS rain_win,
          SUM(CASE WHEN lt.type::text = 'rain_tip' THEN ABS(lt.amount::numeric) ELSE 0 END) AS rain_tip,
          SUM(CASE
            WHEN lt.type::text IN ('deposit_bonus','rakeback_claim','affiliate_leaderboard_prize','race_prize',
                                   'promo_code_redeemed','gift_card_redeemed','balance_reward_claim',
                                   'waitlist_prize','affiliate_claim','rain_win')
              THEN ABS(lt.amount::numeric)
            WHEN lt.type::text = 'voucher_redeemed' AND lt.metadata->>'origin' = 'manual' THEN ABS(lt.amount::numeric)
            WHEN lt.type::text = 'admin_balance_adjustment' AND lt.amount::numeric > 0
                 AND lt.metadata->>'adjustment_category' IN
                   ('deposit_bonus','lossback','bonus','reload','giveaway','deposit_problem','withdrawal_failed','bugs','trivia')
              THEN ABS(lt.amount::numeric)
            ELSE 0 END) AS gross_total
        FROM ledger_transactions lt
        WHERE lt.status = 'completed'
          AND lt.type::text IN (
            'deposit_bonus','rakeback_claim','affiliate_leaderboard_prize','race_prize',
            'promo_code_redeemed','gift_card_redeemed','balance_reward_claim','waitlist_prize',
            'affiliate_claim','rain_win','rain_tip','voucher_redeemed','admin_balance_adjustment'
          )
          AND lt.user_id IN ${scope}
          ${dateFilter}
        GROUP BY lt.user_id
        HAVING SUM(CASE
            WHEN lt.type::text IN ('deposit_bonus','rakeback_claim','affiliate_leaderboard_prize','race_prize',
                                   'promo_code_redeemed','gift_card_redeemed','balance_reward_claim',
                                   'waitlist_prize','affiliate_claim','rain_win')
              THEN ABS(lt.amount::numeric)
            WHEN lt.type::text = 'voucher_redeemed' AND lt.metadata->>'origin' = 'manual' THEN ABS(lt.amount::numeric)
            WHEN lt.type::text = 'admin_balance_adjustment' AND lt.amount::numeric > 0
                 AND lt.metadata->>'adjustment_category' IN
                   ('deposit_bonus','lossback','bonus','reload','giveaway','deposit_problem','withdrawal_failed','bugs','trivia')
              THEN ABS(lt.amount::numeric)
            ELSE 0 END) > 0
        ORDER BY gross_total DESC
        LIMIT ${TOP_LIMIT}
      ),
      play AS (
        SELECT
          lt.user_id,
          COALESCE(SUM(CASE WHEN lt.type::text IN ${sql.raw(WAGER_TYPES_SQL)} THEN ABS(lt.amount::numeric) ELSE 0 END), 0) AS wager_total,
          COALESCE(SUM(CASE WHEN lt.type::text IN ${sql.raw(PAYOUT_TYPES_SQL)} THEN ABS(lt.amount::numeric) ELSE 0 END), 0) AS payout_total
        FROM ledger_transactions lt
        WHERE lt.status = 'completed'
          AND lt.user_id IN (SELECT user_id FROM rewards)
          AND lt.type::text IN (
            'pack_opening','battle_bet','battle_sponsorship','upgrader_bet','battle_refund','upgrader_payout'
          )
          ${dateFilter}
        GROUP BY lt.user_id
      )
      SELECT
        r.user_id,
        u.username,
        r.deposit_bonus::text  AS deposit_bonus,
        r.rakeback::text       AS rakeback,
        r.lossback::text       AS lossback,
        r.leaderboards::text   AS leaderboards,
        r.races::text          AS races,
        r.other_base::text     AS other_base,
        r.rain_win::text       AS rain_win,
        r.rain_tip::text       AS rain_tip,
        COALESCE(p.wager_total, 0)::text  AS wager_total,
        COALESCE(p.payout_total, 0)::text AS payout_total
      FROM rewards r
      JOIN "user" u ON u.id = r.user_id
      LEFT JOIN play p ON p.user_id = r.user_id
    `);

    return rows
      .map((r) => {
        const perProgram: Record<RecipientProgramKey, number> = {
          depositBonus: toNumber(r.deposit_bonus),
          rakeback: toNumber(r.rakeback),
          lossback: toNumber(r.lossback),
          leaderboards: toNumber(r.leaderboards),
          races: toNumber(r.races),
          other:
            toNumber(r.other_base) +
            resolveRainHouseCost({
              kind: "net",
              rainWinTotal: toNumber(r.rain_win),
              rainTipTotal: toNumber(r.rain_tip),
            }),
        };
        const total = Object.values(perProgram).reduce((a, b) => a + b, 0);
        const ggrInWindow = toNumber(r.wager_total) - toNumber(r.payout_total);
        return {
          userId: r.user_id,
          username: r.username,
          total,
          programCount: Object.values(perProgram).filter((v) => v > 0).length,
          perProgram,
          ggrInWindow,
          netToHouse: ggrInWindow - total,
        };
      })
      .filter((r) => r.total > 0)
      .sort((a, b) => b.total - a.total);
  });
}

const cachedRecipients = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeRecipients(period, blacklistIds),
  ["insights-rewards-program-recipients-v1"],
  { revalidate: 60, tags: ["rewards-analytics", "insights-rewards"] },
);

const cachedRecipientsLifetime = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeRecipients(period, blacklistIds),
  ["insights-rewards-program-recipients-lifetime-v1"],
  { revalidate: 300, tags: ["rewards-analytics", "insights-rewards"] },
);

export async function getRewardProgramRecipients(
  period: InsightsRewardsPeriod,
): Promise<RewardRecipientRow[]> {
  const blacklist = await getExcludedUserIds();
  const sorted = [...blacklist].sort();
  const ttl = cacheTtlForInsightsPeriod(period);
  return ttl >= 300
    ? cachedRecipientsLifetime(period, sorted)
    : cachedRecipients(period, sorted);
}
