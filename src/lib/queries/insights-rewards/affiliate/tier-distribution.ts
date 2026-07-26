import { blacklistNotInSql, queryRows, sql } from "@/lib/queries/insights-rewards/_drizzle-query";
import { unstable_cache } from "next/cache";
import { getDrizzleDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { CACHE_TAG, loadBlacklist } from "./_shared";

/**
 * Tier (affiliate level) distribution.
 *
 * HOW A TIER IS DETERMINED — read this before changing anything:
 *
 * There is NO stored per-affiliate level column. `affiliate_accounts`
 * in the checked-in MAIN Drizzle schema carries `total_wager_volume_usd`,
 * `total_earned_usd`, `total_paid_out_usd`, `total_referred` — but no
 * `level`. The admin "set level" action
 * (src/app/(admin)/creators/actions.ts:205) is a documented no-op for
 * the level itself: it only bumps `updated_at` with the inline comment
 * `// affiliate_level column doesn't exist in prod`, and the creators
 * list hardcodes `level: 1` (src/lib/queries/creators-list.ts:216).
 * So there is no stored level and no working manual override to honour.
 *
 * The tier ladder lives in `affiliate_level_configs` (8 rows: level,
 * label, commission_rate, threshold). A tier is therefore COMPUTED:
 * the affiliate's cumulative referred wager vs the threshold ladder —
 * their level is the highest configured threshold their wager crosses.
 *
 * Wager source = `affiliate_accounts.total_wager_volume_usd`, the
 * platform-maintained lifetime cohort-wager counter. This is the same
 * field `lifetime-roi.ts` treats as the affiliate's "lifetime
 * downstream wager", so the two lifetime affiliate lenses reconcile.
 *
 * The whole bucketing runs in one SQL pass: each affiliate row is
 * mapped to the highest config level whose threshold it meets via a
 * LATERAL pick over `affiliate_level_configs`, then grouped per level.
 * The config table is the source of metadata (label / commission_rate /
 * threshold) so the view stays correct if an admin retunes the ladder
 * on /creators/settings.
 *
 * "Real affiliate" = an `affiliate_accounts` row joined to a non-staff
 * `user`, blacklist-excluded — identical to `lifetime-roi.ts` /
 * `inactive.ts` so the affiliate population matches the rest of the
 * page. (Every affiliate_accounts row already has a code provisioned;
 * the table is created when an affiliate code is granted.)
 *
 * House-POV: commission is house cost → rendered rose in the UI; the
 * affiliate COUNT per tier is a neutral population metric → blue.
 *
 * Read-only against Main DB. Period-agnostic (lifetime), like the
 * Lifetime ROI lens — tiers are a lifetime-cumulative concept.
 */

export type TierDistributionRow = {
  level: number;
  label: string;
  /** Commission rate as a fraction (e.g. 0.05 = 5%). */
  commissionRate: number;
  /** Cumulative referred-wager threshold to reach this level (USD). */
  threshold: number;
  /** Number of real affiliates currently sitting at this level. */
  affiliateCount: number;
  /** affiliateCount / total affiliates, as a percentage (0–100). */
  sharePct: number;
  /** Sum of `total_wager_volume_usd` for affiliates at this level. */
  totalReferredWager: number;
  /** Sum of `total_paid_out_usd` (settled commission) at this level. */
  totalCommissionPaid: number;
};

export type TierDistribution = {
  /** One row per configured level (1–8), ascending. */
  rows: TierDistributionRow[];
  /** Total real affiliates counted across all levels. */
  totalAffiliates: number;
};

async function compute(blacklistIds: string[]): Promise<TierDistribution> {
  const db = await getDrizzleDb();
  const blacklistJoin = blacklistNotInSql("u.id", blacklistIds);

  // One pass: every real affiliate row picks its level via a LATERAL
  // over the config ladder (highest threshold the wager meets, min
  // level 1), then we LEFT JOIN the full config so every configured
  // level appears even with zero affiliates. Aggregates are summed per
  // level. `affiliate_level_configs` is the metadata source so the view
  // tracks any retuned ladder.
  const rows = await queryRows<
    {
      level: number;
      label: string;
      commission_rate: string;
      threshold: string;
      affiliate_count: string;
      total_wager: string;
      total_paid_out: string;
    }[]
  >(db, sql`
    WITH affiliate_levels AS (
      SELECT
        aa.user_id,
        aa.total_wager_volume_usd AS wager,
        aa.total_paid_out_usd AS paid_out,
        lvl.level AS level
      FROM affiliate_accounts aa
      JOIN "user" u ON u.id = aa.user_id
      CROSS JOIN LATERAL (
        SELECT c.level
        FROM affiliate_level_configs c
        WHERE c.threshold <= aa.total_wager_volume_usd
        ORDER BY c.threshold DESC, c.level DESC
        LIMIT 1
      ) lvl
      WHERE u.role NOT IN ('admin', 'support') ${blacklistJoin}
    )
    SELECT
      cfg.level AS level,
      cfg.label AS label,
      cfg.commission_rate::text AS commission_rate,
      cfg.threshold::text AS threshold,
      COUNT(al.user_id)::text AS affiliate_count,
      COALESCE(SUM(al.wager::numeric), 0)::text AS total_wager,
      COALESCE(SUM(al.paid_out::numeric), 0)::text AS total_paid_out
    FROM affiliate_level_configs cfg
    LEFT JOIN affiliate_levels al ON al.level = cfg.level
    GROUP BY cfg.level, cfg.label, cfg.commission_rate, cfg.threshold
    ORDER BY cfg.level ASC
  `);

  const counts = rows.map((r) => Number(r.affiliate_count));
  const totalAffiliates = counts.reduce((a, c) => a + c, 0);

  const out: TierDistributionRow[] = rows.map((r) => {
    const affiliateCount = Number(r.affiliate_count);
    return {
      level: r.level,
      label: r.label,
      commissionRate: toNumber(r.commission_rate),
      threshold: toNumber(r.threshold),
      affiliateCount,
      sharePct:
        totalAffiliates > 0 ? (affiliateCount / totalAffiliates) * 100 : 0,
      totalReferredWager: toNumber(r.total_wager),
      totalCommissionPaid: toNumber(r.total_paid_out),
    };
  });

  return { rows: out, totalAffiliates };
}

// Tier distribution is lifetime-cumulative and slow-changing → cache 5
// min, same as the Lifetime ROI lens.
const cached = unstable_cache(
  async (blacklistIds: string[]) => compute(blacklistIds),
  ["insights-affiliate-tier-distribution-v1"],
  { revalidate: 300, tags: [CACHE_TAG, "rewards-analytics"] },
);

export async function getAffiliateTierDistribution(): Promise<TierDistribution> {
  const blacklist = await loadBlacklist();
  return cached(blacklist);
}
