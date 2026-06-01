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
 * balance rewards, waitlist prizes). All of these are house COSTS, so
 * per CLAUDE.md House-POV they render ROSE everywhere.
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
 *
 * Deliberately EXCLUDED: every voucher-related ledger type
 * (voucher_redeemed, voucher_exchange, exchange_excess_to_voucher,
 * battle_excess_to_voucher, exchange_excess_credit, card_sale,
 * card_exchange). Vouchers are tracked in their own dedicated views and
 * do not belong in the rewards-cost lens.
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

/**
 * Parse a free-string period from a client component / server action
 * payload into the canonical `RewardsPeriod` union. Falls back to the
 * page default (`30d`) so an unknown / tampered value never crashes the
 * action. Mirror of the parser inside the analytics page.
 */
export function parseRewardsPeriod(value: string | undefined): RewardsPeriod {
  switch (value) {
    case "today":
    case "7d":
    case "30d":
    case "all":
      return value;
    default:
      return "30d";
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
  | "waitlist";

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
};

// All reward ledger types as a single inlined SQL list — used for the
// per-user / per-day totals and the recipient leaderboard. Hardcoded
// enum values only (no user input), so safe to inline.
//
// Vouchers are deliberately omitted from this list — they live under a
// dedicated voucher view and don't belong to the rewards-cost lens.
const REWARD_TYPES_SQL = `(
  'deposit_bonus','promo_code_redeemed','gift_card_redeemed',
  'rakeback_claim','affiliate_claim',
  'rain_win','race_prize','balance_reward_claim','creator_tip',
  'waitlist_prize'
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
        bonuses_n: string;
        rakeback_n: string;
        affiliate_n: string;
        rain_race_n: string;
        signup_pack_n: string;
        creator_tip_n: string;
        waitlist_n: string;
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
        COUNT(*) FILTER (WHERE lt.type IN ('deposit_bonus','promo_code_redeemed','gift_card_redeemed'))::text AS bonuses_n,
        COUNT(*) FILTER (WHERE lt.type = 'rakeback_claim')::text AS rakeback_n,
        COUNT(*) FILTER (WHERE lt.type = 'affiliate_claim')::text AS affiliate_n,
        COUNT(*) FILTER (WHERE lt.type IN ('rain_win','race_prize'))::text AS rain_race_n,
        COUNT(*) FILTER (WHERE lt.type = 'balance_reward_claim')::text AS signup_pack_n,
        COUNT(*) FILTER (WHERE lt.type = 'creator_tip')::text AS creator_tip_n,
        COUNT(*) FILTER (WHERE lt.type = 'waitlist_prize')::text AS waitlist_n
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
    return {
      date: new Date(r.date).toISOString().split("T")[0],
      bonuses,
      rakeback,
      affiliate,
      rainRace,
      signupPack,
      creatorTip,
      waitlist,
      total:
        bonuses +
        rakeback +
        affiliate +
        rainRace +
        signupPack +
        creatorTip +
        waitlist,
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

// ============================================================
// Drilldown helpers — make every rollup on /rewards/analytics
// auditable by surfacing the per-ledger-type breakdown + the
// top recipient list for any category on click. Mirrors the
// GGR breakdown popover pattern shipped on /dashboard.
// ============================================================

/**
 * Per-category mapping from the stable UI category key to the exact
 * ledger types it sums. Single source of truth — used by the breakdown
 * helper, the top-recipients helper, the top-promo-codes helper, and
 * any new drilldown surface. Adding a new ledger type to a category
 * here automatically propagates to every drilldown.
 *
 * Categories with a single underlying type (`rakeback`, `affiliate`,
 * `signupPack`, `creatorTip`, `waitlist`) still go through this map so
 * the breakdown popover renders one row consistently and admins see
 * the ledger-type name regardless of how many types the category has.
 */
const CATEGORY_TO_TYPES: Record<RewardCategoryKey, readonly string[]> = {
  bonuses: ["deposit_bonus", "promo_code_redeemed", "gift_card_redeemed"],
  rakeback: ["rakeback_claim"],
  affiliate: ["affiliate_claim"],
  rainRace: ["rain_win", "race_prize"],
  signupPack: ["balance_reward_claim"],
  creatorTip: ["creator_tip"],
  waitlist: ["waitlist_prize"],
};

/** All reward ledger types, flat — used by the "total" drilldown. */
const ALL_REWARD_TYPES: readonly string[] = Object.values(
  CATEGORY_TO_TYPES,
).flat();

/**
 * Inline-quote a list of hardcoded ledger type strings into a SQL `IN
 * (...)` fragment. Inputs are NEVER user-supplied — they come from the
 * `CATEGORY_TO_TYPES` map above, which is a literal constant — so this
 * is a simple `.map(...).join(",")` with no escaping beyond surrounding
 * each value with single quotes.
 */
function typeListSql(types: readonly string[]): string {
  return `(${types.map((t) => `'${t}'`).join(",")})`;
}

export type RewardBreakdownRow = {
  /** Raw ledger type string (e.g. "deposit_bonus"). */
  type: string;
  /** Human-readable label sourced from `LEDGER_TYPE_LABELS`. */
  label: string;
  /** Sum of ABS(amount) for the period. Always non-negative. */
  total: number;
  /** Row count for this type in the period. */
  count: number;
};

export type RewardCategoryBreakdown = {
  category: RewardCategoryKey;
  /** Per ledger-type rows, sorted DESC by total. */
  rows: RewardBreakdownRow[];
  /** Sum of all rows — equals the headline category total. */
  total: number;
  /** Sum of all row counts. */
  count: number;
};

/**
 * Per-ledger-type rows that sum to a single category's total. Drives
 * the breakdown popover anchored on each reward KPI tile.
 *
 * Single GROUP BY type sweep with the same `status = 'completed'` +
 * staff/blacklist filter the headline query uses, so the popover's
 * row totals equal the headline tile total by construction (same SQL
 * filter, same window, same exclusion).
 *
 * Period-aware. Cheap — one round-trip, bounded by the number of
 * ledger types in the category (1–3 today).
 */
export async function getRewardCategoryBreakdown(
  period: RewardsPeriod,
  category: RewardCategoryKey,
): Promise<RewardCategoryBreakdown> {
  const db = await getDb();
  const days = daysForPeriod(period);
  const dateFilter =
    days !== null ? `AND lt.created_at >= NOW() - INTERVAL '${days} days'` : "";
  const excluded = await getExcludedUserIds();
  const blacklistSubquery = blacklistNotInClause("id", excluded);
  const typesSql = typeListSql(CATEGORY_TO_TYPES[category]);

  const rows = await db.$queryRawUnsafe<
    { type: string; total: string; cnt: string }[]
  >(`
    SELECT
      lt.type::text AS type,
      COALESCE(SUM(ABS(lt.amount::numeric)), 0)::text AS total,
      COUNT(*)::text AS cnt
    FROM ledger_transactions lt
    WHERE lt.status = 'completed'
      AND lt.type IN ${typesSql}
      AND lt.user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin', 'support') ${blacklistSubquery})
      ${dateFilter}
    GROUP BY lt.type
    ORDER BY SUM(ABS(lt.amount::numeric)) DESC
  `);

  const breakdownRows: RewardBreakdownRow[] = rows.map((r) => ({
    type: r.type,
    label: LEDGER_TYPE_LABELS[r.type] ?? r.type,
    total: toNumber(r.total),
    count: Number(r.cnt),
  }));
  const total = breakdownRows.reduce((a, r) => a + r.total, 0);
  const count = breakdownRows.reduce((a, r) => a + r.count, 0);
  return { category, rows: breakdownRows, total, count };
}

/** Friendly labels for the ledger types that show up in drilldown rows. */
const LEDGER_TYPE_LABELS: Record<string, string> = {
  deposit_bonus: "Deposit bonus",
  promo_code_redeemed: "Promo code",
  gift_card_redeemed: "Gift card",
  rakeback_claim: "Rakeback claim",
  affiliate_claim: "Affiliate claim",
  rain_win: "Rain win",
  race_prize: "Race prize",
  balance_reward_claim: "Balance reward claim",
  creator_tip: "Creator tip",
  waitlist_prize: "Waitlist prize",
};

export type RewardTopRecipientRow = {
  userId: string;
  username: string | null;
  /** Reward total this user received in the category + period. */
  total: number;
  /** Number of reward ledger rows for this user. */
  count: number;
};

/**
 * Top-N reward recipients inside a single category (or `null` for the
 * site-wide "all rewards" rollup). Drives the lazy expander inside the
 * breakdown popover.
 *
 * GROUP BY user_id over the same filter shape the headline aggregate
 * uses — same window, same status, same staff/blacklist exclusion —
 * so the row totals reconcile to the headline tile by construction.
 * Sorted by total DESC; rows are clamped to `limit` (1–50, defensive).
 *
 * NOT cached: this is heavier than the per-type sweep and only fires
 * on user click (server action), so caching just adds memory pressure
 * for no win.
 */
export async function getRewardCategoryTopRecipients(
  period: RewardsPeriod,
  category: RewardCategoryKey | null,
  limit = 10,
): Promise<RewardTopRecipientRow[]> {
  const safeLimit = Math.max(1, Math.min(limit, 50));
  const db = await getDb();
  const days = daysForPeriod(period);
  const dateFilter =
    days !== null ? `AND lt.created_at >= NOW() - INTERVAL '${days} days'` : "";
  const excluded = await getExcludedUserIds();
  const blacklistJoin = blacklistNotInClause("u.id", excluded);
  const types =
    category === null ? ALL_REWARD_TYPES : CATEGORY_TO_TYPES[category];
  const typesSql = typeListSql(types);

  const rows = await db.$queryRawUnsafe<
    {
      user_id: string;
      username: string | null;
      total: string;
      cnt: string;
    }[]
  >(`
    SELECT
      u.id AS user_id,
      u.username,
      SUM(ABS(lt.amount::numeric))::text AS total,
      COUNT(*)::text AS cnt
    FROM ledger_transactions lt
    JOIN "user" u ON u.id = lt.user_id
    WHERE lt.status = 'completed'
      AND lt.type IN ${typesSql}
      AND u.role NOT IN ('admin', 'support') ${blacklistJoin}
      ${dateFilter}
    GROUP BY u.id, u.username
    ORDER BY SUM(ABS(lt.amount::numeric)) DESC
    LIMIT ${safeLimit}
  `);

  return rows.map((r) => ({
    userId: r.user_id,
    username: r.username,
    total: toNumber(r.total),
    count: Number(r.cnt),
  }));
}

export type RewardTopPromoCodeRow = {
  /** Promo code id — links to /promo-codes/<id>. */
  codeId: string;
  /** Human-readable code text from `promo_codes.metadata.code`, or null when missing. */
  code: string | null;
  /** Total USD redeemed for this code in the period. */
  total: number;
  /** Number of redemptions in the period. */
  redemptions: number;
};

/**
 * Top promo codes by total redeemed value in the selected period.
 * Drives the per-code expander inside the Bonuses & Promos popover so
 * admins can see WHICH codes drove the $17k they're looking at — not
 * just the per-type rollup.
 *
 * Joins `promo_code_redemptions` → `ledger_transactions` →
 * `promo_codes`. The redemption row is the canonical source of truth
 * for "which code did this redemption belong to"; the linked ledger
 * tx supplies the credited amount (`ABS(amount)`); the promo_codes
 * row supplies the displayable code text (stored under
 * `metadata.code` since `code_hash` is one-way hashed).
 *
 * Staff + blacklist excluded via the same `user_id IN (...)` subquery
 * shape the rest of the file uses. Defensive limit clamp 1–50.
 *
 * NOT cached — same reasoning as the recipients helper (lazy + heavy).
 */
export async function getRewardsTopPromoCodes(
  period: RewardsPeriod,
  limit = 10,
): Promise<RewardTopPromoCodeRow[]> {
  const safeLimit = Math.max(1, Math.min(limit, 50));
  const db = await getDb();
  const days = daysForPeriod(period);
  const dateFilter =
    days !== null ? `AND lt.created_at >= NOW() - INTERVAL '${days} days'` : "";
  const excluded = await getExcludedUserIds();
  const blacklistSubquery = blacklistNotInClause("id", excluded);

  const rows = await db.$queryRawUnsafe<
    {
      code_id: string;
      code: string | null;
      total: string;
      redemptions: string;
    }[]
  >(`
    SELECT
      pc.id::text AS code_id,
      pc.metadata->>'code' AS code,
      SUM(ABS(lt.amount::numeric))::text AS total,
      COUNT(*)::text AS redemptions
    FROM promo_code_redemptions pcr
    JOIN ledger_transactions lt ON lt.id = pcr.ledger_tx_id
    JOIN promo_codes pc ON pc.id = pcr.promo_code_id
    WHERE lt.status = 'completed'
      AND lt.type = 'promo_code_redeemed'
      AND lt.user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin', 'support') ${blacklistSubquery})
      ${dateFilter}
    GROUP BY pc.id, pc.metadata->>'code'
    ORDER BY SUM(ABS(lt.amount::numeric)) DESC
    LIMIT ${safeLimit}
  `);

  return rows.map((r) => ({
    codeId: r.code_id,
    code: r.code,
    total: toNumber(r.total),
    redemptions: Number(r.redemptions),
  }));
}
