import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";
import { CUSTOMER_EXCLUDED_ROLES } from "@/lib/metrics/scope";
import {
  daysForInsightsPeriodCapped,
  cacheTtlForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "./_period";

// Canonical CUSTOMER scope roles as a raw-SQL list — staff (admin/support)
// PLUS creators, matching getMetricsScope()/CUSTOMER_EXCLUDED_ROLES. Creators
// are dropped WHOLESALE so the claimant + non-claimant cohorts line up with
// the per-category sub-pages instead of being inflated by creator rows.
// Blacklist is applied separately via blacklistNotInClause.
const CUSTOMER_EXCLUDED_ROLES_SQL = `(${CUSTOMER_EXCLUDED_ROLES.map(
  (r) => `'${r}'`,
).join(", ")})`;

/**
 * Retention lift per reward category — for every category, compare:
 *
 *   - claimants     : users with at least one reward of that category
 *                     in the window
 *   - non-claimants : users active in the window with NO reward of any
 *                     kind. Restricted to users who SIGNED UP before
 *                     the window started so we don't bias against the
 *                     fresh cohort. For lifetime windows this defaults
 *                     to every non-claimant ever.
 *
 * Retention buckets:
 *   - returned within 7 days of reference event
 *   - returned within 30 days of reference event
 *
 * Reference event for claimants = first in-window claim. Reference
 * event for non-claimants = a stable "activity anchor" — either their
 * first wager in the window OR their signup_at, whichever is later.
 *
 * "Returned" = at least one wager row (pack_opening / battle_bet /
 * battle_sponsorship / upgrader_bet) AFTER the reference timestamp +
 * 1 hour (so the reference event itself doesn't count) AND within the
 * 7d / 30d bucket window.
 *
 * Output is a list of category rows + a non-claimant baseline row, so
 * the UI renders a 4-column matrix: category | 7d retention |
 * 30d retention | lift % vs baseline.
 *
 * Staff + blacklist excluded. Read-only. Cached per (period × blacklist).
 *
 * PROPOSED (skipped this pass):
 *   - Per-claim lookback windows that vary per category — e.g. signup
 *     rewards probably want a longer baseline than rakeback (which
 *     fires continuously). Today every category uses the same 7d/30d
 *     buckets, which is the right default; per-category tuning would
 *     be a follow-up.
 */

const WAGER_TYPES_SQL = `(
  'pack_opening','battle_bet','battle_sponsorship','upgrader_bet'
)`;

// Same canonical reward list used elsewhere on this page. Vouchers
// omitted. `creator_tip` is EXCLUDED — it is a verified user→user
// pass-through (RESIDUAL, $0 net house cost; ledger-sets.ts), not a
// reward, so a creator_tip recipient must NOT count as a reward
// "claimant" in the non-claimant exclusion below. Matches the corrected
// cross-category-summary / category-spend-breakdown / roi on this page.
const ALL_REWARD_TYPES_SQL = `(
  'deposit_bonus','promo_code_redeemed','gift_card_redeemed',
  'rakeback_claim','affiliate_claim',
  'rain_win','race_prize','balance_reward_claim',
  'waitlist_prize'
)`;

const CATEGORIES: Array<{
  key:
    | "bonuses"
    | "rakeback"
    | "affiliate"
    | "rainRace"
    | "signupPack"
    | "waitlist";
  label: string;
  types: string[];
}> = [
  {
    key: "bonuses",
    label: "Bonuses & Promos",
    types: ["deposit_bonus", "promo_code_redeemed", "gift_card_redeemed"],
  },
  { key: "rakeback", label: "Rakeback", types: ["rakeback_claim"] },
  {
    key: "affiliate",
    label: "Affiliate Commissions",
    types: ["affiliate_claim"],
  },
  {
    key: "rainRace",
    label: "Rain / Race Prizes",
    types: ["rain_win", "race_prize"],
  },
  {
    key: "signupPack",
    label: "Signup / Balance Rewards",
    types: ["balance_reward_claim"],
  },
  // `creator_tip` is NOT a reward category — verified user→user
  // pass-through (RESIDUAL); dropping it matches the corrected sibling
  // files on this page.
  { key: "waitlist", label: "Waitlist Prizes", types: ["waitlist_prize"] },
];

function typeListSql(types: readonly string[]): string {
  return `(${types.map((t) => `'${t}'`).join(",")})`;
}

export type RetentionRow = {
  key:
    | "bonuses"
    | "rakeback"
    | "affiliate"
    | "rainRace"
    | "signupPack"
    | "waitlist"
    | "nonClaimant";
  label: string;
  cohortSize: number;
  retain7d: number;
  retain30d: number;
  share7d: number;
  share30d: number;
  /** Multiplicative lift vs non-claimant 7d share (1 = parity). `null` for the baseline row itself. */
  lift7d: number | null;
  /** Lift vs non-claimant 30d share. */
  lift30d: number | null;
};

export type RewardsRetentionLift = {
  rows: RetentionRow[];
  /** Baseline non-claimant row, surfaced separately for easier comparison plotting. */
  baseline: RetentionRow;
};

async function computeRetentionLift(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<RewardsRetentionLift> {
  const db = await getDb();
  // Lifetime (`all`) CAPPED to INSIGHTS_LIFETIME_LOOKBACK_DAYS (365d) via
  // daysForInsightsPeriodCapped so the claim-window, baseline-wager, and
  // non-claimant reward-exclusion sweeps over the full ledger_transactions
  // history never run unbounded — the correlated per-user EXISTS retention
  // probes over an unbounded cohort are the worst case (CLAUDE.md
  // "Performance & Daten-Laden"). Finite windows are unchanged; every window
  // clause below is now always present (capped never returns null).
  const days = daysForInsightsPeriodCapped(period);
  const blacklistJoin = blacklistNotInClause("u.id", blacklistIds);

  // Each category sweeps:
  //   - first in-window claim per user (cohort + anchor)
  //   - wager rows in the 7d / 30d buckets after anchor
  // Counts roll up into retention buckets — a user can be in both
  // 7d and 30d buckets simultaneously (30d is a superset of 7d).
  const sql = (typesSql: string) => {
    const claimWindowClause = `AND lt.created_at >= NOW() - INTERVAL '${days} days'`;
    return `
      WITH first_claim AS (
        SELECT lt.user_id, MIN(lt.created_at) AS anchor
        FROM ledger_transactions lt
        JOIN "user" u ON u.id = lt.user_id
        WHERE lt.status = 'completed'
          AND lt.type::text IN ${typesSql}
          AND u.role NOT IN ${CUSTOMER_EXCLUDED_ROLES_SQL} ${blacklistJoin}
          ${claimWindowClause}
        GROUP BY lt.user_id
      )
      SELECT
        COUNT(*)::text AS cohort,
        COUNT(DISTINCT CASE
          WHEN EXISTS (
            SELECT 1
            FROM ledger_transactions w
            WHERE w.user_id = fc.user_id
              AND w.status = 'completed'
              AND w.type::text IN ${WAGER_TYPES_SQL}
              AND w.created_at > fc.anchor + INTERVAL '1 hour'
              AND w.created_at <= fc.anchor + INTERVAL '7 days'
          ) THEN fc.user_id END)::text AS retain7d,
        COUNT(DISTINCT CASE
          WHEN EXISTS (
            SELECT 1
            FROM ledger_transactions w
            WHERE w.user_id = fc.user_id
              AND w.status = 'completed'
              AND w.type::text IN ${WAGER_TYPES_SQL}
              AND w.created_at > fc.anchor + INTERVAL '1 hour'
              AND w.created_at <= fc.anchor + INTERVAL '30 days'
          ) THEN fc.user_id END)::text AS retain30d
      FROM first_claim fc
    `;
  };

  // Non-claimant baseline — users who DID NOT claim ANY reward in the
  // window but were active (had a wager row) in the window. Anchor =
  // first wager in window. Retention buckets count returns AFTER that
  // anchor in the same 7d / 30d windows.
  const baselineWindowClause = `AND wager.created_at >= NOW() - INTERVAL '${days} days'`;
  const baselineSql = `
    WITH first_wager AS (
      SELECT wager.user_id, MIN(wager.created_at) AS anchor
      FROM ledger_transactions wager
      JOIN "user" u ON u.id = wager.user_id
      WHERE wager.status = 'completed'
        AND wager.type::text IN ${WAGER_TYPES_SQL}
        AND u.role NOT IN ${CUSTOMER_EXCLUDED_ROLES_SQL} ${blacklistJoin}
        ${baselineWindowClause}
      GROUP BY wager.user_id
    ),
    non_claimants AS (
      SELECT fw.user_id, fw.anchor
      FROM first_wager fw
      WHERE NOT EXISTS (
        SELECT 1
        FROM ledger_transactions r
        WHERE r.user_id = fw.user_id
          AND r.status = 'completed'
          AND r.type::text IN ${ALL_REWARD_TYPES_SQL}
          AND r.created_at >= NOW() - INTERVAL '${days} days'
      )
    )
    SELECT
      COUNT(*)::text AS cohort,
      COUNT(DISTINCT CASE
        WHEN EXISTS (
          SELECT 1
          FROM ledger_transactions w
          WHERE w.user_id = nc.user_id
            AND w.status = 'completed'
            AND w.type::text IN ${WAGER_TYPES_SQL}
            AND w.created_at > nc.anchor + INTERVAL '1 hour'
            AND w.created_at <= nc.anchor + INTERVAL '7 days'
        ) THEN nc.user_id END)::text AS retain7d,
      COUNT(DISTINCT CASE
        WHEN EXISTS (
          SELECT 1
          FROM ledger_transactions w
          WHERE w.user_id = nc.user_id
            AND w.status = 'completed'
            AND w.type::text IN ${WAGER_TYPES_SQL}
            AND w.created_at > nc.anchor + INTERVAL '1 hour'
            AND w.created_at <= nc.anchor + INTERVAL '30 days'
        ) THEN nc.user_id END)::text AS retain30d
    FROM non_claimants nc
  `;

  const [baselineRows, ...categoryRows] = await Promise.all([
    db.$queryRawUnsafe<
      { cohort: string; retain7d: string; retain30d: string }[]
    >(baselineSql),
    ...CATEGORIES.map((cat) =>
      db.$queryRawUnsafe<
        { cohort: string; retain7d: string; retain30d: string }[]
      >(sql(typeListSql(cat.types))),
    ),
  ]);

  const parse = (
    r: { cohort: string; retain7d: string; retain30d: string } | undefined,
  ) => ({
    cohort: Number(r?.cohort ?? 0),
    retain7d: Number(r?.retain7d ?? 0),
    retain30d: Number(r?.retain30d ?? 0),
  });

  const baselineRaw = parse(baselineRows[0]);
  const baselineShare7d =
    baselineRaw.cohort > 0 ? baselineRaw.retain7d / baselineRaw.cohort : 0;
  const baselineShare30d =
    baselineRaw.cohort > 0 ? baselineRaw.retain30d / baselineRaw.cohort : 0;

  const baseline: RetentionRow = {
    key: "nonClaimant",
    label: "Non-claimant baseline",
    cohortSize: baselineRaw.cohort,
    retain7d: baselineRaw.retain7d,
    retain30d: baselineRaw.retain30d,
    share7d: baselineShare7d,
    share30d: baselineShare30d,
    lift7d: null,
    lift30d: null,
  };

  const rows: RetentionRow[] = CATEGORIES.map((cat, idx) => {
    const raw = parse(categoryRows[idx]?.[0]);
    const share7d = raw.cohort > 0 ? raw.retain7d / raw.cohort : 0;
    const share30d = raw.cohort > 0 ? raw.retain30d / raw.cohort : 0;
    return {
      key: cat.key,
      label: cat.label,
      cohortSize: raw.cohort,
      retain7d: raw.retain7d,
      retain30d: raw.retain30d,
      share7d,
      share30d,
      lift7d:
        baselineShare7d > 0 ? share7d / baselineShare7d - 1 : null,
      lift30d:
        baselineShare30d > 0 ? share30d / baselineShare30d - 1 : null,
    };
  }).sort((a, b) => b.share30d - a.share30d);

  return { rows, baseline };
}

const cachedRetentionLift = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeRetentionLift(period, blacklistIds),
  ["insights-rewards-retention-lift-v1"],
  { revalidate: 60, tags: ["rewards-analytics", "insights-rewards"] },
);

const cachedRetentionLiftLifetime = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeRetentionLift(period, blacklistIds),
  ["insights-rewards-retention-lift-lifetime-v1"],
  { revalidate: 300, tags: ["rewards-analytics", "insights-rewards"] },
);

export async function getRewardsRetentionLift(
  period: InsightsRewardsPeriod,
): Promise<RewardsRetentionLift> {
  const blacklist = await getExcludedUserIds();
  const sorted = [...blacklist].sort();
  const ttl = cacheTtlForInsightsPeriod(period);
  return ttl >= 300
    ? cachedRetentionLiftLifetime(period, sorted)
    : cachedRetentionLift(period, sorted);
}
