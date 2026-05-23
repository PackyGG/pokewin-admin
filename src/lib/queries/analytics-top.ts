import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "./_blacklist";

// Append-only `AND u.id NOT IN (...)` fragment for the staff-exclusion
// WHERE clauses used in each leaderboard query. Empty string when
// nothing is admin-blacklisted so the query stays valid. IDs are
// inlined as quoted literals — packy.gg user_ids are alphanum, with
// defensive single-quote escaping.
async function buildBlacklistIdNotIn(alias = "u"): Promise<string> {
  const excluded = await getExcludedUserIds();
  return blacklistNotInClause(`${alias}.id`, excluded);
}

/**
 * Top-performers leaderboards for /analytics Top Performers tab.
 *
 * Six leaderboards:
 *   • top_depositors  — sum of completed deposit ledger rows in period
 *   • top_wagerers    — sum of pack_opening + battle_bet + sponsorship
 *   • top_losers      — highest house P&L against the user (lost the
 *                       most money to us) = wagers − payouts
 *   • top_winners     — inverse of top_losers (most money taken OFF
 *                       the house). When wagers < payouts, the user
 *                       is net-positive against us.
 *   • top_creators    — by wager volume they drove (sum of wagers by
 *                       referred users) + their commission earnings
 *   • top_countries   — by GGR (wagers − payouts) aggregated per country
 *
 * Each leaderboard is period-scoped via the same `LeaderboardPeriod`
 * enum. Staff users (admin, support) are excluded from user-level
 * leaderboards — those are internal accounts and shouldn't appear
 * next to real customers. Creators are kept in per the team's
 * documented decision in _exclude-staff.ts (they wager + deposit
 * like normal users for streams / give-aways / their own play).
 */

export type LeaderboardPeriod = "7d" | "30d" | "all";

function daysForPeriod(period: LeaderboardPeriod): number | null {
  switch (period) {
    case "7d":
      return 7;
    case "30d":
      return 30;
    case "all":
      return null;
  }
}

export type UserLeaderRow = {
  userId: string;
  username: string | null;
  image: string | null;
  amount: number;
};

export type CreatorLeaderRow = {
  userId: string;
  username: string | null;
  code: string | null;
  wagerVolume: number;
  commission: number;
};

export type CountryLeaderRow = {
  country: string;
  countryCode: string | null;
  users: number;
  ggr: number;
};

const LIMIT = 20;
const WAGER_TYPES = `('pack_opening','battle_bet','battle_sponsorship')`;
const PAYOUT_TYPES = `('battle_refund','card_sale','reward_card_sale','card_exchange','exchange_excess_credit','deposit_bonus','race_prize','gift_card_redeemed','promo_code_redeemed','rakeback_claim','balance_reward_claim','affiliate_claim','rain_win','waitlist_prize','creator_tip','voucher_redeemed','voucher_exchange','exchange_excess_to_voucher','battle_excess_to_voucher')`;

function periodFilter(period: LeaderboardPeriod, column = "lt.created_at"): string {
  const days = daysForPeriod(period);
  return days !== null ? `AND ${column} >= NOW() - INTERVAL '${days} days'` : "";
}

export async function getTopDepositors(
  period: LeaderboardPeriod,
): Promise<UserLeaderRow[]> {
  const db = await getDb();
  const blacklistIdNotIn = await buildBlacklistIdNotIn();
  const rows = await db.$queryRawUnsafe<
    { id: string; username: string | null; image: string | null; amount: string }[]
  >(`
    SELECT u.id, u.username, u.image, SUM(ABS(lt.amount::numeric))::text AS amount
    FROM ledger_transactions lt
    JOIN "user" u ON u.id = lt.user_id
    WHERE lt.status = 'completed' AND lt.type = 'deposit'
      AND u.role NOT IN ('admin', 'support') ${blacklistIdNotIn}
      ${periodFilter(period)}
    GROUP BY u.id, u.username, u.image
    ORDER BY SUM(ABS(lt.amount::numeric)) DESC
    LIMIT ${LIMIT}
  `);
  return rows.map((r) => ({
    userId: r.id,
    username: r.username,
    image: r.image,
    amount: toNumber(r.amount),
  }));
}

export async function getTopWagerers(
  period: LeaderboardPeriod,
): Promise<UserLeaderRow[]> {
  const db = await getDb();
  const blacklistIdNotIn = await buildBlacklistIdNotIn();
  const rows = await db.$queryRawUnsafe<
    { id: string; username: string | null; image: string | null; amount: string }[]
  >(`
    SELECT u.id, u.username, u.image, SUM(ABS(lt.amount::numeric))::text AS amount
    FROM ledger_transactions lt
    JOIN "user" u ON u.id = lt.user_id
    WHERE lt.status = 'completed' AND lt.type IN ${WAGER_TYPES}
      AND u.role NOT IN ('admin', 'support') ${blacklistIdNotIn}
      ${periodFilter(period)}
    GROUP BY u.id, u.username, u.image
    ORDER BY SUM(ABS(lt.amount::numeric)) DESC
    LIMIT ${LIMIT}
  `);
  return rows.map((r) => ({
    userId: r.id,
    username: r.username,
    image: r.image,
    amount: toNumber(r.amount),
  }));
}

/**
 * Top losers = users we made the most gross gaming revenue from. High
 * positive house PnL per user in the period.
 */
export async function getTopLosers(
  period: LeaderboardPeriod,
): Promise<UserLeaderRow[]> {
  const db = await getDb();
  const blacklistIdNotIn = await buildBlacklistIdNotIn();
  const rows = await db.$queryRawUnsafe<
    { id: string; username: string | null; image: string | null; amount: string }[]
  >(`
    SELECT
      u.id,
      u.username,
      u.image,
      (
        COALESCE(SUM(CASE WHEN lt.type IN ${WAGER_TYPES} THEN ABS(lt.amount::numeric) ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN lt.type IN ${PAYOUT_TYPES} THEN ABS(lt.amount::numeric) ELSE 0 END), 0)
      )::text AS amount
    FROM ledger_transactions lt
    JOIN "user" u ON u.id = lt.user_id
    WHERE lt.status = 'completed'
      AND u.role NOT IN ('admin', 'support') ${blacklistIdNotIn}
      ${periodFilter(period)}
    GROUP BY u.id, u.username, u.image
    HAVING (
        COALESCE(SUM(CASE WHEN lt.type IN ${WAGER_TYPES} THEN ABS(lt.amount::numeric) ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN lt.type IN ${PAYOUT_TYPES} THEN ABS(lt.amount::numeric) ELSE 0 END), 0)
    ) > 0
    ORDER BY (
        COALESCE(SUM(CASE WHEN lt.type IN ${WAGER_TYPES} THEN ABS(lt.amount::numeric) ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN lt.type IN ${PAYOUT_TYPES} THEN ABS(lt.amount::numeric) ELSE 0 END), 0)
    ) DESC
    LIMIT ${LIMIT}
  `);
  return rows.map((r) => ({
    userId: r.id,
    username: r.username,
    image: r.image,
    amount: toNumber(r.amount),
  }));
}

/**
 * Top winners = users who have taken the most money off the house.
 * House PnL is negative — the amount shown is the magnitude (positive).
 */
export async function getTopWinners(
  period: LeaderboardPeriod,
): Promise<UserLeaderRow[]> {
  const db = await getDb();
  const blacklistIdNotIn = await buildBlacklistIdNotIn();
  const rows = await db.$queryRawUnsafe<
    { id: string; username: string | null; image: string | null; amount: string }[]
  >(`
    SELECT
      u.id,
      u.username,
      u.image,
      (
        COALESCE(SUM(CASE WHEN lt.type IN ${PAYOUT_TYPES} THEN ABS(lt.amount::numeric) ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN lt.type IN ${WAGER_TYPES} THEN ABS(lt.amount::numeric) ELSE 0 END), 0)
      )::text AS amount
    FROM ledger_transactions lt
    JOIN "user" u ON u.id = lt.user_id
    WHERE lt.status = 'completed'
      AND u.role NOT IN ('admin', 'support') ${blacklistIdNotIn}
      ${periodFilter(period)}
    GROUP BY u.id, u.username, u.image
    HAVING (
        COALESCE(SUM(CASE WHEN lt.type IN ${PAYOUT_TYPES} THEN ABS(lt.amount::numeric) ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN lt.type IN ${WAGER_TYPES} THEN ABS(lt.amount::numeric) ELSE 0 END), 0)
    ) > 0
    ORDER BY (
        COALESCE(SUM(CASE WHEN lt.type IN ${PAYOUT_TYPES} THEN ABS(lt.amount::numeric) ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN lt.type IN ${WAGER_TYPES} THEN ABS(lt.amount::numeric) ELSE 0 END), 0)
    ) DESC
    LIMIT ${LIMIT}
  `);
  return rows.map((r) => ({
    userId: r.id,
    username: r.username,
    image: r.image,
    amount: toNumber(r.amount),
  }));
}

export async function getTopCreatorsByVolume(
  period: LeaderboardPeriod,
): Promise<CreatorLeaderRow[]> {
  const db = await getDb();
  const days = daysForPeriod(period);
  const refWindow =
    days !== null ? `AND lt.created_at >= NOW() - INTERVAL '${days} days'` : "";
  const commissionWindow =
    days !== null ? `AND cl.created_at >= NOW() - INTERVAL '${days} days'` : "";

  const rows = await db.$queryRawUnsafe<
    {
      user_id: string;
      username: string | null;
      affiliate_code: string | null;
      wager_volume: string;
      commission: string;
    }[]
  >(`
    WITH creators AS (
      SELECT id AS user_id, username, affiliate_code
      FROM "user"
      WHERE role = 'creator'
    ),
    wager_volume AS (
      SELECT acu.affiliate_user_id AS creator_id, COALESCE(SUM(ABS(lt.amount::numeric)), 0)::text AS vol
      FROM affiliate_code_usages acu
      JOIN ledger_transactions lt ON lt.user_id = acu.referred_user_id
      WHERE lt.status = 'completed' AND lt.type IN ${WAGER_TYPES}
        ${refWindow}
      GROUP BY acu.affiliate_user_id
    ),
    commissions AS (
      SELECT cl.user_id AS creator_id, COALESCE(SUM(ABS(cl.amount::numeric)), 0)::text AS amt
      FROM ledger_transactions cl
      WHERE cl.status = 'completed' AND cl.type = 'affiliate_claim'
        ${commissionWindow}
      GROUP BY cl.user_id
    )
    SELECT
      c.user_id,
      c.username,
      c.affiliate_code,
      COALESCE(w.vol, '0') AS wager_volume,
      COALESCE(com.amt, '0') AS commission
    FROM creators c
    LEFT JOIN wager_volume w ON w.creator_id = c.user_id
    LEFT JOIN commissions com ON com.creator_id = c.user_id
    ORDER BY COALESCE(w.vol::numeric, 0) DESC
    LIMIT ${LIMIT}
  `);
  return rows.map((r) => ({
    userId: r.user_id,
    username: r.username,
    code: r.affiliate_code,
    wagerVolume: toNumber(r.wager_volume),
    commission: toNumber(r.commission),
  }));
}

export async function getTopCountries(
  period: LeaderboardPeriod,
): Promise<CountryLeaderRow[]> {
  const db = await getDb();
  const blacklistIdNotIn = await buildBlacklistIdNotIn();
  const rows = await db.$queryRawUnsafe<
    {
      country: string;
      country_code: string | null;
      users: string;
      ggr: string;
    }[]
  >(`
    SELECT
      COALESCE(u.country, 'Unknown') AS country,
      u.country_code,
      COUNT(DISTINCT u.id)::text AS users,
      (
        COALESCE(SUM(CASE WHEN lt.type IN ${WAGER_TYPES} THEN ABS(lt.amount::numeric) ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN lt.type IN ${PAYOUT_TYPES} THEN ABS(lt.amount::numeric) ELSE 0 END), 0)
      )::text AS ggr
    FROM "user" u
    JOIN ledger_transactions lt ON lt.user_id = u.id
    WHERE u.role NOT IN ('admin', 'support') ${blacklistIdNotIn}
      AND lt.status = 'completed'
      ${periodFilter(period)}
    GROUP BY COALESCE(u.country, 'Unknown'), u.country_code
    ORDER BY (
        COALESCE(SUM(CASE WHEN lt.type IN ${WAGER_TYPES} THEN ABS(lt.amount::numeric) ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN lt.type IN ${PAYOUT_TYPES} THEN ABS(lt.amount::numeric) ELSE 0 END), 0)
    ) DESC
    LIMIT ${LIMIT}
  `);
  return rows.map((r) => ({
    country: r.country,
    countryCode: r.country_code,
    users: Number(r.users),
    ggr: toNumber(r.ggr),
  }));
}
