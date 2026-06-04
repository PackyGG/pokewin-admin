import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { adminDb } from "@/lib/admin-db";
import { toNumber } from "@/lib/utils/decimal";
import {
  daysForInsightsPeriod,
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
import { OFFICIAL_STREAM_ADJUSTMENT_CATEGORY } from "@/lib/balance-adjustment-categories";

/**
 * Overview rollup for /insights/balance-adjustments.
 *
 * Drives the top KPI strip + daily volume chart on the Overview tab.
 * Includes prior-window comparison so the page can render a delta vs the
 * previous equal window (finite windows only — lifetime has no "prior").
 *
 * Source of truth: `ledger_transactions` rows with
 *   - status = 'completed'
 *   - type = 'admin_balance_adjustment'
 *   - user not blacklisted
 *
 * Credits (amount > 0) = house GIVES → rose. Debits (amount < 0) = house
 * TAKES → emerald. Net = credits − debits from the HOUSE liability angle:
 * we report `netUserGain` = sum(amount) (positive ⇒ users gained ⇒ house
 * paid out ⇒ rose).
 *
 * The distinct-admin count comes from the admin DB (`admin_audit_events`),
 * the only place admin attribution is recorded — see `by-admin.ts` for
 * the full reasoning.
 */

export type BalanceAdjustmentOverview = {
  /** Sum of positive amounts (money the house gave users). */
  creditVolume: number;
  /** Number of credit rows. */
  creditCount: number;
  /** Sum of ABS(negative amounts) (money the house took back). */
  debitVolume: number;
  /** Number of debit rows. */
  debitCount: number;
  /** Total movement = creditVolume + debitVolume. */
  grossVolume: number;
  /** Net signed = creditVolume − debitVolume (>0 ⇒ net payout to users). */
  netUserGain: number;
  /** Total adjustment rows in the window. */
  count: number;
  /** Distinct users affected. */
  uniqueUsers: number;
  /** Distinct admins who adjusted (from admin_audit_events). */
  uniqueAdmins: number;
  /** Avg absolute adjustment size = grossVolume / count. */
  avgSize: number;
  /** Median absolute adjustment size. */
  medianSize: number;
  /** Largest single absolute adjustment. */
  maxSize: number;
  /** Daily series (ASC) split by direction. */
  daily: Array<{
    date: string;
    creditVolume: number;
    debitVolume: number;
    count: number;
  }>;
  /** Prior equal window — null for lifetime. */
  priorWindow: {
    grossVolume: number;
    netUserGain: number;
    count: number;
    uniqueUsers: number;
    grossDelta: number | null;
    countDelta: number | null;
    userDelta: number | null;
  } | null;
};

async function computeOverview(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<BalanceAdjustmentOverview> {
  const db = await getDb();
  const days = daysForInsightsPeriod(period);
  const dateFilter = windowDateFilter(period);
  const bl = blacklistFilter(blacklistIds);
  // FAKE-BALANCE: drop official_stream adjustments from every lens.
  const notOfficialStream = notOfficialStreamFilter();

  const [rollupRows, dailyRows] = await Promise.all([
    db.$queryRawUnsafe<
      {
        credit_vol: string;
        credit_cnt: string;
        debit_vol: string;
        debit_cnt: string;
        cnt: string;
        users: string;
        median_abs: string | null;
        max_abs: string | null;
      }[]
    >(`
      SELECT
        COALESCE(SUM(CASE WHEN lt.amount::numeric > 0 THEN lt.amount::numeric ELSE 0 END), 0)::text AS credit_vol,
        COUNT(*) FILTER (WHERE lt.amount::numeric > 0)::text AS credit_cnt,
        COALESCE(SUM(CASE WHEN lt.amount::numeric < 0 THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS debit_vol,
        COUNT(*) FILTER (WHERE lt.amount::numeric < 0)::text AS debit_cnt,
        COUNT(*)::text AS cnt,
        COUNT(DISTINCT lt.user_id)::text AS users,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ABS(lt.amount::numeric))::text AS median_abs,
        MAX(ABS(lt.amount::numeric))::text AS max_abs
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type = '${ADJ_TYPE}'
        ${notOfficialStream}
        ${bl}
        ${dateFilter}
    `),
    db.$queryRawUnsafe<
      { date: Date; credit_vol: string; debit_vol: string; cnt: string }[]
    >(`
      SELECT
        DATE(lt.created_at) AS date,
        COALESCE(SUM(CASE WHEN lt.amount::numeric > 0 THEN lt.amount::numeric ELSE 0 END), 0)::text AS credit_vol,
        COALESCE(SUM(CASE WHEN lt.amount::numeric < 0 THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS debit_vol,
        COUNT(*)::text AS cnt
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type = '${ADJ_TYPE}'
        ${notOfficialStream}
        ${bl}
        ${dateFilter}
      GROUP BY DATE(lt.created_at)
      ORDER BY date ASC
    `),
  ]);

  const rollup = rollupRows[0];
  const creditVolume = toNumber(rollup?.credit_vol);
  const creditCount = Number(rollup?.credit_cnt ?? 0);
  const debitVolume = toNumber(rollup?.debit_vol);
  const debitCount = Number(rollup?.debit_cnt ?? 0);
  const count = Number(rollup?.cnt ?? 0);
  const uniqueUsers = Number(rollup?.users ?? 0);
  const medianSize = rollup?.median_abs != null ? toNumber(rollup.median_abs) : 0;
  const maxSize = rollup?.max_abs != null ? toNumber(rollup.max_abs) : 0;
  const grossVolume = creditVolume + debitVolume;
  const netUserGain = creditVolume - debitVolume;
  const avgSize = count > 0 ? grossVolume / count : 0;

  const daily = dailyRows.map((r) => ({
    date: new Date(r.date).toISOString().split("T")[0],
    creditVolume: toNumber(r.credit_vol),
    debitVolume: toNumber(r.debit_vol),
    count: Number(r.cnt),
  }));

  // Distinct adjusting admins — from the admin DB audit trail (the only
  // record of WHO adjusted; ledger rows carry no admin id). Both the
  // general adjustment and the manual-withdrawal flow audit-log, so this
  // covers every adjustment class.
  const auditWhere = {
    event_type: { in: ["balance_adjustment", "manual_withdrawal_recorded"] },
    ...(days !== null
      ? { created_at: { gte: new Date(Date.now() - days * 86_400_000) } }
      : {}),
    admin_user_id: { not: null },
    // FAKE-BALANCE: drop official_stream adjustments — the writer stamps
    // `metadata.category` on the admin-DB audit event (actions.ts), so the
    // hidden category never inflates the distinct-admin count.
    NOT: {
      metadata: {
        path: ["category"],
        equals: OFFICIAL_STREAM_ADJUSTMENT_CATEGORY,
      },
    },
  };
  const adminGroups = await adminDb.admin_audit_events.findMany({
    where: auditWhere,
    select: { admin_user_id: true },
    distinct: ["admin_user_id"],
  });
  const uniqueAdmins = adminGroups.length;

  // Prior window — finite periods only. Same status / type / scope.
  let priorWindow: BalanceAdjustmentOverview["priorWindow"] = null;
  if (days !== null) {
    const priorRows = await db.$queryRawUnsafe<
      { gross: string; net: string; cnt: string; users: string }[]
    >(`
      SELECT
        COALESCE(SUM(ABS(lt.amount::numeric)), 0)::text AS gross,
        COALESCE(SUM(lt.amount::numeric), 0)::text AS net,
        COUNT(*)::text AS cnt,
        COUNT(DISTINCT lt.user_id)::text AS users
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type = '${ADJ_TYPE}'
        ${notOfficialStream}
        ${bl}
        AND lt.created_at >= NOW() - INTERVAL '${days * 2} days'
        AND lt.created_at < NOW() - INTERVAL '${days} days'
    `);
    const prev = priorRows[0];
    const prevGross = toNumber(prev?.gross);
    const prevNet = toNumber(prev?.net);
    const prevCount = Number(prev?.cnt ?? 0);
    const prevUsers = Number(prev?.users ?? 0);
    const delta = (now: number, prior: number): number | null =>
      prior > 0 ? (now - prior) / prior : null;
    priorWindow = {
      grossVolume: prevGross,
      netUserGain: prevNet,
      count: prevCount,
      uniqueUsers: prevUsers,
      grossDelta: delta(grossVolume, prevGross),
      countDelta: delta(count, prevCount),
      userDelta: delta(uniqueUsers, prevUsers),
    };
  }

  return {
    creditVolume,
    creditCount,
    debitVolume,
    debitCount,
    grossVolume,
    netUserGain,
    count,
    uniqueUsers,
    uniqueAdmins,
    avgSize,
    medianSize,
    maxSize,
    daily,
    priorWindow,
  };
}

const cachedOverview = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeOverview(period, blacklistIds),
  ["insights-balance-adjustments-overview-v1"],
  { revalidate: 60, tags: [...BALANCE_ADJ_CACHE_TAGS] },
);

const cachedOverviewLifetime = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeOverview(period, blacklistIds),
  ["insights-balance-adjustments-overview-lifetime-v1"],
  { revalidate: 300, tags: [...BALANCE_ADJ_CACHE_TAGS] },
);

export async function getBalanceAdjustmentOverview(
  period: InsightsRewardsPeriod,
): Promise<BalanceAdjustmentOverview> {
  const blacklist = await getResolvedBlacklist();
  const ttl = cacheTtlForInsightsPeriod(period);
  return ttl >= 300
    ? cachedOverviewLifetime(period, blacklist)
    : cachedOverview(period, blacklist);
}
