import { toNumber } from "@/lib/utils/decimal";

/**
 * Pure, engine-agnostic CRM snapshot types + bucketing. Imports NOTHING from a
 * read engine (no Postgres, no ClickHouse), so both the Postgres path
 * (src/lib/queries/crm.ts) and the ClickHouse comparison layer
 * (src/lib/clickhouse/comparison.ts) can share `bucketCrmSnapshot` without an
 * import cycle. The only difference between the two read paths is WHERE the
 * per-customer rows come from — the bucketing is identical here.
 */

const NEW_CUSTOMER_DAYS = 30;
const DORMANT_WHALE_MIN_DEPOSITS = 1000;
const DORMANT_WHALE_MIN_RECENCY_DAYS = 30;
const DORMANT_WHALE_LIMIT = 15;
const TOP_VALUE_LIMIT = 20;

export type LifecycleKey = "active" | "at_risk" | "dormant" | "churned";
export type VipTierKey =
  | "diamond"
  | "platinum"
  | "gold"
  | "silver"
  | "bronze";

export type CrmSegmentRow = {
  key: string;
  label: string;
  users: number;
  deposits: number;
  ggr: number;
};

export type CrmPlayerRow = {
  userId: string;
  username: string | null;
  image: string | null;
  deposits: number;
  netDeposits: number;
  ggr: number;
  plays: number;
  recencyDays: number;
  lifecycle: LifecycleKey;
};

export type CrmSnapshot = {
  totalCustomers: number;
  depositingCustomers: number;
  newCustomers: number;
  totalDeposits: number;
  totalNetDeposits: number;
  totalGgr: number;
  avgDepositPerCustomer: number;
  lifecycle: CrmSegmentRow[];
  vipTiers: CrmSegmentRow[];
  dormantWhales: CrmPlayerRow[];
  topValue: CrmPlayerRow[];
};

/**
 * One per-customer aggregate row — the shared contract BOTH read engines
 * (Postgres `computeCrmRowsPg` and the ClickHouse twin `getCrmRowsFromClickHouse`)
 * must return, so `bucketCrmSnapshot` produces an identical snapshot regardless
 * of source. Money columns are strings (Decimal-safe: `toString(sum(...))` /
 * `::text`, parsed via `toNumber`, never Float).
 */
export type CrmAggregateRow = {
  user_id: string;
  username: string | null;
  image: string | null;
  deposits: string;
  withdrawals: string;
  wager: string;
  payout: string;
  plays: number;
  recency_days: number;
  signup_days: number;
};

const LIFECYCLE_LABELS: Record<LifecycleKey, string> = {
  active: "Active (≤14d)",
  at_risk: "At-Risk (15-30d)",
  dormant: "Dormant (31-90d)",
  churned: "Churned (>90d)",
};

const VIP_LABELS: Record<VipTierKey, string> = {
  diamond: "Diamond ($5k+)",
  platinum: "Platinum ($2k-5k)",
  gold: "Gold ($500-2k)",
  silver: "Silver ($100-500)",
  bronze: "Bronze (<$100)",
};

function lifecycleFor(recencyDays: number): LifecycleKey {
  if (recencyDays <= 14) return "active";
  if (recencyDays <= 30) return "at_risk";
  if (recencyDays <= 90) return "dormant";
  return "churned";
}

function vipTierFor(deposits: number): VipTierKey | null {
  if (deposits >= 5000) return "diamond";
  if (deposits >= 2000) return "platinum";
  if (deposits >= 500) return "gold";
  if (deposits >= 100) return "silver";
  if (deposits > 0) return "bronze";
  return null;
}

/**
 * Pure, engine-agnostic bucketing of the per-customer aggregate rows into the
 * CRM snapshot. Identical for the Postgres and ClickHouse paths so the two can
 * never drift on lifecycle/VIP bucketing, totals, or the leaderboards.
 */
export function bucketCrmSnapshot(rows: CrmAggregateRow[]): CrmSnapshot {
  const lifecycleAgg: Record<LifecycleKey, { users: number; deposits: number; ggr: number }> = {
    active: { users: 0, deposits: 0, ggr: 0 },
    at_risk: { users: 0, deposits: 0, ggr: 0 },
    dormant: { users: 0, deposits: 0, ggr: 0 },
    churned: { users: 0, deposits: 0, ggr: 0 },
  };
  const vipAgg: Record<VipTierKey, { users: number; deposits: number; ggr: number }> = {
    diamond: { users: 0, deposits: 0, ggr: 0 },
    platinum: { users: 0, deposits: 0, ggr: 0 },
    gold: { users: 0, deposits: 0, ggr: 0 },
    silver: { users: 0, deposits: 0, ggr: 0 },
    bronze: { users: 0, deposits: 0, ggr: 0 },
  };

  let totalDeposits = 0;
  let totalWithdrawals = 0;
  let totalGgr = 0;
  let depositingCustomers = 0;
  let newCustomers = 0;

  const players: CrmPlayerRow[] = rows.map((r) => {
    const deposits = toNumber(r.deposits);
    const withdrawals = toNumber(r.withdrawals);
    const ggr = toNumber(r.wager) - toNumber(r.payout);
    const recencyDays = Math.max(0, r.recency_days);
    const lc = lifecycleFor(recencyDays);

    totalDeposits += deposits;
    totalWithdrawals += withdrawals;
    totalGgr += ggr;
    if (deposits > 0) depositingCustomers += 1;
    if (r.signup_days <= NEW_CUSTOMER_DAYS) newCustomers += 1;

    lifecycleAgg[lc].users += 1;
    lifecycleAgg[lc].deposits += deposits;
    lifecycleAgg[lc].ggr += ggr;

    const tier = vipTierFor(deposits);
    if (tier) {
      vipAgg[tier].users += 1;
      vipAgg[tier].deposits += deposits;
      vipAgg[tier].ggr += ggr;
    }

    return {
      userId: r.user_id,
      username: r.username,
      image: r.image,
      deposits,
      netDeposits: deposits - withdrawals,
      ggr,
      plays: r.plays,
      recencyDays,
      lifecycle: lc,
    };
  });

  const lifecycle: CrmSegmentRow[] = (Object.keys(lifecycleAgg) as LifecycleKey[]).map(
    (key) => ({ key, label: LIFECYCLE_LABELS[key], ...lifecycleAgg[key] }),
  );
  const vipTiers: CrmSegmentRow[] = (Object.keys(vipAgg) as VipTierKey[]).map(
    (key) => ({ key, label: VIP_LABELS[key], ...vipAgg[key] }),
  );

  const dormantWhales = players
    .filter(
      (p) =>
        p.deposits >= DORMANT_WHALE_MIN_DEPOSITS &&
        p.recencyDays > DORMANT_WHALE_MIN_RECENCY_DAYS,
    )
    .sort((a, b) => b.deposits - a.deposits)
    .slice(0, DORMANT_WHALE_LIMIT);

  const topValue = [...players]
    .sort((a, b) => b.deposits - a.deposits)
    .slice(0, TOP_VALUE_LIMIT);

  return {
    totalCustomers: players.length,
    depositingCustomers,
    newCustomers,
    totalDeposits,
    totalNetDeposits: totalDeposits - totalWithdrawals,
    totalGgr,
    avgDepositPerCustomer:
      depositingCustomers > 0 ? totalDeposits / depositingCustomers : 0,
    lifecycle,
    vipTiers,
    dormantWhales,
    topValue,
  };
}
