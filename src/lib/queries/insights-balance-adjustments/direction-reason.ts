import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import {
  cacheTtlForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import {
  BALANCE_ADJ_CACHE_TAGS,
  ADJ_TYPE,
  getResolvedBlacklist,
  blacklistFilter,
  windowDateFilter,
  notOfficialStreamFilter,
} from "./_shared";

/**
 * Direction & Reason lens for /insights/balance-adjustments.
 *
 * Three blocks:
 *   1. Direction split — credits vs debits (volume, count, share).
 *   2. Reason breakdown — grouped by the free-text reason recovered from
 *      `description`. The write flows store the reason as
 *      `"Admin adjustment: <reason>"` or `"Manual withdrawal: <reason> …"`
 *      so we strip the known prefix to recover the label. Manual
 *      withdrawals are bucketed together under a synthetic
 *      "Manual withdrawal" reason because their description carries a
 *      trailing "(total $… …)" annotation that would shatter the grouping.
 *   3. Size distribution — fixed buckets of ABS(amount) so the page can
 *      draw a histogram of adjustment sizes.
 *
 * House-POV: credit rows (house gives) → rose; debit rows (house takes)
 * → emerald. Per-reason rows are tinted by their net direction.
 */

export type AdjustmentReasonRow = {
  /** Recovered reason label (or "Manual withdrawal" / "(no reason)"). */
  reason: string;
  /** True when this bucket is the manual-withdrawal subset. */
  isManualWithdrawal: boolean;
  creditVolume: number;
  debitVolume: number;
  /** Net signed (credit − debit) for the bucket. */
  net: number;
  count: number;
  uniqueUsers: number;
};

export type AdjustmentSizeBucket = {
  /** Inclusive lower bound (USD, absolute). */
  min: number;
  /** Exclusive upper bound, or null for the open-ended top bucket. */
  max: number | null;
  label: string;
  count: number;
  volume: number;
};

export type DirectionReason = {
  creditVolume: number;
  creditCount: number;
  debitVolume: number;
  debitCount: number;
  /** Top reasons by gross volume (capped). */
  reasons: AdjustmentReasonRow[];
  sizeBuckets: AdjustmentSizeBucket[];
};

// Fixed absolute-size buckets (USD). Mirrors the bucketing style used by
// the deposit-bonus cap histogram — chosen to cover typical manual
// adjustment magnitudes with a sensible open-ended top bucket.
const SIZE_BUCKETS: Array<{ min: number; max: number | null; label: string }> = [
  { min: 0, max: 10, label: "$0–10" },
  { min: 10, max: 50, label: "$10–50" },
  { min: 50, max: 100, label: "$50–100" },
  { min: 100, max: 500, label: "$100–500" },
  { min: 500, max: 1000, label: "$500–1k" },
  { min: 1000, max: 5000, label: "$1k–5k" },
  { min: 5000, max: null, label: "$5k+" },
];

async function computeDirectionReason(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<DirectionReason> {
  const db = await getDb();
  const dateFilter = windowDateFilter(period);
  const bl = blacklistFilter(blacklistIds);
  // FAKE-BALANCE: drop official_stream adjustments from every block.
  const notOfficialStream = notOfficialStreamFilter();

  // Reason grouping: classify manual-withdrawal rows into one synthetic
  // bucket, otherwise strip the "Admin adjustment: " prefix to recover
  // the admin's reason text. A NULL / unprefixed description falls back
  // to "(no reason)". Done in SQL with CASE so we group server-side.
  const reasonExpr = `
    CASE
      WHEN lt.description ILIKE 'Manual withdrawal:%' THEN '__manual_withdrawal__'
      WHEN lt.description ILIKE 'Admin adjustment: %'
        THEN NULLIF(TRIM(SUBSTRING(lt.description FROM 19)), '')
      ELSE NULL
    END
  `;

  const [directionRows, reasonRows, sizeRows] = await Promise.all([
    db.$queryRawUnsafe<
      {
        credit_vol: string;
        credit_cnt: string;
        debit_vol: string;
        debit_cnt: string;
      }[]
    >(`
      SELECT
        COALESCE(SUM(CASE WHEN lt.amount::numeric > 0 THEN lt.amount::numeric ELSE 0 END), 0)::text AS credit_vol,
        COUNT(*) FILTER (WHERE lt.amount::numeric > 0)::text AS credit_cnt,
        COALESCE(SUM(CASE WHEN lt.amount::numeric < 0 THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS debit_vol,
        COUNT(*) FILTER (WHERE lt.amount::numeric < 0)::text AS debit_cnt
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type = '${ADJ_TYPE}'
        ${notOfficialStream}
        ${bl}
        ${dateFilter}
    `),
    db.$queryRawUnsafe<
      {
        reason_key: string | null;
        credit_vol: string;
        debit_vol: string;
        cnt: string;
        users: string;
      }[]
    >(`
      SELECT
        ${reasonExpr} AS reason_key,
        COALESCE(SUM(CASE WHEN lt.amount::numeric > 0 THEN lt.amount::numeric ELSE 0 END), 0)::text AS credit_vol,
        COALESCE(SUM(CASE WHEN lt.amount::numeric < 0 THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS debit_vol,
        COUNT(*)::text AS cnt,
        COUNT(DISTINCT lt.user_id)::text AS users
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type = '${ADJ_TYPE}'
        ${notOfficialStream}
        ${bl}
        ${dateFilter}
      GROUP BY reason_key
      ORDER BY SUM(ABS(lt.amount::numeric)) DESC
      LIMIT 40
    `),
    db.$queryRawUnsafe<
      { bucket: string; cnt: string; vol: string }[]
    >(`
      WITH amts AS (
        SELECT ABS(lt.amount::numeric) AS abs_amt
        FROM ledger_transactions lt
        WHERE lt.status = 'completed'
          AND lt.type = '${ADJ_TYPE}'
          ${notOfficialStream}
          ${bl}
          ${dateFilter}
      )
      SELECT
        CASE
          WHEN abs_amt < 10 THEN '$0–10'
          WHEN abs_amt < 50 THEN '$10–50'
          WHEN abs_amt < 100 THEN '$50–100'
          WHEN abs_amt < 500 THEN '$100–500'
          WHEN abs_amt < 1000 THEN '$500–1k'
          WHEN abs_amt < 5000 THEN '$1k–5k'
          ELSE '$5k+'
        END AS bucket,
        COUNT(*)::text AS cnt,
        COALESCE(SUM(abs_amt), 0)::text AS vol
      FROM amts
      GROUP BY bucket
    `),
  ]);

  const dir = directionRows[0];
  const creditVolume = toNumber(dir?.credit_vol);
  const creditCount = Number(dir?.credit_cnt ?? 0);
  const debitVolume = toNumber(dir?.debit_vol);
  const debitCount = Number(dir?.debit_cnt ?? 0);

  const reasons: AdjustmentReasonRow[] = reasonRows.map((r) => {
    const isManual = r.reason_key === "__manual_withdrawal__";
    const credit = toNumber(r.credit_vol);
    const debit = toNumber(r.debit_vol);
    return {
      reason: isManual
        ? "Manual withdrawal"
        : (r.reason_key && r.reason_key.length > 0 ? r.reason_key : "(no reason)"),
      isManualWithdrawal: isManual,
      creditVolume: credit,
      debitVolume: debit,
      net: credit - debit,
      count: Number(r.cnt),
      uniqueUsers: Number(r.users),
    };
  });

  // Map bucket counts back onto the fixed bucket list so the histogram
  // always has every bar (zero-filled), in order.
  const bucketByLabel = new Map(
    sizeRows.map((r) => [r.bucket, { cnt: Number(r.cnt), vol: toNumber(r.vol) }]),
  );
  const sizeBuckets: AdjustmentSizeBucket[] = SIZE_BUCKETS.map((b) => {
    const hit = bucketByLabel.get(b.label);
    return {
      min: b.min,
      max: b.max,
      label: b.label,
      count: hit?.cnt ?? 0,
      volume: hit?.vol ?? 0,
    };
  });

  return {
    creditVolume,
    creditCount,
    debitVolume,
    debitCount,
    reasons,
    sizeBuckets,
  };
}

const cached = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeDirectionReason(period, blacklistIds),
  ["insights-balance-adjustments-direction-reason-v1"],
  { revalidate: 60, tags: [...BALANCE_ADJ_CACHE_TAGS] },
);

const cachedLifetime = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeDirectionReason(period, blacklistIds),
  ["insights-balance-adjustments-direction-reason-lifetime-v1"],
  { revalidate: 300, tags: [...BALANCE_ADJ_CACHE_TAGS] },
);

export async function getBalanceAdjustmentDirectionReason(
  period: InsightsRewardsPeriod,
): Promise<DirectionReason> {
  const blacklist = await getResolvedBlacklist();
  const ttl = cacheTtlForInsightsPeriod(period);
  return ttl >= 300
    ? cachedLifetime(period, blacklist)
    : cached(period, blacklist);
}
