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

/**
 * Player progression bands over the REAL `user_statistics.level` (XP-driven,
 * observed range 0–84 on prod).
 *
 * This replaces the old "VIP value tiers" (2026-07-23), which invented
 * Diamond/Platinum/Gold/Silver/Bronze names over raw deposit brackets. Those
 * names matched nothing in the product — there is no such tier system — so the
 * block read as a real player-facing status while being a made-up relabelling
 * of "how much have they deposited". A band here is named for exactly what it
 * is: a range of the level the player actually has.
 *
 * The edges follow the live distribution rather than round numbers: level 0 is
 * ~87% of all rows (players who have barely played), so it gets its own band
 * instead of being averaged into 1–9 and hiding everything above it.
 */
export type LevelBandKey = "l0" | "l1_9" | "l10_19" | "l20_29" | "l30_49" | "l50_plus";

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
  /** Real `user_statistics.level`. 0 when the player has no stats row yet. */
  level: number;
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
  /** Real player-level bands — see {@link LevelBandKey}. */
  levelBands: CrmSegmentRow[];
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

const LEVEL_BAND_LABELS: Record<LevelBandKey, string> = {
  l0: "Level 0",
  l1_9: "Level 1–9",
  l10_19: "Level 10–19",
  l20_29: "Level 20–29",
  l30_49: "Level 30–49",
  l50_plus: "Level 50+",
};

const LEVEL_BAND_ORDER: LevelBandKey[] = [
  "l50_plus",
  "l30_49",
  "l20_29",
  "l10_19",
  "l1_9",
  "l0",
];

function lifecycleFor(recencyDays: number): LifecycleKey {
  if (recencyDays <= 14) return "active";
  if (recencyDays <= 30) return "at_risk";
  if (recencyDays <= 90) return "dormant";
  return "churned";
}

function levelBandFor(level: number): LevelBandKey {
  if (level >= 50) return "l50_plus";
  if (level >= 30) return "l30_49";
  if (level >= 20) return "l20_29";
  if (level >= 10) return "l10_19";
  if (level >= 1) return "l1_9";
  return "l0";
}

/**
 * Pure, engine-agnostic bucketing of the per-customer aggregate rows into the
 * CRM snapshot. Identical for the Postgres and ClickHouse paths so the two can
 * never drift on lifecycle/level bucketing, totals, or the leaderboards.
 *
 * `levelByUser` carries the REAL `user_statistics.level` per user id. It is
 * passed in rather than read here (this module stays engine-free) and, for the
 * same reason, is resolved ONCE by the caller and handed to BOTH read legs —
 * ClickHouse has no `user_statistics` mirror, so deriving it inside each leg
 * would leave the twin unable to produce a comparable snapshot. A user missing
 * from the map has no stats row yet and banks as level 0, which is what the
 * product shows them.
 */
export function bucketCrmSnapshot(
  rows: CrmAggregateRow[],
  levelByUser?: ReadonlyMap<string, number>,
): CrmSnapshot {
  const lifecycleAgg: Record<LifecycleKey, { users: number; deposits: number; ggr: number }> = {
    active: { users: 0, deposits: 0, ggr: 0 },
    at_risk: { users: 0, deposits: 0, ggr: 0 },
    dormant: { users: 0, deposits: 0, ggr: 0 },
    churned: { users: 0, deposits: 0, ggr: 0 },
  };
  const levelAgg: Record<LevelBandKey, { users: number; deposits: number; ggr: number }> = {
    l0: { users: 0, deposits: 0, ggr: 0 },
    l1_9: { users: 0, deposits: 0, ggr: 0 },
    l10_19: { users: 0, deposits: 0, ggr: 0 },
    l20_29: { users: 0, deposits: 0, ggr: 0 },
    l30_49: { users: 0, deposits: 0, ggr: 0 },
    l50_plus: { users: 0, deposits: 0, ggr: 0 },
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
    const level = levelByUser?.get(r.user_id) ?? 0;

    totalDeposits += deposits;
    totalWithdrawals += withdrawals;
    totalGgr += ggr;
    if (deposits > 0) depositingCustomers += 1;
    if (r.signup_days <= NEW_CUSTOMER_DAYS) newCustomers += 1;

    lifecycleAgg[lc].users += 1;
    lifecycleAgg[lc].deposits += deposits;
    lifecycleAgg[lc].ggr += ggr;

    // Every customer lands in exactly one band (level 0 is a band, not a
    // "no tier" hole) — so the band users always sum to totalCustomers, which
    // the old deposit-tier version did NOT do: a $0-deposit player fell
    // through `vipTierFor` entirely and silently vanished from that block.
    const band = levelBandFor(level);
    levelAgg[band].users += 1;
    levelAgg[band].deposits += deposits;
    levelAgg[band].ggr += ggr;

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
      level,
    };
  });

  const lifecycle: CrmSegmentRow[] = (Object.keys(lifecycleAgg) as LifecycleKey[]).map(
    (key) => ({ key, label: LIFECYCLE_LABELS[key], ...lifecycleAgg[key] }),
  );
  // Highest band first — the operator cares about the top of the ladder, and
  // level 0 (the ~87% bulk) reads as the tail rather than the headline.
  const levelBands: CrmSegmentRow[] = LEVEL_BAND_ORDER.map((key) => ({
    key,
    label: LEVEL_BAND_LABELS[key],
    ...levelAgg[key],
  }));

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
    levelBands,
    dormantWhales,
    topValue,
  };
}
