import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type { DepositBonusCapAnalysis } from "@/lib/queries/insights-rewards/deposit-bonus/cap-analysis";

import { CH_DB, toNumber } from "../../_shared";
import {
  cutoffClause,
  depositBonusCappedCutoff,
  depositBonusCutoff,
  depositBonusScopeCte,
} from "./_shared";

/**
 * ClickHouse twin of the full deposit-bonus cap analysis
 * (`getDepositBonusCapAnalysis` → `computeCapAnalysis` in
 * `src/lib/queries/insights-rewards/deposit-bonus/cap-analysis.ts`).
 *
 * Mirrors EXACTLY:
 *   • capValue            = MAX(ABS(amount))   type='deposit_bonus' (window)
 *   • capHits             = COUNT(*) WHERE ABS(amount)=cap
 *   • uniqueCapHitters    = COUNT(DISTINCT user_id) WHERE ABS(amount)=cap
 *   • dailyCapHitRate     = per-day bonuses + cap-hits (ORDER BY day ASC)
 *   • amountDistribution  = 8-bucket histogram, bucket = LEAST(7, FLOOR(amt*8/cap))
 *                           computed in integer cents (exact, no float drift)
 *   • topCapHitters       = top 10 cap-hitters by COUNT DESC, Σ|amount| DESC
 *   • biggestCapDeposits  = top 10 cap-paired deposits by deposit_usd DESC
 *
 * Window: the cap / hits / daily / histogram / top-hitters scans use the plain
 * `windowDateFilter` cutoff (unbounded on lifetime); the biggest-cap-deposit
 * balance-pairing uses the CAPPED cutoff (365d on lifetime), EXACTLY matching
 * the PG twin. 2-role customer scope + blacklist. Money Decimal end-to-end.
 *
 * Tie-breaks (§5c): top-hitters add `user_id ASC` and biggest-cap-deposits add
 * `id ASC` as a deterministic secondary so the ranked output is stable; the
 * parity script pins the same key on the PG side. Bucket boundaries match PG
 * by integer-cents division.
 */

const HISTOGRAM_BUCKETS = 8;
const TOP_LIMIT = 10;

function emptyAnalysis(): DepositBonusCapAnalysis {
  return {
    capValue: 0,
    capHits: 0,
    capHitRate: 0,
    uniqueCapHitters: 0,
    dailyCapHitRate: [],
    amountDistribution: [],
    topCapHitters: [],
    biggestCapDeposits: [],
  };
}

export async function getDepositBonusCapAnalysisFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<DepositBonusCapAnalysis> {
  const hasBlacklist = blacklist.length > 0;
  const scope = depositBonusScopeCte(hasBlacklist);
  const cutoff = depositBonusCutoff(period, now);
  const cappedCutoff = depositBonusCappedCutoff(period, now);
  const baseParams: Record<string, unknown> = { blacklist, cutoff };

  const capRows = await clickhouseRead.query<{ cap: string; cnt: string }>({
    queryName: "insights.deposit_bonus.cap_analysis.cap",
    sql: `
      WITH ${scope}
      SELECT toString(max(abs(lt.amount))) AS cap, toString(count()) AS cnt
      FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
      WHERE lt._peerdb_is_deleted = 0
        AND lt.status = 'completed'
        AND lt.type = 'deposit_bonus'
        AND lt.user_id IN (SELECT id FROM real_users)
        ${cutoffClause(cutoff, "lt")}`,
    params: baseParams,
  });

  const capValue = toNumber(capRows[0]?.cap ?? "0");
  const totalCount = Number(capRows[0]?.cnt ?? "0");
  if (capValue <= 0 || totalCount === 0) return emptyAnalysis();

  const capLiteral = capValue.toFixed(2);
  const capCents = Math.round(capValue * 100);
  const capParams = { ...baseParams, cap: capLiteral, capCents };

  const [hitsRows, dailyRows, histogramRows, topHittersRows, biggestRows] =
    await Promise.all([
      clickhouseRead.query<{ hits: string; hitters: string }>({
        queryName: "insights.deposit_bonus.cap_analysis.hits",
        sql: `
          WITH ${scope}
          SELECT toString(count()) AS hits, toString(uniqExact(lt.user_id)) AS hitters
          FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
          WHERE lt._peerdb_is_deleted = 0
            AND lt.status = 'completed'
            AND lt.type = 'deposit_bonus'
            AND lt.user_id IN (SELECT id FROM real_users)
            AND abs(lt.amount) = toDecimal128({cap:String}, 2)
            ${cutoffClause(cutoff, "lt")}`,
        params: capParams,
      }),
      clickhouseRead.query<{ day: string; bonuses: string; cap_hits: string }>({
        queryName: "insights.deposit_bonus.cap_analysis.daily",
        sql: `
          WITH ${scope}
          SELECT
            toString(toDate(lt.created_at)) AS day,
            toString(count())               AS bonuses,
            toString(countIf(abs(lt.amount) = toDecimal128({cap:String}, 2))) AS cap_hits
          FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
          WHERE lt._peerdb_is_deleted = 0
            AND lt.status = 'completed'
            AND lt.type = 'deposit_bonus'
            AND lt.user_id IN (SELECT id FROM real_users)
            ${cutoffClause(cutoff, "lt")}
          GROUP BY day
          ORDER BY day ASC`,
        params: capParams,
      }),
      clickhouseRead.query<{ bucket: string; cnt: string; volume: string }>({
        queryName: "insights.deposit_bonus.cap_analysis.histogram",
        sql: `
          WITH ${scope},
          bounded AS (
            SELECT abs(lt.amount) AS amt
            FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
            WHERE lt._peerdb_is_deleted = 0
              AND lt.status = 'completed'
              AND lt.type = 'deposit_bonus'
              AND lt.user_id IN (SELECT id FROM real_users)
              ${cutoffClause(cutoff, "lt")}
          )
          SELECT
            toString(least(${HISTOGRAM_BUCKETS - 1}, intDiv(toInt64(round(amt * 100)) * ${HISTOGRAM_BUCKETS}, {capCents:Int64}))) AS bucket,
            toString(count())        AS cnt,
            toString(sum(amt))       AS volume
          FROM bounded
          GROUP BY bucket
          ORDER BY bucket`,
        params: capParams,
      }),
      clickhouseRead.query<{
        user_id: string;
        username: string | null;
        hits: string;
        total_bonus: string;
        last_hit_at: string;
      }>({
        queryName: "insights.deposit_bonus.cap_analysis.top_hitters",
        sql: `
          WITH ${scope}
          SELECT
            lt.user_id                      AS user_id,
            u.username                      AS username,
            toString(count())               AS hits,
            toString(sum(abs(lt.amount)))   AS total_bonus,
            toString(max(lt.created_at))    AS last_hit_at
          FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
          INNER JOIN ${CH_DB}.public_user AS u FINAL ON u.id = lt.user_id
          WHERE lt._peerdb_is_deleted = 0
            AND u._peerdb_is_deleted = 0
            AND lt.status = 'completed'
            AND lt.type = 'deposit_bonus'
            AND lt.user_id IN (SELECT id FROM real_users)
            AND abs(lt.amount) = toDecimal128({cap:String}, 2)
            ${cutoffClause(cutoff, "lt")}
          GROUP BY lt.user_id, u.username
          ORDER BY count() DESC, sum(abs(lt.amount)) DESC, lt.user_id ASC
          LIMIT ${TOP_LIMIT}`,
        params: capParams,
      }),
      clickhouseRead.query<{
        user_id: string;
        username: string | null;
        deposit_usd: string;
        created_at: string;
      }>({
        queryName: "insights.deposit_bonus.cap_analysis.biggest_deposits",
        sql: `
          WITH ${scope},
          dep_rows AS (
            SELECT d.id AS id, d.user_id AS user_id, abs(d.amount) AS deposit_usd,
                   d.balance_after AS bal_after, d.created_at AS created_at
            FROM ${CH_DB}.public_ledger_transactions AS d FINAL
            WHERE d._peerdb_is_deleted = 0
              AND d.status = 'completed'
              AND d.type = 'deposit'
              AND d.user_id IN (SELECT id FROM real_users)
              AND d.created_at >= {cappedCutoff:DateTime64(6)}
          ),
          cap_bonus AS (
            SELECT b.user_id AS user_id, b.balance_before AS bal_before, b.created_at AS created_at
            FROM ${CH_DB}.public_ledger_transactions AS b FINAL
            WHERE b._peerdb_is_deleted = 0
              AND b.status = 'completed'
              AND b.type = 'deposit_bonus'
              AND abs(b.amount) = toDecimal128({cap:String}, 2)
              AND b.created_at >= {cappedCutoff:DateTime64(6)}
          ),
          matched AS (
            SELECT d.id AS id, d.user_id AS user_id, d.deposit_usd AS deposit_usd, d.created_at AS created_at
            FROM dep_rows AS d
            INNER JOIN cap_bonus AS b ON b.user_id = d.user_id AND b.bal_before = d.bal_after
            WHERE b.created_at >= d.created_at
              AND b.created_at < d.created_at + INTERVAL 30 SECOND
            GROUP BY d.id, d.user_id, d.deposit_usd, d.created_at
          )
          SELECT
            m.user_id                  AS user_id,
            u.username                 AS username,
            toString(m.deposit_usd)    AS deposit_usd,
            toString(m.created_at)     AS created_at
          FROM matched AS m
          INNER JOIN ${CH_DB}.public_user AS u FINAL ON u.id = m.user_id
          WHERE u._peerdb_is_deleted = 0
          ORDER BY m.deposit_usd DESC, m.id ASC
          LIMIT ${TOP_LIMIT}`,
        params: { ...capParams, cappedCutoff },
      }),
    ]);

  const capHits = Number(hitsRows[0]?.hits ?? "0");
  const uniqueCapHitters = Number(hitsRows[0]?.hitters ?? "0");
  const capHitRate = totalCount > 0 ? capHits / totalCount : 0;

  const dailyCapHitRate = dailyRows.map((r) => {
    const bonuses = Number(r.bonuses ?? 0);
    const hits = Number(r.cap_hits ?? 0);
    return {
      date: r.day,
      bonuses,
      capHits: hits,
      rate: bonuses > 0 ? hits / bonuses : 0,
    };
  });

  const bucketWidth = capValue / HISTOGRAM_BUCKETS;
  const histogramByIdx = new Map<number, { count: number; volume: number }>();
  for (const r of histogramRows) {
    const idx = Number(r.bucket);
    if (idx >= 0 && idx < HISTOGRAM_BUCKETS) {
      histogramByIdx.set(idx, {
        count: Number(r.cnt ?? 0),
        volume: toNumber(r.volume),
      });
    }
  }
  const amountDistribution = Array.from({ length: HISTOGRAM_BUCKETS }, (_, idx) => {
    const min = bucketWidth * idx;
    const max = bucketWidth * (idx + 1);
    const data = histogramByIdx.get(idx) ?? { count: 0, volume: 0 };
    return {
      label: `$${Math.round(min)}–${Math.round(max)}`,
      min,
      max,
      count: data.count,
      volume: data.volume,
    };
  });

  const topCapHitters = topHittersRows.map((r) => ({
    userId: r.user_id,
    username: r.username,
    capHits: Number(r.hits ?? 0),
    totalBonus: toNumber(r.total_bonus),
    lastHitAt: new Date(r.last_hit_at.replace(" ", "T") + "Z").toISOString(),
  }));

  const biggestCapDeposits = biggestRows.map((r) => ({
    userId: r.user_id,
    username: r.username,
    depositUsd: toNumber(r.deposit_usd),
    bonusUsd: capValue,
    createdAt: new Date(r.created_at.replace(" ", "T") + "Z").toISOString(),
  }));

  return {
    capValue,
    capHits,
    capHitRate,
    uniqueCapHitters,
    dailyCapHitRate,
    amountDistribution,
    topCapHitters,
    biggestCapDeposits,
  };
}
