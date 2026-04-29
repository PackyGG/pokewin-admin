/**
 * Query helpers for the /system/stats page.
 *
 * These surface the admin dashboard's OWN operational health:
 *   - Session health (active sessions, logins today)
 *   - Audit activity (daily series, top admins, event-type breakdown)
 *   - Data freshness (last cron run)
 *   - Table sizes (approx row counts via pg_class, dual-DB)
 *
 * Every query here is lightweight. The table-count helper uses
 * `pg_class.reltuples` (pg's autovacuum-updated estimate) so it runs in
 * O(1) regardless of table size — do NOT replace with COUNT(*) for the
 * ledger/audit tables.
 */

import { adminDb } from "@/lib/admin-db";
import { getDb } from "@/lib/db";
import { MS_PER_MINUTE, MS_PER_DAY } from "@/lib/utils/time";

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * Sessions that are still valid: not expired and not explicitly logged out.
 * Matches the session model used in admin_sessions (see prisma/admin/schema.prisma).
 */
export async function getActiveSessionCount(): Promise<number> {
  const now = new Date();
  return adminDb.admin_sessions.count({
    where: {
      expires_at: { gt: now },
      logged_out_at: null,
    },
  });
}

/**
 * Distinct admins with at least one active session right now.
 * Useful alongside the raw session count — multiple devices per admin
 * shouldn't double-count as "active admins".
 *
 * Uses a raw COUNT(DISTINCT) so PG can answer with an index scan instead
 * of materialising the full result set and counting rows in JS.
 */
export async function getDistinctActiveAdmins(): Promise<number> {
  const rows = await adminDb.$queryRaw<{ c: bigint }[]>`
    SELECT COUNT(DISTINCT admin_user_id)::bigint AS c
    FROM admin_sessions
    WHERE expires_at > NOW() AND logged_out_at IS NULL
  `;
  return Number(rows[0]?.c ?? 0);
}

export type SessionHealth = {
  activeSessions: number;
  distinctActiveAdmins: number;
  avgSessionMinutes: number;
  logoutsToday: number;
};

/**
 * Composite session health snapshot. Average session minutes is computed
 * over sessions that have actually terminated (either explicit logout or
 * expiry in the past) — in-flight sessions are excluded because their
 * duration isn't yet known.
 *
 * The two "active" counts (total active sessions + distinct admins with
 * an active session) come from a single scan of `admin_sessions` filtered
 * on the same predicate — collapsed into one raw query so we only hit
 * the table once instead of twice.
 */
export async function getSessionHealth(): Promise<SessionHealth> {
  const now = new Date();
  const startOfToday = startOfDay(now);

  const [activeRow, avgRow, logoutsToday] = await Promise.all([
    adminDb.$queryRaw<
      { active_sessions: bigint; distinct_admins: bigint }[]
    >`
        SELECT
          COUNT(*)::bigint AS active_sessions,
          COUNT(DISTINCT admin_user_id)::bigint AS distinct_admins
        FROM admin_sessions
        WHERE expires_at > NOW() AND logged_out_at IS NULL
      `,
    adminDb.$queryRaw<{ avg_minutes: string | null }[]>`
        SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (
          COALESCE(logged_out_at, expires_at) - logged_in_at
        )) / 60), 0)::text AS avg_minutes
        FROM admin_sessions
        WHERE logged_out_at IS NOT NULL OR expires_at <= NOW()
      `,
    adminDb.admin_sessions.count({
      where: { logged_out_at: { gte: startOfToday } },
    }),
  ]);

  return {
    activeSessions: Number(activeRow[0]?.active_sessions ?? 0),
    distinctActiveAdmins: Number(activeRow[0]?.distinct_admins ?? 0),
    avgSessionMinutes: Number(avgRow[0]?.avg_minutes ?? 0),
    logoutsToday,
  };
}

// ---------------------------------------------------------------------------
// Audit activity
// ---------------------------------------------------------------------------

/**
 * Count of admin_login audit events since the start of today. The audit
 * trail writes `admin_login` (see src/app/(auth)/login/actions.ts and
 * verify-2fa/actions.ts) — there is no separate `login_success` type.
 */
export async function getLoginsToday(): Promise<number> {
  const startOfToday = startOfDay(new Date());
  return adminDb.admin_audit_events.count({
    where: {
      event_type: "admin_login",
      created_at: { gte: startOfToday },
    },
  });
}

/**
 * Total audit events recorded since the start of today, across all types.
 */
export async function getAuditEventsToday(): Promise<number> {
  const startOfToday = startOfDay(new Date());
  return adminDb.admin_audit_events.count({
    where: { created_at: { gte: startOfToday } },
  });
}

export type AuditDailyPoint = { date: string; count: number };

/**
 * Dense daily series over the last `days` days (inclusive of today).
 * Missing days are filled with 0 so the chart doesn't have gaps.
 */
export async function getAuditEventCountPerDay(
  days: number,
): Promise<AuditDailyPoint[]> {
  const since = new Date(Date.now() - (days - 1) * MS_PER_DAY);
  const sinceStart = startOfDay(since);

  const rows = await adminDb.$queryRaw<
    { date: Date; count: string }[]
  >`
    SELECT DATE(created_at AT TIME ZONE 'UTC') AS date, COUNT(*)::text AS count
    FROM admin_audit_events
    WHERE created_at >= ${sinceStart}
    GROUP BY DATE(created_at AT TIME ZONE 'UTC')
    ORDER BY date
  `;

  // Fill gaps so recharts doesn't skip missing days.
  const byDate = new Map<string, number>();
  for (const r of rows) {
    const key = new Date(r.date).toISOString().slice(0, 10);
    byDate.set(key, Number(r.count));
  }

  const out: AuditDailyPoint[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(sinceStart.getTime() + i * MS_PER_DAY);
    const key = d.toISOString().slice(0, 10);
    out.push({ date: key, count: byDate.get(key) ?? 0 });
  }
  return out;
}

export type TopAdminRow = {
  adminUserId: string;
  username: string | null;
  actionCount: number;
};

/**
 * Top admins by audit-event count since `since`. Joins back to admin_users
 * for the username so the UI doesn't need a second round-trip.
 */
export async function getTopAdminsByActions(
  limit: number,
  since: Date,
): Promise<TopAdminRow[]> {
  const grouped = await adminDb.admin_audit_events.groupBy({
    by: ["admin_user_id"],
    where: {
      admin_user_id: { not: null },
      created_at: { gte: since },
    },
    _count: { _all: true },
    orderBy: { _count: { admin_user_id: "desc" } },
    take: limit,
  });

  const ids = grouped
    .map((g) => g.admin_user_id)
    .filter((id): id is string => Boolean(id));

  const users =
    ids.length > 0
      ? await adminDb.admin_users.findMany({
          where: { id: { in: ids } },
          select: { id: true, username: true },
        })
      : [];

  const userMap = new Map(users.map((u) => [u.id, u.username]));

  return grouped.map((g) => ({
    adminUserId: g.admin_user_id as string,
    username: userMap.get(g.admin_user_id as string) ?? null,
    actionCount: g._count._all,
  }));
}

export type EventTypeBreakdownRow = { eventType: string; count: number };

/**
 * Distribution of admin_audit_events by type since `since`, sorted desc.
 * Feeds the donut/table on the stats page.
 */
export async function getEventTypeBreakdown(
  since: Date,
): Promise<EventTypeBreakdownRow[]> {
  const grouped = await adminDb.admin_audit_events.groupBy({
    by: ["event_type"],
    where: { created_at: { gte: since } },
    _count: { _all: true },
    orderBy: { _count: { event_type: "desc" } },
  });
  return grouped.map((g) => ({
    eventType: g.event_type,
    count: g._count._all,
  }));
}

// ---------------------------------------------------------------------------
// Table sizes (approx via pg_class.reltuples)
// ---------------------------------------------------------------------------
//
// reltuples is autovacuum-updated and can lag behind COUNT(*), but for the
// scale shown on a stats page ("about this many rows") the tradeoff is
// worth it — exact counts would scan the whole table, which is not what
// you want on ledger_transactions.
//
// We allow an allow-list of table names (prevents injection via pg_class
// lookup) and query each DB separately because cross-DB joins are not a
// thing here.

const ADMIN_TABLES = [
  "admin_users",
  "admin_sessions",
  "admin_audit_events",
  "admin_notes",
  "admin_roles",
  "creator_deals",
  "creator_balance_fills",
  "webhook_deliveries",
] as const;

const MAIN_TABLES = [
  "user",
  "ledger_transactions",
  "affiliate_clicks",
] as const;

export type TableRowCount = { table: string; approxCount: number };

async function countsFromPgClass(
  client: { $queryRawUnsafe: (q: string, ...args: unknown[]) => Promise<unknown> },
  tables: readonly string[],
): Promise<TableRowCount[]> {
  // Single query against pg_class using an IN-list of parameter placeholders.
  // `reltuples` is a real number — cast to bigint so small counts aren't
  // surfaced as scientific notation.
  const placeholders = tables.map((_, i) => `$${i + 1}`).join(", ");
  const rows = (await client.$queryRawUnsafe(
    `SELECT relname AS table, reltuples::bigint AS approx_count
       FROM pg_class
      WHERE relkind = 'r'
        AND relname IN (${placeholders})`,
    ...tables,
  )) as { table: string; approx_count: bigint | number | string }[];

  const found = new Map<string, number>();
  for (const r of rows) {
    // reltuples can legitimately return -1 for tables that have never been
    // analyzed — surface as 0 rather than a confusing negative number.
    const raw = Number(r.approx_count);
    found.set(r.table, raw < 0 ? 0 : raw);
  }

  // Preserve input order so the UI renders predictably.
  return tables.map((t) => ({
    table: t,
    approxCount: found.get(t) ?? 0,
  }));
}

export type TableRowCounts = {
  admin: TableRowCount[];
  main: TableRowCount[];
};

export async function getTableRowCounts(): Promise<TableRowCounts> {
  const db = await getDb();
  const [admin, main] = await Promise.all([
    countsFromPgClass(adminDb, ADMIN_TABLES),
    countsFromPgClass(db, MAIN_TABLES),
  ]);
  return { admin, main };
}

// ---------------------------------------------------------------------------
// Cron health
// ---------------------------------------------------------------------------
//
// The only cron endpoint in the app today is /api/cron/creator-fills which
// writes a `creator_balance_fills` row with triggered_by = 'cron' on each
// successful fill. We surface the latest cron fill as the freshness signal
// for that job. If other cron jobs appear later, extend CRON_JOBS below.

export type CronJobHealth = {
  /** Stable identifier matching the endpoint path. */
  name: string;
  /** Human label for the UI. */
  label: string;
  /** When the job last ran successfully, if ever. */
  lastRunAt: string | null;
  /** Minutes since last run. null if never run. */
  minutesSinceRun: number | null;
};

/**
 * Look up the most recent cron-triggered event for each known job. Kept
 * extensible via CRON_JOBS — add new entries as cron endpoints land.
 */
export async function getCronHealth(): Promise<CronJobHealth[]> {
  const latestFill = await adminDb.creator_balance_fills.findFirst({
    where: { triggered_by: "cron" },
    orderBy: { created_at: "desc" },
    select: { created_at: true },
  });

  const now = Date.now();

  const creatorFillsLastRun = latestFill?.created_at ?? null;
  const creatorFillsMinutes = creatorFillsLastRun
    ? Math.round((now - creatorFillsLastRun.getTime()) / MS_PER_MINUTE)
    : null;

  return [
    {
      name: "creator-fills",
      label: "Creator balance fills",
      lastRunAt: creatorFillsLastRun ? creatorFillsLastRun.toISOString() : null,
      minutesSinceRun: creatorFillsMinutes,
    },
  ];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
