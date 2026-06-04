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
 * By-User lens for /insights/balance-adjustments.
 *
 * Three lists, all from the ledger (`admin_balance_adjustment` rows):
 *   1. Top users RECEIVING credits — sum of positive amounts (house gave
 *      them money). Each links to /users/[id]. House-POV: rose.
 *   2. Top users DEBITED — sum of ABS(negative amounts) (house took back,
 *      incl. manual withdrawals). House-POV: emerald.
 *   3. Abnormal frequency — users with many adjustment EVENTS in the
 *      window (count ≥ threshold), surfaced as a potential anomaly
 *      (repeated manual top-ups to one account, etc.). Includes their
 *      net so the direction is visible.
 *
 * Blacklist-excluded (staff NOT excluded — see _shared.ts rationale).
 * Read-only. Cached per (period, blacklist).
 */

const TOP_LIMIT = 25;
/** Min adjustment-event count in window to flag a user as high-frequency. */
const FREQUENCY_FLAG_MIN = 5;

export type UserAdjustmentRow = {
  userId: string;
  username: string | null;
  creditVolume: number;
  debitVolume: number;
  /** credit − debit (>0 ⇒ net recipient of house money). */
  net: number;
  count: number;
  lastAt: string;
};

export type ByUser = {
  topCredited: UserAdjustmentRow[];
  topDebited: UserAdjustmentRow[];
  highFrequency: UserAdjustmentRow[];
};

async function computeByUser(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<ByUser> {
  const db = await getDb();
  const dateFilter = windowDateFilter(period);
  const bl = blacklistFilter(blacklistIds);
  // FAKE-BALANCE: drop official_stream adjustments from every slice.
  const notOfficialStream = notOfficialStreamFilter();

  // One per-user rollup CTE, reused for all three slices. Each row carries
  // credit / debit volume, count, net, and the last event timestamp.
  const baseCte = `
    WITH per_user AS (
      SELECT
        lt.user_id,
        COALESCE(SUM(CASE WHEN lt.amount::numeric > 0 THEN lt.amount::numeric ELSE 0 END), 0) AS credit_vol,
        COALESCE(SUM(CASE WHEN lt.amount::numeric < 0 THEN ABS(lt.amount::numeric) ELSE 0 END), 0) AS debit_vol,
        COALESCE(SUM(lt.amount::numeric), 0) AS net,
        COUNT(*)::int AS cnt,
        MAX(lt.created_at) AS last_at
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type = '${ADJ_TYPE}'
        ${notOfficialStream}
        ${bl}
        ${dateFilter}
      GROUP BY lt.user_id
    )
  `;

  type Raw = {
    user_id: string;
    username: string | null;
    credit_vol: string;
    debit_vol: string;
    net: string;
    cnt: string;
    last_at: Date;
  };

  const select = `
    SELECT
      pu.user_id,
      u.username,
      pu.credit_vol::text AS credit_vol,
      pu.debit_vol::text AS debit_vol,
      pu.net::text AS net,
      pu.cnt::text AS cnt,
      pu.last_at
    FROM per_user pu
    JOIN "user" u ON u.id = pu.user_id
  `;

  const [creditedRows, debitedRows, frequentRows] = await Promise.all([
    db.$queryRawUnsafe<Raw[]>(`
      ${baseCte}
      ${select}
      WHERE pu.credit_vol > 0
      ORDER BY pu.credit_vol DESC
      LIMIT ${TOP_LIMIT}
    `),
    db.$queryRawUnsafe<Raw[]>(`
      ${baseCte}
      ${select}
      WHERE pu.debit_vol > 0
      ORDER BY pu.debit_vol DESC
      LIMIT ${TOP_LIMIT}
    `),
    db.$queryRawUnsafe<Raw[]>(`
      ${baseCte}
      ${select}
      WHERE pu.cnt >= ${FREQUENCY_FLAG_MIN}
      ORDER BY pu.cnt DESC, pu.last_at DESC
      LIMIT ${TOP_LIMIT}
    `),
  ]);

  const map = (r: Raw): UserAdjustmentRow => ({
    userId: r.user_id,
    username: r.username,
    creditVolume: toNumber(r.credit_vol),
    debitVolume: toNumber(r.debit_vol),
    net: toNumber(r.net),
    count: Number(r.cnt),
    lastAt: new Date(r.last_at).toISOString(),
  });

  return {
    topCredited: creditedRows.map(map),
    topDebited: debitedRows.map(map),
    highFrequency: frequentRows.map(map),
  };
}

const cached = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeByUser(period, blacklistIds),
  ["insights-balance-adjustments-by-user-v1"],
  { revalidate: 60, tags: [...BALANCE_ADJ_CACHE_TAGS] },
);

const cachedLifetime = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeByUser(period, blacklistIds),
  ["insights-balance-adjustments-by-user-lifetime-v1"],
  { revalidate: 300, tags: [...BALANCE_ADJ_CACHE_TAGS] },
);

export async function getBalanceAdjustmentByUser(
  period: InsightsRewardsPeriod,
): Promise<ByUser> {
  const blacklist = await getResolvedBlacklist();
  const ttl = cacheTtlForInsightsPeriod(period);
  return ttl >= 300
    ? cachedLifetime(period, blacklist)
    : cached(period, blacklist);
}
