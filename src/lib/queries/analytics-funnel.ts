import { getDb } from "@/lib/db";

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

  // Run all steps in parallel. Each returns a single integer count.
  const [
    clicksRow,
    signupsRow,
    firstDepositRow,
    firstWagerRow,
    repeatDepositRow,
    mawRow,
  ] = await Promise.all([
    // Clicks = distinct IPs (over the period), excluding bots isn't possible
    // from this table alone, so treat it as "raw visitor funnel top".
    db.$queryRawUnsafe<{ count: string }[]>(`
      SELECT COUNT(*)::text AS count
      FROM affiliate_clicks
      WHERE 1=1 ${dateFilter}
    `),
    // Signups in period (real users only).
    db.$queryRawUnsafe<{ count: string }[]>(`
      SELECT COUNT(*)::text AS count
      FROM "user" u
      WHERE u.role NOT IN ('admin','creator')
        ${usersDateFilter.replace("created_at", "u.created_at")}
    `),
    // First-depositor = users (in the cohort) who have a completed deposit
    // ledger row at any point. We sum from balances.total_deposited > 0 — same
    // signal the rest of the admin uses.
    db.$queryRawUnsafe<{ count: string }[]>(`
      SELECT COUNT(*)::text AS count
      FROM "user" u
      JOIN balances b ON b.user_id = u.id
      WHERE u.role NOT IN ('admin','creator')
        AND b.total_deposited::numeric > 0
        ${usersDateFilter}
    `),
    // First-wagerer = any wager transaction on the account OR
    // user_statistics counters > 0. We check ledger so we don't rely on
    // snapshot staleness.
    db.$queryRawUnsafe<{ count: string }[]>(`
      SELECT COUNT(DISTINCT u.id)::text AS count
      FROM "user" u
      JOIN ledger_transactions lt ON lt.user_id = u.id
      WHERE u.role NOT IN ('admin','creator')
        AND lt.status = 'completed'
        AND lt.type IN ('pack_opening','battle_bet','battle_sponsorship')
        ${usersDateFilter}
    `),
    // Repeat-depositor = >= 2 completed deposit ledger rows.
    db.$queryRawUnsafe<{ count: string }[]>(`
      SELECT COUNT(*)::text AS count
      FROM (
        SELECT u.id
        FROM "user" u
        JOIN ledger_transactions lt ON lt.user_id = u.id
        WHERE u.role NOT IN ('admin','creator')
          AND lt.status = 'completed'
          AND lt.type = 'deposit'
          ${usersDateFilter}
        GROUP BY u.id
        HAVING COUNT(*) >= 2
      ) sub
    `),
    // Monthly-active-wagerer = wager in last ${maWCutoff} days from the
    // cohort. The last-activity filter is global (not period-scoped on the
    // wager itself) because MAW is an intrinsically 30-day metric.
    db.$queryRawUnsafe<{ count: string }[]>(`
      SELECT COUNT(DISTINCT u.id)::text AS count
      FROM "user" u
      JOIN ledger_transactions lt ON lt.user_id = u.id
      WHERE u.role NOT IN ('admin','creator')
        AND lt.status = 'completed'
        AND lt.type IN ('pack_opening','battle_bet','battle_sponsorship')
        AND lt.created_at >= NOW() - INTERVAL '${maWCutoff} days'
        ${usersDateFilter}
    `),
  ]);

  const clicks = Number(clicksRow[0]?.count ?? 0);
  const signups = Number(signupsRow[0]?.count ?? 0);
  const firstDeposit = Number(firstDepositRow[0]?.count ?? 0);
  const firstWager = Number(firstWagerRow[0]?.count ?? 0);
  const repeatDeposit = Number(repeatDepositRow[0]?.count ?? 0);
  const maw = Number(mawRow[0]?.count ?? 0);

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
