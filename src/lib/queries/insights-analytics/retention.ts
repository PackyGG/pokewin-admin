import "server-only";

import { getDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";

/**
 * Retention curves with optional breakdown.
 *
 * Single aggregated curve OR multiple per breakdown bucket:
 *   • source — referred_by IS NULL / has-affiliate-code-with-creator
 *               / has-affiliate-code-non-creator
 *   • country — top 5 countries by cohort size, "Other" bucket for the rest
 *   • none    — single aggregated curve (default)
 *
 * Cohort = users that signed up in the last 180 days. For each day-of-
 * signup-offset N up to 90, the curve reports what fraction of users
 * old enough (`signup_at <= now − N days`) wagered on day N.
 *
 * Staff (admin / support) + manual blacklist excluded.
 */

const WAGER_TYPES = `('pack_opening','battle_bet','battle_sponsorship','upgrader_bet')`;
const COHORT_WINDOW_DAYS = 180;
const CURVE_LENGTH = 91;

export type RetentionBreakdownKey = "none" | "source" | "country";

export function parseRetentionBreakdown(value: string | undefined): RetentionBreakdownKey {
  return value === "source" || value === "country" ? value : "none";
}

export type RetentionSeries = {
  key: string;
  label: string;
  cohort: number;
  d1: number;
  d7: number;
  d30: number;
  d90: number;
  curve: { day: number; pct: number; cohort: number; retained: number }[];
};

export type RetentionResult = {
  breakdownBy: RetentionBreakdownKey;
  series: RetentionSeries[];
};

export async function getInsightsRetention(
  breakdownBy: RetentionBreakdownKey,
): Promise<RetentionResult> {
  const db = await getDb();
  const excluded = await getExcludedUserIds();
  const blacklistIdNotIn = blacklistNotInClause("id", excluded);

  // Group expression. The expressions are inlined verbatim (whitelisted
  // strings; no user input) so the GROUP BY can take a free-form SQL
  // bucket directly.
  const groupExpr = (() => {
    switch (breakdownBy) {
      case "none":
        return `'all'::text`;
      case "source":
        // 3 buckets — organic, creator-affiliate, regular-affiliate. The
        // EXISTS subquery checks whether the referrer is a creator role.
        return `
          CASE
            WHEN referred_by IS NULL THEN 'organic'
            WHEN EXISTS (SELECT 1 FROM "user" ref WHERE ref.id = "user".referred_by AND ref.role = 'creator')
              THEN 'creator-affiliate'
            ELSE 'regular-affiliate'
          END
        `;
      case "country":
        return `COALESCE(country, 'Unknown')`;
    }
  })();

  const rows = await db.$queryRawUnsafe<
    {
      bucket: string;
      day: number;
      retained: string;
      eligible: string;
    }[]
  >(`
    WITH eligible AS (
      SELECT id AS user_id, created_at, (${groupExpr}) AS bucket
      FROM "user"
      WHERE role NOT IN ('admin', 'support') ${blacklistIdNotIn}
        AND created_at >= NOW() - INTERVAL '${COHORT_WINDOW_DAYS} days'
    ),
    days AS (
      SELECT generate_series(0, ${CURVE_LENGTH - 1}) AS day
    ),
    activity AS (
      SELECT DISTINCT
        e.user_id,
        e.bucket,
        FLOOR(EXTRACT(EPOCH FROM (lt.created_at - e.created_at)) / 86400)::int AS day
      FROM eligible e
      JOIN ledger_transactions lt ON lt.user_id = e.user_id
      WHERE lt.status = 'completed'
        AND lt.type IN ${WAGER_TYPES}
        AND lt.created_at >= e.created_at
        AND lt.created_at <= e.created_at + INTERVAL '${CURVE_LENGTH} days'
    )
    SELECT
      e.bucket,
      d.day,
      COALESCE(COUNT(DISTINCT a.user_id), 0)::text AS retained,
      COUNT(DISTINCT e.user_id)::text AS eligible
    FROM days d
    LEFT JOIN eligible e ON e.created_at <= NOW() - make_interval(days => d.day)
    LEFT JOIN activity a ON a.user_id = e.user_id AND a.day = d.day AND a.bucket = e.bucket
    GROUP BY e.bucket, d.day
    ORDER BY e.bucket, d.day
  `);

  const byBucket = new Map<
    string,
    { day: number; retained: number; eligible: number }[]
  >();

  for (const row of rows) {
    const bucket = row.bucket ?? "all";
    let list = byBucket.get(bucket);
    if (!list) {
      list = [];
      byBucket.set(bucket, list);
    }
    list.push({
      day: Number(row.day),
      retained: Number(row.retained ?? 0),
      eligible: Number(row.eligible ?? 0),
    });
  }

  const series: RetentionSeries[] = Array.from(byBucket.entries())
    .map(([bucket, list]) => {
      const sorted = [...list].sort((a, b) => a.day - b.day);
      const curve = sorted.map((p) => ({
        day: p.day,
        pct: p.eligible > 0 ? p.retained / p.eligible : 0,
        cohort: p.eligible,
        retained: p.retained,
      }));
      const at = (day: number) => curve.find((c) => c.day === day) ?? null;
      const d1 = at(1);
      const d7 = at(7);
      const d30 = at(30);
      const d90 = at(90);
      const day0 = at(0);
      return {
        key: bucket,
        label: bucket,
        cohort: day0?.cohort ?? d1?.cohort ?? 0,
        d1: d1?.pct ?? 0,
        d7: d7?.pct ?? 0,
        d30: d30?.pct ?? 0,
        d90: d90?.pct ?? 0,
        curve,
      };
    })
    .filter((s) => s.cohort > 0);

  // Country breakdown — cap to top 5 + Other, otherwise the chart
  // explodes with a long tail of single-user countries.
  if (breakdownBy === "country" && series.length > 5) {
    const sortedByCohort = [...series].sort((a, b) => b.cohort - a.cohort);
    const top = sortedByCohort.slice(0, 5);
    const tail = sortedByCohort.slice(5);

    // Fold tail into a synthetic "Other" series by recomputing per-day
    // retained / eligible totals.
    if (tail.length > 0) {
      const dayMap = new Map<number, { retained: number; eligible: number }>();
      for (const s of tail) {
        for (const p of s.curve) {
          const e = dayMap.get(p.day) ?? { retained: 0, eligible: 0 };
          e.retained += p.retained;
          e.eligible += p.cohort;
          dayMap.set(p.day, e);
        }
      }
      const curve = Array.from(dayMap.entries())
        .map(([day, e]) => ({
          day,
          pct: e.eligible > 0 ? e.retained / e.eligible : 0,
          cohort: e.eligible,
          retained: e.retained,
        }))
        .sort((a, b) => a.day - b.day);
      const at = (day: number) => curve.find((c) => c.day === day) ?? null;
      const day0 = at(0);
      const d1 = at(1);
      top.push({
        key: "Other",
        label: "Other",
        cohort: day0?.cohort ?? d1?.cohort ?? 0,
        d1: at(1)?.pct ?? 0,
        d7: at(7)?.pct ?? 0,
        d30: at(30)?.pct ?? 0,
        d90: at(90)?.pct ?? 0,
        curve,
      });
    }
    return { breakdownBy, series: top };
  }

  return { breakdownBy, series };
}
