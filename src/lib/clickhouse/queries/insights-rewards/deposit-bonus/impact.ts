import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type {
  BonusWagerSegment,
  CapHitterRow,
  DepositBonusCapHitterCohorts,
  DepositBonusCapHitters,
  DepositBonusDepositFrequency,
  DepositBonusDepositSizeDistribution,
  DepositBonusPostCapBehavior,
  DepositBonusTimeBetween,
  DepositBonusToWagerSegments,
  DepositFrequencyBucket,
  DepositSizeBucket,
  TimeGapBucket,
} from "@/lib/queries/insights-rewards/deposit-bonus/impact";

import { CH_DB, toNumber } from "../../_shared";
import {
  cutoffClause,
  depositBonusCappedCutoff,
  depositBonusCutoff,
  depositBonusScopeCte,
} from "./_shared";

/**
 * ClickHouse twins of the deposit-bonus "impact" lenses
 * (`src/lib/queries/insights-rewards/deposit-bonus/impact.ts`).
 *
 * One twin per PG helper, mirroring its EXACT scope (2-role customer +
 * blacklist), window cutoffs (plain vs capped 365d on lifetime), bucket
 * boundaries and tie-breaks. Counts + Decimal Σ are cent/count-exact and
 * gated; percentile/AVG-derived fields (medians, p25/p75, avg-per-day) are
 * returned for shape parity but NOT gated (PG `PERCENTILE_CONT`/`AVG` vs CH
 * Float64 quantile cannot be bit-exact). Money stays Decimal end-to-end.
 *
 * Tie-breaks (§5c): cap-hitter / cap-hitter-cohort ranked lists add `user_id
 * ASC` as a deterministic secondary (pinned on PG in the parity script).
 */

const WAGER_TYPES = "('pack_opening','battle_bet','battle_sponsorship','upgrader_bet')";
const PAYOUT_TYPES = "('battle_refund','upgrader_payout')";
const CAP_HITTER_LIMIT = 100;

const FREQUENCY_BUCKETS: Array<{ label: string; min: number; max: number }> = [
  { label: "1×", min: 1, max: 1 },
  { label: "2×", min: 2, max: 2 },
  { label: "3×", min: 3, max: 3 },
  { label: "4+×", min: 4, max: Number.MAX_SAFE_INTEGER },
];

const SIZE_BUCKETS: Array<{ label: string; min: number; max: number; isLarge: boolean }> = [
  { label: "<$10", min: 0, max: 10, isLarge: false },
  { label: "$10–50", min: 10, max: 50, isLarge: false },
  { label: "$50–100", min: 50, max: 100, isLarge: false },
  { label: "$100–500", min: 100, max: 500, isLarge: false },
  { label: "$500–1K", min: 500, max: 1000, isLarge: true },
  { label: "$1K–2K", min: 1000, max: 2000, isLarge: true },
  { label: "$2K+", min: 2000, max: Number.MAX_SAFE_INTEGER, isLarge: true },
];

const GAP_BUCKETS: Array<{ label: string; min: number; max: number }> = [
  { label: "<30min", min: 0, max: 30 },
  { label: "30min–2h", min: 30, max: 120 },
  { label: "2–6h", min: 120, max: 360 },
  { label: "6–24h", min: 360, max: 1440 },
  { label: ">24h", min: 1440, max: Number.MAX_SAFE_INTEGER },
];

// ─── 1. Deposit frequency ───────────────────────────────────────────

export async function getDepositBonusDepositFrequencyFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<DepositBonusDepositFrequency> {
  const scope = depositBonusScopeCte(blacklist.length > 0);
  const cutoff = depositBonusCappedCutoff(period, now);
  const params = { blacklist, cutoff };
  const perUserDay = `
    ${scope},
    per_user_day AS (
      SELECT lt.user_id AS user_id, toDate(lt.created_at) AS day, count() AS deposits
      FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
      WHERE lt._peerdb_is_deleted = 0
        AND lt.status = 'completed'
        AND lt.type = 'deposit'
        AND lt.user_id IN (SELECT id FROM real_users)
        AND lt.created_at >= {cutoff:DateTime64(6)}
      GROUP BY lt.user_id, day
    )`;

  const [bucketRows, statRows] = await Promise.all([
    clickhouseRead.query<{ bucket: string; user_days: string }>({
      queryName: "insights.deposit_bonus.impact.frequency.buckets",
      sql: `WITH ${perUserDay}
        SELECT toString(multiIf(deposits >= 4, 3, deposits = 3, 2, deposits = 2, 1, 0)) AS bucket,
               toString(count()) AS user_days
        FROM per_user_day GROUP BY bucket ORDER BY bucket`,
      params,
      timeoutMs: 30_000,
    }),
    clickhouseRead.query<{
      total_user_days: string;
      total_users: string;
      avg_per_day: string | null;
      median_per_day: string | null;
      multi_user_days: string;
    }>({
      queryName: "insights.deposit_bonus.impact.frequency.stats",
      sql: `WITH ${perUserDay}
        SELECT toString(count()) AS total_user_days,
               toString(uniqExact(user_id)) AS total_users,
               toString(avg(deposits)) AS avg_per_day,
               toString(quantileExactInclusive(0.5)(deposits)) AS median_per_day,
               toString(countIf(deposits > 1)) AS multi_user_days
        FROM per_user_day`,
      params,
      timeoutMs: 30_000,
    }),
  ]);

  const buckets: DepositFrequencyBucket[] = FREQUENCY_BUCKETS.map((b) => ({
    label: b.label,
    minDeposits: b.min,
    maxDeposits: b.max === Number.MAX_SAFE_INTEGER ? Number.POSITIVE_INFINITY : b.max,
    userDays: 0,
    share: 0,
  }));
  for (const r of bucketRows) {
    const idx = Number(r.bucket);
    if (idx >= 0 && idx < buckets.length) buckets[idx].userDays = Number(r.user_days ?? 0);
  }
  const stats = statRows[0];
  const totalUserDays = Number(stats?.total_user_days ?? 0);
  const totalUsers = Number(stats?.total_users ?? 0);
  const multiUserDays = Number(stats?.multi_user_days ?? 0);
  for (const b of buckets) b.share = totalUserDays > 0 ? b.userDays / totalUserDays : 0;

  return {
    buckets,
    totalUserDays,
    totalUsers,
    avgDepositsPerUserDay: stats?.avg_per_day != null ? toNumber(stats.avg_per_day) : 0,
    medianDepositsPerUserDay: stats?.median_per_day != null ? toNumber(stats.median_per_day) : 0,
    multiDepositDayShare: totalUserDays > 0 ? multiUserDays / totalUserDays : 0,
  };
}

// ─── 2. Deposit size distribution ──────────────────────────────────

export async function getDepositBonusDepositSizeDistributionFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<DepositBonusDepositSizeDistribution> {
  const scope = depositBonusScopeCte(blacklist.length > 0);
  const cutoff = depositBonusCutoff(period, now);
  const params = { blacklist, cutoff };
  const depositsCte = `
    ${scope},
    deposits AS (
      SELECT abs(lt.amount) AS amt
      FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
      WHERE lt._peerdb_is_deleted = 0
        AND lt.status = 'completed'
        AND lt.type = 'deposit'
        AND lt.user_id IN (SELECT id FROM real_users)
        ${cutoffClause(cutoff, "lt")}
    )`;

  const [bucketRows, medianRows] = await Promise.all([
    clickhouseRead.query<{ bucket: string; cnt: string; volume: string }>({
      queryName: "insights.deposit_bonus.impact.size.buckets",
      sql: `WITH ${depositsCte}
        SELECT toString(multiIf(amt < 10, 0, amt < 50, 1, amt < 100, 2, amt < 500, 3, amt < 1000, 4, amt < 2000, 5, 6)) AS bucket,
               toString(count()) AS cnt, toString(sum(amt)) AS volume
        FROM deposits GROUP BY bucket ORDER BY bucket`,
      params,
      timeoutMs: 30_000,
    }),
    clickhouseRead.query<{ median_usd: string | null }>({
      queryName: "insights.deposit_bonus.impact.size.median",
      sql: `WITH ${depositsCte}
        SELECT toString(quantileExactInclusive(0.5)(toFloat64(amt))) AS median_usd FROM deposits`,
      params,
      timeoutMs: 30_000,
    }),
  ]);

  const buckets: DepositSizeBucket[] = SIZE_BUCKETS.map((b) => ({
    label: b.label,
    min: b.min,
    max: b.max === Number.MAX_SAFE_INTEGER ? Number.POSITIVE_INFINITY : b.max,
    count: 0,
    volume: 0,
    countShare: 0,
    isLarge: b.isLarge,
  }));
  for (const r of bucketRows) {
    const idx = Number(r.bucket);
    if (idx >= 0 && idx < buckets.length) {
      buckets[idx].count = Number(r.cnt ?? 0);
      buckets[idx].volume = toNumber(r.volume);
    }
  }
  const totalDeposits = buckets.reduce((a, b) => a + b.count, 0);
  const totalVolume = buckets.reduce((a, b) => a + b.volume, 0);
  for (const b of buckets) b.countShare = totalDeposits > 0 ? b.count / totalDeposits : 0;
  const largeBuckets = buckets.filter((b) => b.isLarge);
  const largeDepositCount = largeBuckets.reduce((a, b) => a + b.count, 0);
  const largeDepositVolume = largeBuckets.reduce((a, b) => a + b.volume, 0);

  return {
    buckets,
    totalDeposits,
    totalVolume,
    largeDepositCount,
    largeDepositVolume,
    largeDepositCountShare: totalDeposits > 0 ? largeDepositCount / totalDeposits : 0,
    largeDepositVolumeShare: totalVolume > 0 ? largeDepositVolume / totalVolume : 0,
    medianDepositUsd: medianRows[0]?.median_usd != null ? toNumber(medianRows[0].median_usd) : 0,
  };
}

// ─── 3. Cap-hitters with value contribution ────────────────────────

export async function getDepositBonusCapHittersFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<DepositBonusCapHitters> {
  const scope = depositBonusScopeCte(blacklist.length > 0);
  const cutoff = depositBonusCutoff(period, now);
  const baseParams: Record<string, unknown> = { blacklist, cutoff };

  const capRows = await clickhouseRead.query<{ cap: string | null }>({
    queryName: "insights.deposit_bonus.impact.cap_hitters.cap",
    sql: `WITH ${scope}
      SELECT toString(max(abs(lt.amount))) AS cap
      FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
      WHERE lt._peerdb_is_deleted = 0 AND lt.status = 'completed' AND lt.type = 'deposit_bonus'
        AND lt.user_id IN (SELECT id FROM real_users) ${cutoffClause(cutoff, "lt")}`,
    params: baseParams,
  });
  const capValue = capRows[0]?.cap != null ? toNumber(capRows[0].cap) : 0;
  if (capValue <= 0) {
    return {
      capValue: 0,
      distinctCapHitters: 0,
      totalDepositors: 0,
      capHitterShare: 0,
      combinedWager: 0,
      combinedGgr: 0,
      totalDepositorWager: 0,
      wagerShare: 0,
      rows: [],
    };
  }
  const capLiteral = capValue.toFixed(2);
  const params = { ...baseParams, cap: capLiteral };

  const [denomRows, hitterRows, combinedRows] = await Promise.all([
    clickhouseRead.query<{ depositors: string; depositor_wager: string }>({
      queryName: "insights.deposit_bonus.impact.cap_hitters.denom",
      sql: `WITH ${scope},
        depositors AS (
          SELECT DISTINCT lt.user_id AS user_id
          FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
          WHERE lt._peerdb_is_deleted = 0 AND lt.status = 'completed' AND lt.type = 'deposit'
            AND lt.user_id IN (SELECT id FROM real_users) ${cutoffClause(cutoff, "lt")}
        )
        SELECT
          toString((SELECT count() FROM depositors)) AS depositors,
          toString((
            SELECT sum(abs(w.amount))
            FROM ${CH_DB}.public_ledger_transactions AS w FINAL
            WHERE w._peerdb_is_deleted = 0 AND w.status = 'completed' AND w.type IN ${WAGER_TYPES}
              AND w.user_id IN (SELECT user_id FROM depositors) ${cutoffClause(cutoff, "w")}
          )) AS depositor_wager`,
      params,
      timeoutMs: 30_000,
    }),
    clickhouseRead.query<{
      user_id: string;
      username: string | null;
      cap_hits: string;
      bonus_total: string;
      deposit_total: string;
      wager_total: string;
      payout_total: string;
    }>({
      queryName: "insights.deposit_bonus.impact.cap_hitters.rows",
      sql: `WITH ${scope},
        cap_hitters AS (
          SELECT lt.user_id AS user_id, count() AS cap_hits
          FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
          WHERE lt._peerdb_is_deleted = 0 AND lt.status = 'completed' AND lt.type = 'deposit_bonus'
            AND lt.user_id IN (SELECT id FROM real_users)
            AND abs(lt.amount) = toDecimal128({cap:String}, 2) ${cutoffClause(cutoff, "lt")}
          GROUP BY lt.user_id
        ),
        bonus_window AS (
          SELECT lt.user_id AS user_id, sum(abs(lt.amount)) AS bonus_total
          FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
          WHERE lt._peerdb_is_deleted = 0 AND lt.status = 'completed' AND lt.type = 'deposit_bonus'
            AND lt.user_id IN (SELECT user_id FROM cap_hitters) ${cutoffClause(cutoff, "lt")}
          GROUP BY lt.user_id
        ),
        deposit_window AS (
          SELECT lt.user_id AS user_id, sum(abs(lt.amount)) AS deposit_total
          FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
          WHERE lt._peerdb_is_deleted = 0 AND lt.status = 'completed' AND lt.type = 'deposit'
            AND lt.user_id IN (SELECT user_id FROM cap_hitters) ${cutoffClause(cutoff, "lt")}
          GROUP BY lt.user_id
        ),
        wager_window AS (
          SELECT lt.user_id AS user_id, sum(abs(lt.amount)) AS wager_total
          FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
          WHERE lt._peerdb_is_deleted = 0 AND lt.status = 'completed' AND lt.type IN ${WAGER_TYPES}
            AND lt.user_id IN (SELECT user_id FROM cap_hitters) ${cutoffClause(cutoff, "lt")}
          GROUP BY lt.user_id
        ),
        payout_window AS (
          SELECT lt.user_id AS user_id, sum(abs(lt.amount)) AS payout_total
          FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
          WHERE lt._peerdb_is_deleted = 0 AND lt.status = 'completed' AND lt.type IN ${PAYOUT_TYPES}
            AND lt.user_id IN (SELECT user_id FROM cap_hitters) ${cutoffClause(cutoff, "lt")}
          GROUP BY lt.user_id
        )
        SELECT
          ch.user_id AS user_id,
          u.username AS username,
          toString(ch.cap_hits) AS cap_hits,
          toString(coalesce(bw.bonus_total, toDecimal128(0, 2))) AS bonus_total,
          toString(coalesce(dw.deposit_total, toDecimal128(0, 2))) AS deposit_total,
          toString(coalesce(ww.wager_total, toDecimal128(0, 2))) AS wager_total,
          toString(coalesce(pw.payout_total, toDecimal128(0, 2))) AS payout_total
        FROM cap_hitters AS ch
        INNER JOIN ${CH_DB}.public_user AS u FINAL ON u.id = ch.user_id
        LEFT JOIN bonus_window AS bw ON bw.user_id = ch.user_id
        LEFT JOIN deposit_window AS dw ON dw.user_id = ch.user_id
        LEFT JOIN wager_window AS ww ON ww.user_id = ch.user_id
        LEFT JOIN payout_window AS pw ON pw.user_id = ch.user_id
        WHERE u._peerdb_is_deleted = 0
        ORDER BY (coalesce(ww.wager_total, toDecimal128(0, 2)) - coalesce(pw.payout_total, toDecimal128(0, 2))) DESC, ch.user_id ASC
        LIMIT ${CAP_HITTER_LIMIT}`,
      params,
      timeoutMs: 30_000,
    }),
    clickhouseRead.query<{
      distinct_hitters: string;
      combined_wager: string;
      combined_payout: string;
    }>({
      queryName: "insights.deposit_bonus.impact.cap_hitters.combined",
      sql: `WITH ${scope},
        cap_hitters AS (
          SELECT DISTINCT lt.user_id AS user_id
          FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
          WHERE lt._peerdb_is_deleted = 0 AND lt.status = 'completed' AND lt.type = 'deposit_bonus'
            AND lt.user_id IN (SELECT id FROM real_users)
            AND abs(lt.amount) = toDecimal128({cap:String}, 2) ${cutoffClause(cutoff, "lt")}
        )
        SELECT
          toString((SELECT count() FROM cap_hitters)) AS distinct_hitters,
          toString((
            SELECT sum(abs(w.amount)) FROM ${CH_DB}.public_ledger_transactions AS w FINAL
            WHERE w._peerdb_is_deleted = 0 AND w.status = 'completed' AND w.type IN ${WAGER_TYPES}
              AND w.user_id IN (SELECT user_id FROM cap_hitters) ${cutoffClause(cutoff, "w")}
          )) AS combined_wager,
          toString((
            SELECT sum(abs(p.amount)) FROM ${CH_DB}.public_ledger_transactions AS p FINAL
            WHERE p._peerdb_is_deleted = 0 AND p.status = 'completed' AND p.type IN ${PAYOUT_TYPES}
              AND p.user_id IN (SELECT user_id FROM cap_hitters) ${cutoffClause(cutoff, "p")}
          )) AS combined_payout`,
      params,
      timeoutMs: 30_000,
    }),
  ]);

  const totalDepositors = Number(denomRows[0]?.depositors ?? 0);
  const totalDepositorWager = toNumber(denomRows[0]?.depositor_wager);
  const distinctCapHitters = Number(combinedRows[0]?.distinct_hitters ?? 0);
  const combinedWager = toNumber(combinedRows[0]?.combined_wager);
  const combinedPayout = toNumber(combinedRows[0]?.combined_payout);
  const combinedGgr = combinedWager - combinedPayout;

  const rows: CapHitterRow[] = hitterRows.map((r) => {
    const wagerTotal = toNumber(r.wager_total);
    const payoutTotal = toNumber(r.payout_total);
    const capHits = Number(r.cap_hits ?? 0);
    return {
      userId: r.user_id,
      username: r.username,
      capHits,
      frequent: capHits > 1,
      depositTotal: toNumber(r.deposit_total),
      wagerTotal,
      payoutTotal,
      ggrContribution: wagerTotal - payoutTotal,
      bonusTotal: toNumber(r.bonus_total),
    };
  });

  return {
    capValue,
    distinctCapHitters,
    totalDepositors,
    capHitterShare: totalDepositors > 0 ? distinctCapHitters / totalDepositors : 0,
    combinedWager,
    combinedGgr,
    totalDepositorWager,
    wagerShare: totalDepositorWager > 0 ? combinedWager / totalDepositorWager : 0,
    rows,
  };
}

// ─── 4. Time between deposits ──────────────────────────────────────

export async function getDepositBonusTimeBetweenFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<DepositBonusTimeBetween> {
  const scope = depositBonusScopeCte(blacklist.length > 0);
  const cutoff = depositBonusCappedCutoff(period, now);
  const params = { blacklist, cutoff };
  const gapsCte = `
    ${scope},
    ordered AS (
      SELECT
        lt.created_at AS created_at,
        lagInFrame(lt.created_at, 1) OVER w AS prev_at,
        row_number() OVER w AS rn
      FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
      WHERE lt._peerdb_is_deleted = 0 AND lt.status = 'completed' AND lt.type = 'deposit'
        AND lt.user_id IN (SELECT id FROM real_users)
        AND lt.created_at >= {cutoff:DateTime64(6)}
      WINDOW w AS (PARTITION BY lt.user_id ORDER BY lt.created_at ROWS BETWEEN 1 PRECEDING AND CURRENT ROW)
    ),
    gaps AS (
      SELECT (toUnixTimestamp64Micro(created_at) - toUnixTimestamp64Micro(prev_at)) / 60000000.0 AS gap_minutes
      FROM ordered WHERE rn > 1
    )`;

  const [bucketRows, statRows] = await Promise.all([
    clickhouseRead.query<{ bucket: string; cnt: string }>({
      queryName: "insights.deposit_bonus.impact.time_between.buckets",
      sql: `WITH ${gapsCte}
        SELECT toString(multiIf(gap_minutes < 30, 0, gap_minutes < 120, 1, gap_minutes < 360, 2, gap_minutes < 1440, 3, 4)) AS bucket,
               toString(count()) AS cnt
        FROM gaps GROUP BY bucket ORDER BY bucket`,
      params,
      timeoutMs: 30_000,
    }),
    clickhouseRead.query<{
      total_gaps: string;
      median_min: string | null;
      p25_min: string | null;
      p75_min: string | null;
      intra_day: string;
    }>({
      queryName: "insights.deposit_bonus.impact.time_between.stats",
      sql: `WITH ${gapsCte}
        SELECT toString(count()) AS total_gaps,
               toString(quantileExactInclusive(0.5)(gap_minutes)) AS median_min,
               toString(quantileExactInclusive(0.25)(gap_minutes)) AS p25_min,
               toString(quantileExactInclusive(0.75)(gap_minutes)) AS p75_min,
               toString(countIf(gap_minutes < 1440)) AS intra_day
        FROM gaps`,
      params,
      timeoutMs: 30_000,
    }),
  ]);

  const buckets: TimeGapBucket[] = GAP_BUCKETS.map((b) => ({
    label: b.label,
    minMinutes: b.min,
    maxMinutes: b.max === Number.MAX_SAFE_INTEGER ? Number.POSITIVE_INFINITY : b.max,
    count: 0,
    share: 0,
  }));
  for (const r of bucketRows) {
    const idx = Number(r.bucket);
    if (idx >= 0 && idx < buckets.length) buckets[idx].count = Number(r.cnt ?? 0);
  }
  const stats = statRows[0];
  const totalGaps = Number(stats?.total_gaps ?? 0);
  const intraDay = Number(stats?.intra_day ?? 0);
  for (const b of buckets) b.share = totalGaps > 0 ? b.count / totalGaps : 0;

  return {
    buckets,
    totalGaps,
    medianGapMinutes: stats?.median_min != null ? toNumber(stats.median_min) : 0,
    p25GapMinutes: stats?.p25_min != null ? toNumber(stats.p25_min) : 0,
    p75GapMinutes: stats?.p75_min != null ? toNumber(stats.p75_min) : 0,
    intraDayShare: totalGaps > 0 ? intraDay / totalGaps : 0,
  };
}

// ─── 5. Bonus-to-wager segments ────────────────────────────────────

export async function getDepositBonusToWagerSegmentsFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<DepositBonusToWagerSegments> {
  const scope = depositBonusScopeCte(blacklist.length > 0);
  const cutoff = depositBonusCutoff(period, now);
  const params = { blacklist, cutoff };

  const rows = await clickhouseRead.query<{
    segment: string;
    users: string;
    total_bonus: string;
    total_wager: string;
  }>({
    queryName: "insights.deposit_bonus.impact.bonus_wager_segments",
    sql: `WITH ${scope},
      per_user AS (
        SELECT d.user_id AS user_id, sum(abs(d.amount)) AS deposit_total
        FROM ${CH_DB}.public_ledger_transactions AS d FINAL
        WHERE d._peerdb_is_deleted = 0 AND d.status = 'completed' AND d.type = 'deposit'
          AND d.user_id IN (SELECT id FROM real_users) ${cutoffClause(cutoff, "d")}
        GROUP BY d.user_id
      ),
      bonus_window AS (
        SELECT lt.user_id AS user_id, sum(abs(lt.amount)) AS bonus_total
        FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
        WHERE lt._peerdb_is_deleted = 0 AND lt.status = 'completed' AND lt.type = 'deposit_bonus'
          AND lt.user_id IN (SELECT user_id FROM per_user) ${cutoffClause(cutoff, "lt")}
        GROUP BY lt.user_id
      ),
      wager_window AS (
        SELECT lt.user_id AS user_id, sum(abs(lt.amount)) AS wager_total
        FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
        WHERE lt._peerdb_is_deleted = 0 AND lt.status = 'completed' AND lt.type IN ${WAGER_TYPES}
          AND lt.user_id IN (SELECT user_id FROM per_user) ${cutoffClause(cutoff, "lt")}
        GROUP BY lt.user_id
      )
      SELECT
        toString(multiIf(pu.deposit_total < 100, 0, pu.deposit_total < 500, 1, pu.deposit_total < 2000, 2, 3)) AS segment,
        toString(count()) AS users,
        toString(sum(coalesce(bw.bonus_total, toDecimal128(0, 2)))) AS total_bonus,
        toString(sum(coalesce(ww.wager_total, toDecimal128(0, 2)))) AS total_wager
      FROM per_user AS pu
      LEFT JOIN bonus_window AS bw ON bw.user_id = pu.user_id
      LEFT JOIN wager_window AS ww ON ww.user_id = pu.user_id
      GROUP BY segment ORDER BY segment`,
    params,
    timeoutMs: 30_000,
  });

  const SEGMENT_LABELS = ["<$100", "$100–500", "$500–2K", "$2K+"];
  const segments: BonusWagerSegment[] = SEGMENT_LABELS.map((label) => ({
    label,
    users: 0,
    avgBonus: 0,
    avgWager: 0,
    subsidyRatio: null,
  }));
  for (const r of rows) {
    const idx = Number(r.segment);
    if (idx < 0 || idx >= segments.length) continue;
    const users = Number(r.users ?? 0);
    const totalBonus = toNumber(r.total_bonus);
    const totalWager = toNumber(r.total_wager);
    const avgBonus = users > 0 ? totalBonus / users : 0;
    const avgWager = users > 0 ? totalWager / users : 0;
    segments[idx] = {
      label: segments[idx].label,
      users,
      avgBonus,
      avgWager,
      subsidyRatio: avgWager > 0 ? avgBonus / avgWager : null,
    };
  }
  return { segments };
}

// ─── 6. Post-cap behaviour ─────────────────────────────────────────

export async function getDepositBonusPostCapBehaviorFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<DepositBonusPostCapBehavior> {
  const scope = depositBonusScopeCte(blacklist.length > 0);
  const cutoff = depositBonusCutoff(period, now);
  const depositCutoff = depositBonusCappedCutoff(period, now);
  const baseParams: Record<string, unknown> = { blacklist, cutoff, depositCutoff };

  const capRows = await clickhouseRead.query<{ cap: string | null }>({
    queryName: "insights.deposit_bonus.impact.post_cap.cap",
    sql: `WITH ${scope}
      SELECT toString(max(abs(lt.amount))) AS cap
      FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
      WHERE lt._peerdb_is_deleted = 0 AND lt.status = 'completed' AND lt.type = 'deposit_bonus'
        AND lt.user_id IN (SELECT id FROM real_users) ${cutoffClause(cutoff, "lt")}`,
    params: baseParams,
  });
  const capValue = capRows[0]?.cap != null ? toNumber(capRows[0].cap) : 0;
  if (capValue <= 0) {
    return {
      capValue: 0,
      capHitters: 0,
      keptDepositing: 0,
      stopped: 0,
      postCapDepositsNoBonus: 0,
      postCapDepositsTotal: 0,
    };
  }
  const capLiteral = capValue.toFixed(2);
  const params = { ...baseParams, cap: capLiteral };

  const rows = await clickhouseRead.query<{
    cap_hitters: string;
    kept: string;
    stopped: string;
    post_total: string;
    post_no_bonus: string;
  }>({
    queryName: "insights.deposit_bonus.impact.post_cap.stats",
    sql: `WITH ${scope},
      first_cap AS (
        SELECT lt.user_id AS user_id, min(lt.created_at) AS first_cap_at
        FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
        WHERE lt._peerdb_is_deleted = 0 AND lt.status = 'completed' AND lt.type = 'deposit_bonus'
          AND lt.user_id IN (SELECT id FROM real_users)
          AND abs(lt.amount) = toDecimal128({cap:String}, 2) ${cutoffClause(cutoff, "lt")}
        GROUP BY lt.user_id
      ),
      post_deposits AS (
        SELECT fc.user_id AS user_id, d.id AS deposit_id, d.balance_after AS bal_after, d.created_at AS created_at
        FROM first_cap AS fc
        INNER JOIN ${CH_DB}.public_ledger_transactions AS d FINAL ON d.user_id = fc.user_id
        WHERE d._peerdb_is_deleted = 0 AND d.status = 'completed' AND d.type = 'deposit'
          AND d.created_at > fc.first_cap_at
          AND d.created_at >= {depositCutoff:DateTime64(6)}
      ),
      bon_rows AS (
        SELECT b.user_id AS user_id, b.balance_before AS bal_before, b.created_at AS created_at
        FROM ${CH_DB}.public_ledger_transactions AS b FINAL
        WHERE b._peerdb_is_deleted = 0 AND b.status = 'completed' AND b.type = 'deposit_bonus'
      ),
      post_paired AS (
        SELECT pd.user_id AS user_id, pd.deposit_id AS deposit_id,
          max(if(b.created_at >= pd.created_at AND b.created_at < pd.created_at + INTERVAL 30 SECOND, 1, 0)) AS got_bonus
        FROM post_deposits AS pd
        LEFT JOIN bon_rows AS b ON b.user_id = pd.user_id AND b.bal_before = pd.bal_after
        GROUP BY pd.user_id, pd.deposit_id
      )
      SELECT
        toString((SELECT count() FROM first_cap)) AS cap_hitters,
        toString((SELECT uniqExact(user_id) FROM post_deposits)) AS kept,
        toString((SELECT count() FROM first_cap WHERE user_id NOT IN (SELECT user_id FROM post_deposits))) AS stopped,
        toString((SELECT count() FROM post_paired)) AS post_total,
        toString((SELECT countIf(got_bonus = 0) FROM post_paired)) AS post_no_bonus`,
    params,
    timeoutMs: 30_000,
  });

  const r = rows[0];
  return {
    capValue,
    capHitters: Number(r?.cap_hitters ?? 0),
    keptDepositing: Number(r?.kept ?? 0),
    stopped: Number(r?.stopped ?? 0),
    postCapDepositsNoBonus: Number(r?.post_no_bonus ?? 0),
    postCapDepositsTotal: Number(r?.post_total ?? 0),
  };
}

// ─── 7. Cap-hitter cohorts (new vs returning) ──────────────────────

export async function getDepositBonusCapHitterCohortsFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<DepositBonusCapHitterCohorts> {
  const scope = depositBonusScopeCte(blacklist.length > 0);
  const cutoff = depositBonusCutoff(period, now);
  const windowStart = depositBonusCutoff(period, now);
  const baseParams: Record<string, unknown> = { blacklist, cutoff };

  const capRows = await clickhouseRead.query<{ cap: string | null }>({
    queryName: "insights.deposit_bonus.impact.cohorts.cap",
    sql: `WITH ${scope}
      SELECT toString(max(abs(lt.amount))) AS cap
      FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
      WHERE lt._peerdb_is_deleted = 0 AND lt.status = 'completed' AND lt.type = 'deposit_bonus'
        AND lt.user_id IN (SELECT id FROM real_users) ${cutoffClause(cutoff, "lt")}`,
    params: baseParams,
  });
  const capValue = capRows[0]?.cap != null ? toNumber(capRows[0].cap) : 0;
  const empty = { users: 0, capHits: 0, depositTotal: 0, wagerTotal: 0 };
  if (capValue <= 0) {
    return { capValue: 0, newCohort: { ...empty }, returningCohort: { ...empty } };
  }
  const capLiteral = capValue.toFixed(2);
  const params: Record<string, unknown> = { ...baseParams, cap: capLiteral };
  // PG: `u.created_at >= windowStart` → on lifetime windowStart is -infinity,
  // so the predicate is always TRUE → every hitter classifies as 'new'.
  let cohortExpr: string;
  if (windowStart !== null) {
    cohortExpr = "if(u.created_at >= {windowStart:DateTime64(6)}, 'new', 'returning')";
    params.windowStart = windowStart;
  } else {
    cohortExpr = "'new'";
  }

  const rows = await clickhouseRead.query<{
    cohort: "new" | "returning";
    users: string;
    cap_hits: string;
    deposit_total: string;
    wager_total: string;
  }>({
    queryName: "insights.deposit_bonus.impact.cohorts.split",
    sql: `WITH ${scope},
      cap_hitters AS (
        SELECT lt.user_id AS user_id, count() AS cap_hits
        FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
        WHERE lt._peerdb_is_deleted = 0 AND lt.status = 'completed' AND lt.type = 'deposit_bonus'
          AND lt.user_id IN (SELECT id FROM real_users)
          AND abs(lt.amount) = toDecimal128({cap:String}, 2) ${cutoffClause(cutoff, "lt")}
        GROUP BY lt.user_id
      ),
      classified AS (
        SELECT ch.user_id AS user_id, ch.cap_hits AS cap_hits, ${cohortExpr} AS cohort
        FROM cap_hitters AS ch
        INNER JOIN ${CH_DB}.public_user AS u FINAL ON u.id = ch.user_id
        WHERE u._peerdb_is_deleted = 0
      ),
      deposit_window AS (
        SELECT lt.user_id AS user_id, sum(abs(lt.amount)) AS deposit_total
        FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
        WHERE lt._peerdb_is_deleted = 0 AND lt.status = 'completed' AND lt.type = 'deposit'
          AND lt.user_id IN (SELECT user_id FROM classified) ${cutoffClause(cutoff, "lt")}
        GROUP BY lt.user_id
      ),
      wager_window AS (
        SELECT lt.user_id AS user_id, sum(abs(lt.amount)) AS wager_total
        FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
        WHERE lt._peerdb_is_deleted = 0 AND lt.status = 'completed' AND lt.type IN ${WAGER_TYPES}
          AND lt.user_id IN (SELECT user_id FROM classified) ${cutoffClause(cutoff, "lt")}
        GROUP BY lt.user_id
      )
      SELECT
        c.cohort AS cohort,
        toString(count()) AS users,
        toString(sum(c.cap_hits)) AS cap_hits,
        toString(sum(coalesce(dw.deposit_total, toDecimal128(0, 2)))) AS deposit_total,
        toString(sum(coalesce(ww.wager_total, toDecimal128(0, 2)))) AS wager_total
      FROM classified AS c
      LEFT JOIN deposit_window AS dw ON dw.user_id = c.user_id
      LEFT JOIN wager_window AS ww ON ww.user_id = c.user_id
      GROUP BY c.cohort`,
    params,
    timeoutMs: 30_000,
  });

  const parseSide = (cohort: "new" | "returning") => {
    const row = rows.find((r) => r.cohort === cohort);
    return {
      users: Number(row?.users ?? 0),
      capHits: Number(row?.cap_hits ?? 0),
      depositTotal: toNumber(row?.deposit_total),
      wagerTotal: toNumber(row?.wager_total),
    };
  };

  return {
    capValue,
    newCohort: parseSide("new"),
    returningCohort: parseSide("returning"),
  } satisfies DepositBonusCapHitterCohorts;
}
