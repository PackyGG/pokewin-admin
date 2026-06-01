import "server-only";

import { getDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";
import { periodToDays, type InsightsPeriod } from "@/app/(admin)/insights/analytics/types";

/**
 * Acquisition funnel: clicks → signups → first deposit → first wager →
 * repeat depositor → monthly active wagerer.
 *
 * Optionally broken down by signup source or country so admins can see
 * the funnel shape per acquisition channel.
 *
 * Staff (admin / support) + manual blacklist are excluded everywhere.
 */

export type FunnelBreakdownKey = "none" | "source" | "country";

export function parseFunnelBreakdown(value: string | undefined): FunnelBreakdownKey {
  return value === "source" || value === "country" ? value : "none";
}

export type FunnelStep = {
  key: string;
  label: string;
  description: string;
  count: number;
  dropoffFromPrev: number | null;
  conversionFromTop: number;
};

export type FunnelBucket = {
  key: string;
  label: string;
  steps: FunnelStep[];
};

export type FunnelData = {
  period: InsightsPeriod;
  breakdownBy: FunnelBreakdownKey;
  buckets: FunnelBucket[];
};

const MAW_CUTOFF_DAYS = 30;

export async function getInsightsFunnel(
  period: InsightsPeriod,
  breakdownBy: FunnelBreakdownKey,
): Promise<FunnelData> {
  const db = await getDb();
  const days = periodToDays(period);
  const dateFilter = days !== null ? `AND created_at >= NOW() - INTERVAL '${days} days'` : "";
  const usersDateFilter =
    days !== null ? `AND u.created_at >= NOW() - INTERVAL '${days} days'` : "";
  const excluded = await getExcludedUserIds();
  const blacklistIdNotIn = blacklistNotInClause("u.id", excluded);

  // GroupExpr for the breakdown. Hardcoded strings (no user input) so
  // direct interpolation is safe.
  const groupExpr = (() => {
    switch (breakdownBy) {
      case "none":
        return `'all'::text`;
      case "source":
        return `
          CASE
            WHEN u.referred_by IS NULL THEN 'organic'
            WHEN EXISTS (SELECT 1 FROM "user" ref WHERE ref.id = u.referred_by AND ref.role = 'creator')
              THEN 'creator-affiliate'
            ELSE 'regular-affiliate'
          END
        `;
      case "country":
        return `COALESCE(u.country, 'Unknown')`;
    }
  })();

  // 2 raws: clicks per-bucket (only the affiliate-clicks table for "all"
  // — country isn't recorded per-click in the way the user table is,
  // and source by definition only applies post-signup) and the cohort
  // walk per bucket.
  const cohortRows = await db.$queryRawUnsafe<
    {
      bucket: string;
      signups: string;
      first_deposit: string;
      first_wager: string;
      repeat_deposit: string;
      maw: string;
    }[]
  >(`
    WITH cohort AS (
      SELECT u.id, (${groupExpr}) AS bucket
      FROM "user" u
      WHERE u.role NOT IN ('admin', 'support') ${blacklistIdNotIn}
        ${usersDateFilter}
    ),
    activity AS (
      SELECT
        c.id AS user_id,
        c.bucket,
        COUNT(*) FILTER (WHERE lt.type = 'deposit' AND lt.status = 'completed') AS deposit_count,
        COUNT(*) FILTER (WHERE lt.type IN ('pack_opening','battle_bet','battle_sponsorship','upgrader_bet')
          AND lt.status = 'completed') AS wager_count,
        COUNT(*) FILTER (WHERE lt.type IN ('pack_opening','battle_bet','battle_sponsorship','upgrader_bet')
          AND lt.status = 'completed'
          AND lt.created_at >= NOW() - INTERVAL '${MAW_CUTOFF_DAYS} days') AS wager_count_30d,
        BOOL_OR(b.total_deposited::numeric > 0) AS has_deposit_balance
      FROM cohort c
      LEFT JOIN ledger_transactions lt ON lt.user_id = c.id
      LEFT JOIN balances b ON b.user_id = c.id
      GROUP BY c.id, c.bucket
    )
    SELECT
      bucket,
      COUNT(*)::text AS signups,
      COUNT(*) FILTER (WHERE has_deposit_balance)::text AS first_deposit,
      COUNT(*) FILTER (WHERE wager_count > 0)::text AS first_wager,
      COUNT(*) FILTER (WHERE deposit_count >= 2)::text AS repeat_deposit,
      COUNT(*) FILTER (WHERE wager_count_30d > 0)::text AS maw
    FROM activity
    GROUP BY bucket
    ORDER BY signups DESC
  `);

  // Clicks: only meaningful when no breakdown (affiliate_clicks has no
  // source/country we can directly join to the per-user funnel here).
  const clicksRows =
    breakdownBy === "none"
      ? await db.$queryRawUnsafe<{ count: string }[]>(`
          SELECT COUNT(*)::text AS count
          FROM affiliate_clicks
          WHERE 1=1 ${dateFilter}
        `)
      : [];
  const totalClicks =
    breakdownBy === "none" ? Number(clicksRows[0]?.count ?? 0) : 0;

  // Country breakdown: cap to top 5 + Other for legibility. Source has
  // 3 buckets so no capping is needed.
  let raw = cohortRows.map((r) => ({
    bucket: r.bucket ?? "all",
    signups: Number(r.signups),
    firstDeposit: Number(r.first_deposit),
    firstWager: Number(r.first_wager),
    repeatDeposit: Number(r.repeat_deposit),
    maw: Number(r.maw),
  }));

  if (breakdownBy === "country" && raw.length > 5) {
    const sorted = [...raw].sort((a, b) => b.signups - a.signups);
    const top = sorted.slice(0, 5);
    const tail = sorted.slice(5);
    const folded = tail.reduce(
      (acc, r) => ({
        bucket: "Other",
        signups: acc.signups + r.signups,
        firstDeposit: acc.firstDeposit + r.firstDeposit,
        firstWager: acc.firstWager + r.firstWager,
        repeatDeposit: acc.repeatDeposit + r.repeatDeposit,
        maw: acc.maw + r.maw,
      }),
      { bucket: "Other", signups: 0, firstDeposit: 0, firstWager: 0, repeatDeposit: 0, maw: 0 },
    );
    raw = [...top, folded];
  }

  const buckets: FunnelBucket[] = raw.map((r) => {
    // Clicks only attach to the "all" bucket since we can't slice the
    // affiliate_clicks table by post-signup user attributes. The per-
    // bucket funnel therefore starts at signups when broken down.
    const includeClicks = r.bucket === "all" && breakdownBy === "none";
    const stepsRaw = [
      includeClicks
        ? {
            key: "clicks",
            label: "Unique Visitors",
            description: "Distinct affiliate-link clicks",
            count: totalClicks,
          }
        : null,
      {
        key: "signups",
        label: "Signups",
        description: "User rows created in period",
        count: r.signups,
      },
      {
        key: "first_deposit",
        label: "First Deposit",
        description: "At least one completed deposit",
        count: r.firstDeposit,
      },
      {
        key: "first_wager",
        label: "First Wager",
        description: "At least one pack/battle/upgrader bet",
        count: r.firstWager,
      },
      {
        key: "repeat_depositor",
        label: "Repeat Depositor",
        description: "Two or more completed deposits",
        count: r.repeatDeposit,
      },
      {
        key: "maw",
        label: "Monthly Active Wagerer",
        description: "Wagered in the last 30 days",
        count: r.maw,
      },
    ].filter((s): s is NonNullable<typeof s> => s !== null);

    const top = stepsRaw[0]?.count ?? 0;
    const steps: FunnelStep[] = stepsRaw.map((s, i) => {
      const prev = i === 0 ? null : stepsRaw[i - 1].count;
      const dropoff = prev == null || prev === 0 ? null : 1 - s.count / prev;
      const conversionFromTop = top === 0 ? 0 : s.count / top;
      return { ...s, dropoffFromPrev: dropoff, conversionFromTop };
    });
    return { key: r.bucket, label: r.bucket, steps };
  });

  return { period, breakdownBy, buckets };
}
