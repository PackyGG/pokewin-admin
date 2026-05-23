import { getDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "./_blacklist";

/**
 * Acquisition funnel: clicks → signups → first-deposit → first-wager →
 * repeat-depositor → monthly-active-wagerer.
 *
 * Staff excluded. Period filter applies to the time-bounded steps (clicks
 * and signups). The later steps (first-deposit, first-wager, repeat-
 * depositor, MAW) are computed from the cohort of users whose signup
 * falls in the window — this keeps the drop-off rates meaningful rather
 * than mixing brand-new signups with legacy accounts.
 */

export type FunnelPeriod = "7d" | "30d" | "90d" | "all";

function daysForPeriod(period: FunnelPeriod): number | null {
  switch (period) {
    case "7d":
      return 7;
    case "30d":
      return 30;
    case "90d":
      return 90;
    case "all":
      return null;
  }
}

export type FunnelStep = {
  key: string;
  label: string;
  description: string;
  count: number;
  dropoffFromPrev: number | null; // 0..1 (1 = full drop-off; null = first step)
  conversionFromTop: number; // 0..1 relative to clicks
};

export type FunnelData = {
  period: FunnelPeriod;
  steps: FunnelStep[];
};

export async function getFunnelData(period: FunnelPeriod): Promise<FunnelData> {
  const db = await getDb();
  const days = daysForPeriod(period);
  const dateFilter = days !== null ? `AND created_at >= NOW() - INTERVAL '${days} days'` : "";
  const usersDateFilter =
    days !== null ? `AND u.created_at >= NOW() - INTERVAL '${days} days'` : "";
  const maWCutoff = 30; // MAW = wager in the last 30 days
  const excluded = await getExcludedUserIds();
  const blacklistIdNotIn = blacklistNotInClause("u.id", excluded);

  // Two parallel queries: one for the time-bounded top of the funnel
  // (clicks, taken from affiliate_clicks) and one for the cohort-scoped
  // funnel below it (signups → MAW). The cohort query uses a CTE so the
  // user table is scanned once with the role/period filter — previously
  // each step issued its own scan against `"user"` JOIN ledger.
  const [clicksRow, cohortRow] = await Promise.all([
    // Clicks = raw count of affiliate clicks in the period. Bot-filtering
    // isn't available on this table — kept as the funnel's outermost
    // visitor-shape signal.
    db.$queryRawUnsafe<{ count: string }[]>(`
      SELECT COUNT(*)::text AS count
      FROM affiliate_clicks
      WHERE 1=1 ${dateFilter}
    `),
    // One CTE pass over the cohort produces all five cohort-scoped
    // counts as columns. PG runs this as a single index scan on
    // ledger_transactions per user instead of five repeated joins.
    db.$queryRawUnsafe<
      {
        signups: string;
        first_deposit: string;
        first_wager: string;
        repeat_deposit: string;
        maw: string;
      }[]
    >(`
      WITH cohort AS (
        SELECT u.id
        FROM "user" u
        WHERE u.role NOT IN ('admin', 'support') ${blacklistIdNotIn}
          ${usersDateFilter}
      ),
      activity AS (
        SELECT
          c.id AS user_id,
          COUNT(*) FILTER (
            WHERE lt.type = 'deposit' AND lt.status = 'completed'
          ) AS deposit_count,
          COUNT(*) FILTER (
            WHERE lt.type IN ('pack_opening','battle_bet','battle_sponsorship')
              AND lt.status = 'completed'
          ) AS wager_count,
          COUNT(*) FILTER (
            WHERE lt.type IN ('pack_opening','battle_bet','battle_sponsorship')
              AND lt.status = 'completed'
              AND lt.created_at >= NOW() - INTERVAL '${maWCutoff} days'
          ) AS wager_count_30d,
          BOOL_OR(b.total_deposited::numeric > 0) AS has_deposit_balance
        FROM cohort c
        LEFT JOIN ledger_transactions lt ON lt.user_id = c.id
        LEFT JOIN balances b ON b.user_id = c.id
        GROUP BY c.id
      )
      SELECT
        (SELECT COUNT(*)::text FROM cohort) AS signups,
        COUNT(*) FILTER (WHERE has_deposit_balance)::text AS first_deposit,
        COUNT(*) FILTER (WHERE wager_count > 0)::text AS first_wager,
        COUNT(*) FILTER (WHERE deposit_count >= 2)::text AS repeat_deposit,
        COUNT(*) FILTER (WHERE wager_count_30d > 0)::text AS maw
      FROM activity
    `),
  ]);

  const clicks = Number(clicksRow[0]?.count ?? 0);
  const cohort = cohortRow[0];
  const signups = Number(cohort?.signups ?? 0);
  const firstDeposit = Number(cohort?.first_deposit ?? 0);
  const firstWager = Number(cohort?.first_wager ?? 0);
  const repeatDeposit = Number(cohort?.repeat_deposit ?? 0);
  const maw = Number(cohort?.maw ?? 0);

  const raw = [
    {
      key: "clicks",
      label: "Unique Visitors",
      description: "Distinct affiliate-link clicks",
      count: clicks,
    },
    {
      key: "signups",
      label: "Signups",
      description: "User rows created in period",
      count: signups,
    },
    {
      key: "first_deposit",
      label: "First Deposit",
      description: "At least one completed deposit",
      count: firstDeposit,
    },
    {
      key: "first_wager",
      label: "First Wager",
      description: "At least one pack/battle bet",
      count: firstWager,
    },
    {
      key: "repeat_depositor",
      label: "Repeat Depositor",
      description: "Two or more completed deposits",
      count: repeatDeposit,
    },
    {
      key: "maw",
      label: "Monthly Active Wagerer",
      description: "Wagered in the last 30 days",
      count: maw,
    },
  ];

  const top = raw[0]?.count ?? 0;
  const steps: FunnelStep[] = raw.map((r, i) => {
    const prev = i === 0 ? null : raw[i - 1].count;
    const dropoff =
      prev == null || prev === 0 ? null : 1 - r.count / prev;
    const conversionFromTop = top === 0 ? 0 : r.count / top;
    return { ...r, dropoffFromPrev: dropoff, conversionFromTop };
  });

  return { period, steps };
}
