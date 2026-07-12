import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import { type DashboardPeriod } from "@/lib/queries/dashboard-period";
import {
  dashboardChartCutoff,
  dashboardChartHourlyBuckets,
  padDashboardAttributionSeries,
  padDashboardCountSeries,
  padDashboardDepositSeries,
  padDashboardFtdSeries,
  padDashboardWagerSeries,
} from "@/lib/queries/dashboard-chart-series";
import { toNumber } from "@/lib/utils/decimal";

/**
 * Phase 2A ClickHouse READ — Dashboard trend-series (+ FTD daily), read from the
 * ClickHouse prod game mirror (`packy_prod`, PeerDB CDC).
 *
 * PARITY with the canonical Postgres definition
 * (src/lib/queries/dashboard-trend-series.ts → fetchDashboardTrendSeriesInner):
 *
 *   • dailyWagers  — per-bucket Σ|amount| of ledger_transactions split into
 *                    `packs` (type='pack_opening'), `battles`
 *                    (type IN battle_bet,battle_sponsorship), and `upgrader`
 *                    (Σ bet_amount of upgrader_games). status='completed',
 *                    customer-scoped.
 *   • dailyDeposits — per-bucket Σ amount of type='deposit' (status='completed'),
 *                     emitted ABS() to match the Postgres path's Math.abs().
 *   • dailyActiveDepositors — per-bucket distinct user_id with a completed
 *                     deposit (uniqExact, replicating COUNT(DISTINCT …)).
 *   • dailySignups — per-bucket COUNT(*) of public_user created in the window.
 *   • dailyFtds    — first-deposit-per-user (min created_at over completed
 *                    deposits), bucketed by that first-deposit date. Replicates
 *                    Postgres `DISTINCT ON (user_id) … ORDER BY user_id,
 *                    created_at ASC` semantics via argMin/min on user_id.
 *   • dailyWagerAttribution — per-bucket organic vs creator-coded Σ|amount| of
 *                    gaming wagers (pack_opening, battle_bet, battle_sponsorship),
 *                    where `under_creator` = the customer's referred_by resolves
 *                    to a role='creator' user.
 *
 * SCOPE asymmetry replicated EXACTLY from the Postgres twin:
 *   • ledger wagers/deposits, signups, and FTDs scope to
 *     role NOT IN ('admin','support')  (creators KEPT — they are filtered out
 *     of attribution per-row via `under_creator`, and never separately in the
 *     wager/deposit/signup legs).
 *   • upgrader_games scope to role NOT IN ('admin','support','creator').
 *   • wager-attribution `customers` CTE scope to
 *     role NOT IN ('admin','support','creator').
 * These three different scopes match the three different `role NOT IN (…)`
 * clauses in fetchDashboardTrendSeriesInner verbatim — do NOT unify them.
 *
 * ClickHouse correctness (PeerDB / ReplacingMergeTree mirrors):
 *   • Dedup latest row per id with FINAL on every public_* table.
 *   • Drop soft-deleted rows with `_peerdb_is_deleted = 0`.
 *   • Money stays Decimal end-to-end — toString(sum(…)) in SQL, toNumber()
 *     in TS — never Float / toFloat.
 *
 * Buckets are formatted server-side to the SAME canonical UTC label
 * `dashboardChartDateLabel` produces (HH:MM for hourly periods, YYYY-MM-DD for
 * daily), so the TS side feeds the identical `padDashboard*` helpers the
 * Postgres path uses — guaranteeing byte-identical x-axis bucketing.
 *
 * The blacklist is passed IN by the caller (fetched from the admin DB via
 * getExcludedUserIds) so this module never imports a Postgres client — it is a
 * pure ClickHouse read. The cutoff reuses the SAME canonical helpers the
 * Postgres path uses (dashboardChartCutoff/periodToCutoff with the shared
 * 365-day lifetime cap), guaranteeing identical windows.
 */

const CH_DB = "packy_prod";

/** Kept in sync with LIFETIME_LOOKBACK_DAYS in dashboard-trend-series.ts (== GGR_LIFETIME_LOOKBACK_DAYS). */
const LIFETIME_LOOKBACK_DAYS = 365;

export type DashboardTrendSeries = {
  dailyWagers: {
    date: string;
    packs: number;
    battles: number;
    upgrader: number;
  }[];
  dailyDeposits: { date: string; amount: number }[];
  dailySignups: { date: string; count: number }[];
  dailyFtds: { date: string; count: number; total: number; avg: number }[];
  dailyActiveDepositors: { date: string; count: number }[];
  dailyWagerAttribution: {
    date: string;
    organic: number;
    creatorCoded: number;
  }[];
  chartHourlyBuckets: boolean;
};

/** JS Date (UTC) → ClickHouse DateTime64 literal 'YYYY-MM-DD HH:MM:SS.fff'. */
function chDateTime(d: Date): string {
  return d.toISOString().replace("T", " ").replace("Z", "");
}

/**
 * ClickHouse SQL expression that buckets `col` (a UTC DateTime) and formats it
 * to the EXACT label `dashboardChartDateLabel` emits:
 *   • hourly periods → 'HH:MM' (matches d.toISOString().slice(11,16))
 *   • daily periods  → 'YYYY-MM-DD' (matches d.toISOString().slice(0,10))
 * Mirror tables store DateTime in UTC, so no timezone arg is needed.
 *
 * NOTE: ClickHouse formatDateTime `%i` is minutes; `%M` is the full month name
 * (e.g. "June"), so the hourly label MUST use '%H:%i' to match Postgres's
 * HH:MM (start-of-hour minutes are always 00).
 */
function chBucketLabelExpr(col: string, period: DashboardPeriod): string {
  return dashboardChartHourlyBuckets(period)
    ? `formatDateTime(toStartOfHour(${col}), '%H:%i')`
    : `toString(toDate(${col}))`;
}

function realUsersCte(
  hasBlacklist: boolean,
  excludedRoles: readonly string[],
): string {
  const roleList = excludedRoles.map((r) => `'${r}'`).join(",");
  return `SELECT id
      FROM ${CH_DB}.public_user FINAL
      WHERE _peerdb_is_deleted = 0
        AND role NOT IN (${roleList})
        ${hasBlacklist ? "AND id NOT IN {blacklist:Array(String)}" : ""}`;
}

type LedgerBucketChRow = {
  bucket: string;
  packs: string;
  battles: string;
  deposits: string;
  active_depositors: string;
};
type CountChRow = { bucket: string; value: string };
type UpgraderChRow = { bucket: string; upgrader: string };
type AttributionChRow = {
  bucket: string;
  organic: string;
  creator_attributed: string;
};
type FtdChRow = { bucket: string; count: string; total: string };

async function fetchTrendSeries(
  period: DashboardPeriod,
  blacklist: string[],
  now: Date,
): Promise<{
  ledgerRows: LedgerBucketChRow[];
  upgraderRows: UpgraderChRow[];
  signupRows: CountChRow[];
  attributionRows: AttributionChRow[];
  ftdRows: FtdChRow[];
}> {
  const cutoff = chDateTime(
    dashboardChartCutoff(period, now, LIFETIME_LOOKBACK_DAYS),
  );
  const hasBlacklist = blacklist.length > 0;
  const params: Record<string, unknown> = { cutoff, blacklist };

  const ledgerBucket = chBucketLabelExpr("lt.created_at", period);
  const upgBucket = chBucketLabelExpr("ug.created_at", period);
  const userBucket = chBucketLabelExpr("u.created_at", period);
  // Attribution buckets on the ledger row's created_at (same as PG twin).
  const attrBucket = chBucketLabelExpr("lt.created_at", period);

  // Customer scope used by ledger wagers/deposits, signups and FTDs:
  //   role NOT IN ('admin','support')  (creators KEPT).
  const realUsersStaff = realUsersCte(hasBlacklist, ["admin", "support"]);
  // Customer scope used by upgrader + attribution: creators ALSO dropped.
  const realUsersNoCreator = realUsersCte(hasBlacklist, [
    "admin",
    "support",
    "creator",
  ]);

  // ── 1. Ledger wagers + deposits + active depositors ──────────────────
  const ledgerSql = `
    WITH real_users AS (${realUsersStaff})
    SELECT
      ${ledgerBucket} AS bucket,
      toString(sum(if(lt.type = 'pack_opening', abs(lt.amount), 0)))                                AS packs,
      toString(sum(if(lt.type IN ('battle_bet','battle_sponsorship'), abs(lt.amount), 0)))          AS battles,
      toString(sum(if(lt.type = 'deposit', lt.amount, 0)))                                          AS deposits,
      toString(uniqExact(if(lt.type = 'deposit', lt.user_id, NULL)))                                AS active_depositors
    FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
    WHERE lt._peerdb_is_deleted = 0
      AND lt.status = 'completed'
      AND lt.type IN ('pack_opening','battle_bet','battle_sponsorship','deposit')
      AND lt.user_id IN (SELECT id FROM real_users)
      AND lt.created_at >= {cutoff:DateTime64(6)}
    GROUP BY bucket
    ORDER BY bucket`;

  // ── 2. Upgrader wagers (creators dropped) ────────────────────────────
  const upgraderSql = `
    WITH real_users AS (${realUsersNoCreator})
    SELECT
      ${upgBucket} AS bucket,
      toString(sum(ug.bet_amount)) AS upgrader
    FROM ${CH_DB}.public_upgrader_games AS ug FINAL
    WHERE ug._peerdb_is_deleted = 0
      AND ug.user_id IN (SELECT id FROM real_users)
      AND ug.created_at >= {cutoff:DateTime64(6)}
    GROUP BY bucket
    ORDER BY bucket`;

  // ── 3. Signups ───────────────────────────────────────────────────────
  // `is_locked = 0` matches the PG twin's bot-prevention drop: the signup
  // pipeline locks automated registrations server-side (Jun 11 had 4,141 of
  // 4,205 same-day signups locked with `locked_reason = 'bot prevention'`).
  // Must stay in sync with the PG signups CTE so comparison-mode parity holds.
  const signupSql = `
    SELECT
      ${userBucket} AS bucket,
      toString(count()) AS value
    FROM ${CH_DB}.public_user AS u FINAL
    WHERE u._peerdb_is_deleted = 0
      AND u.role NOT IN ('admin','support')
      AND u.is_locked = 0
      ${hasBlacklist ? "AND u.id NOT IN {blacklist:Array(String)}" : ""}
      AND u.created_at >= {cutoff:DateTime64(6)}
    GROUP BY bucket
    ORDER BY bucket`;

  // ── 4. Wager attribution (organic vs creator-coded) ──────────────────
  // `customers` resolves each in-scope customer's under_creator flag by joining
  // referred_by → a role='creator' user. Replicates the EXISTS subquery in the
  // PG twin via a semi-join against the set of creator ids.
  const attributionSql = `
    WITH
      real_users AS (${realUsersNoCreator}),
      creator_ids AS (
        SELECT id FROM ${CH_DB}.public_user FINAL
        WHERE _peerdb_is_deleted = 0 AND role = 'creator'
      ),
      customers AS (
        SELECT
          u.id AS id,
          ifNull(u.referred_by IN (SELECT id FROM creator_ids), 0) AS under_creator
        FROM ${CH_DB}.public_user AS u FINAL
        WHERE u._peerdb_is_deleted = 0
          AND u.id IN (SELECT id FROM real_users)
      )
    SELECT
      ${attrBucket} AS bucket,
      toString(sum(if(NOT c.under_creator, abs(lt.amount), 0))) AS organic,
      toString(sum(if(c.under_creator, abs(lt.amount), 0)))     AS creator_attributed
    FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
    INNER JOIN customers AS c ON c.id = lt.user_id
    WHERE lt._peerdb_is_deleted = 0
      AND lt.status = 'completed'
      AND lt.type IN ('pack_opening','battle_bet','battle_sponsorship')
      AND lt.created_at >= {cutoff:DateTime64(6)}
    GROUP BY bucket
    ORDER BY bucket`;

  // ── 5. FTD daily (first deposit per user) ────────────────────────────
  // First-deposit-per-user over ALL completed deposits (NOT windowed at the
  // inner level — the PG `first_deposits` CTE is unbounded; the window filter is
  // applied AFTER reducing to one row per user), then bucket the survivors whose
  // first deposit landed in the window. argMin(created_at, created_at)=min, and
  // argMin(amount, created_at) picks the amount of the EARLIEST deposit —
  // replicating DISTINCT ON (user_id) ORDER BY created_at ASC exactly.
  const ftdSql = `
    WITH
      real_users AS (${realUsersStaff}),
      first_deposits AS (
        SELECT
          lt.user_id AS user_id,
          min(lt.created_at) AS first_at,
          argMin(lt.amount, lt.created_at) AS amount
        FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
        WHERE lt._peerdb_is_deleted = 0
          AND lt.type = 'deposit'
          AND lt.status = 'completed'
          AND lt.user_id IN (SELECT id FROM real_users)
        GROUP BY lt.user_id
      )
    SELECT
      ${chBucketLabelExpr("fd.first_at", period)} AS bucket,
      toString(count())          AS count,
      toString(sum(fd.amount))   AS total
    FROM first_deposits AS fd
    WHERE fd.first_at >= {cutoff:DateTime64(6)}
    GROUP BY bucket
    ORDER BY bucket`;

  const [ledgerRows, upgraderRows, signupRows, attributionRows, ftdRows] =
    await Promise.all([
      clickhouseRead.query<LedgerBucketChRow>({
        queryName: "dashboard.trend.ledger",
        sql: ledgerSql,
        params,
      }),
      clickhouseRead.query<UpgraderChRow>({
        queryName: "dashboard.trend.upgrader",
        sql: upgraderSql,
        params,
      }),
      clickhouseRead.query<CountChRow>({
        queryName: "dashboard.trend.signups",
        sql: signupSql,
        params,
      }),
      clickhouseRead.query<AttributionChRow>({
        queryName: "dashboard.trend.attribution",
        sql: attributionSql,
        params,
      }),
      clickhouseRead.query<FtdChRow>({
        queryName: "dashboard.trend.ftd",
        sql: ftdSql,
        params,
      }),
    ]);

  return { ledgerRows, upgraderRows, signupRows, attributionRows, ftdRows };
}

/**
 * ClickHouse twin of getDashboardTrendSeries — returns the SAME shape.
 * `blacklist` is the excluded-user id list (admin-DB sourced) passed in by the
 * caller; this module never touches Postgres.
 */
export async function getDashboardTrendSeriesFromClickHouse(
  period: DashboardPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<DashboardTrendSeries> {
  const { ledgerRows, upgraderRows, signupRows, attributionRows, ftdRows } =
    await fetchTrendSeries(period, blacklist, now);

  // Merge upgrader into the wager series by bucket label (CH emits the SAME
  // canonical labels, so a direct map keyed on `bucket` mirrors mergeLedgerRows).
  const upgraderByBucket = new Map(
    upgraderRows.map((r) => [r.bucket, Number(r.upgrader)]),
  );

  const dailyWagers = padDashboardWagerSeries(
    ledgerRows.map((d) => ({
      date: d.bucket,
      packs: Number(d.packs),
      battles: Number(d.battles),
      upgrader: upgraderByBucket.get(d.bucket) ?? 0,
    })),
    period,
  );

  const dailyDeposits = padDashboardDepositSeries(
    ledgerRows.map((d) => ({
      date: d.bucket,
      amount: Math.abs(Number(d.deposits)),
    })),
    period,
  );

  const dailyActiveDepositors = padDashboardCountSeries(
    ledgerRows.map((d) => ({
      date: d.bucket,
      count: Number(d.active_depositors),
    })),
    period,
  );

  const dailySignups = padDashboardCountSeries(
    signupRows.map((r) => ({ date: r.bucket, count: Number(r.value) })),
    period,
  );

  const dailyWagerAttribution = padDashboardAttributionSeries(
    attributionRows.map((r) => ({
      date: r.bucket,
      organic: Number(r.organic),
      creatorCoded: Number(r.creator_attributed),
    })),
    period,
  );

  const dailyFtds = padDashboardFtdSeries(
    ftdRows.map((r) => {
      const count = Number(r.count);
      const total = toNumber(r.total);
      return {
        date: r.bucket,
        count,
        total,
        avg: count > 0 ? total / count : 0,
      };
    }),
    period,
  );

  return {
    dailyWagers,
    dailyDeposits,
    dailySignups,
    dailyFtds,
    dailyActiveDepositors,
    dailyWagerAttribution,
    chartHourlyBuckets: dashboardChartHourlyBuckets(period),
  };
}
