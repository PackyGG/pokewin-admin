import "server-only";

import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { getWindowMetrics, sumLedgerTypes, type MetricWindow } from "@/lib/metrics/queries";
import {
  NON_BORROW_PACK_SESSIONS,
  NON_BORROW_BATTLE_SESSIONS,
} from "@/lib/metrics/gaming-sql";
import { getMetricsScope } from "@/lib/metrics/scope";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import {
  daysForInsightsPeriodCapped,
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import {
  BALANCE_ADJUSTMENT_CATEGORY_META,
  isBalanceAdjustmentCategory,
  isCountedAdjustmentCategory,
} from "@/lib/balance-adjustment-categories";
import {
  parseRafflePrizes,
  buildRafflePrizeValuator,
} from "@/lib/queries/insights-rewards/raffle/prize-valuation";
import type { SystemEdgeBaseline } from "../system-edge-plan/_model";
import { getSystemEdgeBaseline } from "../system-edge-plan/_baseline";
import { getMothaGiveawayOverview } from "@/lib/queries/insights-rewards/motha/overview";

import type {
  AdjustmentCategoryRow,
  CanonicalMeasuredBlock,
  DailyPackLevelInfo,
  DailyPackUsageInfo,
  DepositAssetVolume,
  DepositSizeBucket,
  EdgePlanV2Baseline,
  LiveRaffleInfo,
  RainAnchor,
  TimeBonusAnchor,
  TimeBonusBucket,
} from "./_model-v2";
import { splitAffiliateCostBundle, XP_TO_USD } from "./_model-v2";
import type { RewardSourceVolume } from "./_credit-matrix-v2";

/** Edge Plan 2.0 always anchors on the last 30 days of production data. */
export const EDGE_PLAN_V2_PERIOD: InsightsRewardsPeriod = "30d";

const DEFAULT_BALANCE_WITHDRAWAL_SHARE = 0.35;

/**
 * Per-statement budget for the ad-hoc baseline scans. The prod ledger has
 * NO secondary indexes (and never will — owner cannot run DDL), so every
 * scan here is a bounded seq scan killed server-side at this budget
 * (pattern: creators-pnl.ts `SET LOCAL statement_timeout`). A timed-out
 * scan degrades its own block to null/empty via `safeQuery` — never the
 * whole page.
 */
const SCAN_STATEMENT_TIMEOUT_MS = 8_000;

function windowFor30d(): MetricWindow {
  const days = daysForInsightsPeriodCapped(EDGE_PLAN_V2_PERIOD);
  return { since: new Date(Date.now() - days * 24 * 60 * 60 * 1000) };
}

function sinceClause(column: string, since: Date | null): string {
  if (since === null) return "";
  return `AND ${column} >= '${since.toISOString()}'::timestamptz`;
}

/** Run one ad-hoc scan inside a tx with the bounded statement timeout. */
async function boundedScan<T>(sql: string): Promise<T[]> {
  const db = await getDb();
  return db.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(
        `SET LOCAL statement_timeout = ${SCAN_STATEMENT_TIMEOUT_MS}`,
      );
      return tx.$queryRawUnsafe<T[]>(sql);
    },
    {
      // All 8 bounded scans fire inside ONE Promise.all (assembly below),
      // so on a cache-miss rebuild they queue behind each other (and the
      // non-tx legs) for pool connections. Prisma's interactive-transaction
      // defaults — maxWait 2s, timeout 5s — then fail two ways under that
      // concurrent load (observed on the dev server 2026-06-12): "Unable to
      // start a transaction in the given time" while waiting for a slot,
      // and a client-side kill BEFORE the 8s server-side statement_timeout
      // this scan is budgeted for. Raise both so the server-side
      // statement_timeout stays the real per-scan budget; the caller's
      // safeQuery (15s) still bounds the whole leg and degrades it to its
      // fallback instead of failing the page.
      maxWait: 10_000,
      timeout: SCAN_STATEMENT_TIMEOUT_MS + 4_000,
    },
  );
}

// ─── Existing v2 legs (unchanged semantics) ──────────────────────────────────

async function getBorrowedWagerTotals(): Promise<{
  packWagerBorrowed: number;
  battleWagerBorrowed: number;
} | null> {
  const since = windowFor30d().since;
  if (!since) return null;

  const db = await getDb();
  const scope = await getMetricsScope();
  const rows = await db.$queryRawUnsafe<
    { pack_wager_borrowed: string; battle_wager_borrowed: string }[]
  >(
    `WITH ${scope.sessionWindowsCte}
     SELECT
       COALESCE(SUM(CASE
         WHEN type::text = 'pack_opening'
          AND (description ILIKE '%borrow%'
               OR (game_session_id IS NOT NULL
                   AND game_session_id NOT IN ${NON_BORROW_PACK_SESSIONS}))
         THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS pack_wager_borrowed,
       COALESCE(SUM(CASE
         WHEN type::text = 'battle_bet'
          AND (game_session_id IS NULL
               OR game_session_id NOT IN ${NON_BORROW_BATTLE_SESSIONS})
         THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS battle_wager_borrowed
     FROM ledger_transactions
     WHERE status = 'completed'
       AND user_id IN ${scope.userScopeSql}
       AND ${scope.notInCreatorSession("user_id", "created_at")}
       ${sinceClause("created_at", since)}`,
  );
  return {
    packWagerBorrowed: toNumber(rows[0]?.pack_wager_borrowed),
    battleWagerBorrowed: toNumber(rows[0]?.battle_wager_borrowed),
  };
}

async function getWithdrawalBaselineFromLedger(): Promise<{
  volumeUsd: number;
  balanceShare: number;
} | null> {
  const since = windowFor30d().since;
  if (!since) return null;

  const db = await getDb();
  const [ledger, card] = await Promise.all([
    db.$queryRawUnsafe<{ manual_wd: string }[]>(
      `SELECT COALESCE(SUM(CASE WHEN lt.type::text = 'admin_balance_adjustment'
                                AND lt.balance_after < lt.balance_before
                                AND lt.description ILIKE 'Manual withdrawal:%'
                               THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS manual_wd
       FROM ledger_transactions lt
       WHERE lt.status = 'completed'
         AND lt.created_at >= $1
         AND lt.user_id IN (
           SELECT id FROM "user" u WHERE u.role NOT IN ('admin', 'support')
         )`,
      since,
    ),
    db.$queryRawUnsafe<{ card_wd: string }[]>(
      `SELECT COALESCE(SUM(cwr.total_value_usd::numeric), 0)::text AS card_wd
       FROM card_withdrawal_requests cwr
       WHERE cwr.status IN ('completed', 'shipped')
         AND COALESCE(cwr.shipped_at, cwr.completed_at) >= $1
         AND cwr.user_id IN (
           SELECT id FROM "user" u WHERE u.role NOT IN ('admin', 'support')
         )`,
      since,
    ),
  ]);
  const manualUsd = toNumber(ledger[0]?.manual_wd);
  const cardUsd = toNumber(card[0]?.card_wd);
  const volumeUsd = manualUsd + cardUsd;
  if (volumeUsd <= 0) return null;
  return { volumeUsd, balanceShare: manualUsd / volumeUsd };
}

// ─── New v2.1 scans (each bounded + safeQuery-wrapped by the caller) ─────────

async function scanDepositsByAsset(since: Date): Promise<DepositAssetVolume[]> {
  const scope = await getMetricsScope();
  const rows = await boundedScan<{ asset: string; n: string; vol: string }>(
    `WITH ${scope.sessionWindowsCte}
     SELECT COALESCE(NULLIF(TRIM(lt.crypto_asset), ''), da.asset_id, 'unknown') AS asset,
            COUNT(*)::text AS n,
            COALESCE(SUM(lt.amount::numeric), 0)::text AS vol
     FROM ledger_transactions lt
     LEFT JOIN deposit_addresses da ON da.id = lt.deposit_address_id
     WHERE lt.status = 'completed'
       AND lt.type::text = 'deposit'
       AND lt.user_id IN ${scope.userScopeSql}
       ${sinceClause("lt.created_at", since)}
     GROUP BY 1
     ORDER BY SUM(lt.amount::numeric) DESC`,
  );
  return rows.map((r) => ({
    asset: r.asset,
    count: Number(r.n),
    volumeUsd: toNumber(r.vol),
  }));
}

/**
 * Per-category adjustment breakdown under the CANONICAL customer scope
 * (same scope as `sumLedgerTypes`), credits/debits split, incl. the NULL
 * "Not itemized" bucket. The counted-credit total mirrors
 * `countedAdjustmentSqlPredicate` semantics (credits only, counted
 * categories only) so it reconciles with the canonical reward cost.
 */
async function scanAdjustmentBreakdown(since: Date): Promise<{
  rows: AdjustmentCategoryRow[];
  countedCost: number;
}> {
  const scope = await getMetricsScope();
  const raw = await boundedScan<{
    category: string | null;
    n: string;
    credits: string;
    debits: string;
  }>(
    `WITH ${scope.sessionWindowsCte}
     SELECT metadata->>'adjustment_category' AS category,
            COUNT(*)::text AS n,
            COALESCE(SUM(CASE WHEN amount::numeric > 0 THEN amount::numeric ELSE 0 END), 0)::text AS credits,
            COALESCE(SUM(CASE WHEN amount::numeric < 0 THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS debits
     FROM ledger_transactions
     WHERE status = 'completed'
       AND type::text = 'admin_balance_adjustment'
       AND user_id IN ${scope.userScopeSql}
       AND ${scope.notInCreatorSession("user_id", "created_at")}
       ${sinceClause("created_at", since)}
     GROUP BY 1
     ORDER BY 1 NULLS LAST`,
  );

  let countedCost = 0;
  const rows: AdjustmentCategoryRow[] = raw.map((r) => {
    const key = r.category;
    const known = key != null && isBalanceAdjustmentCategory(key);
    const counted = known && isCountedAdjustmentCategory(key);
    const credits = toNumber(r.credits);
    if (counted) countedCost += credits;
    return {
      category: key,
      label:
        key == null
          ? "Not itemized"
          : known
            ? BALANCE_ADJUSTMENT_CATEGORY_META[key].label
            : key,
      count: Number(r.n),
      creditsUsd: credits,
      debitsUsd: toNumber(r.debits),
      counted,
    };
  });

  return { rows, countedCost };
}

async function scanRainAnchor(
  since: Date,
  periodDays: number,
): Promise<RainAnchor | null> {
  const rows = await boundedScan<{
    n: string;
    avg_hours: string;
    avg_pool: string;
    sum_pool: string;
  }>(
    `SELECT COUNT(*)::text AS n,
            COALESCE(AVG(EXTRACT(EPOCH FROM (ends_at - starts_at)) / 3600.0), 0)::text AS avg_hours,
            COALESCE(AVG(total_pool_usd::numeric), 0)::text AS avg_pool,
            COALESCE(SUM(total_pool_usd::numeric), 0)::text AS sum_pool
     FROM rains
     WHERE status = 'completed'
       ${sinceClause("created_at", since)}`,
  );
  const r = rows[0];
  const count = Number(r?.n ?? 0);
  if (!r || count <= 0) return null;
  return {
    count,
    avgPoolUsd: toNumber(r.avg_pool),
    avgDurationHours: toNumber(r.avg_hours),
    avgIntervalHours: (Math.max(1, periodDays) * 24) / count,
    totalPoolUsd: toNumber(r.sum_pool),
  };
}

/** Fixed deposit-size bucket edges (USD, ascending; null = open top). */
const DEPOSIT_SIZE_BUCKET_EDGES: (number | null)[] = [
  5, 10, 15, 20, 25, 30, 40, 50, 75, 100, 150, 200, 300, 500, 1000, null,
];

async function scanDepositSizeHistogram(since: Date): Promise<{
  buckets: DepositSizeBucket[];
  observedMinUsd: number | null;
}> {
  const scope = await getMetricsScope();
  const caseLines = DEPOSIT_SIZE_BUCKET_EDGES.map((max, i) =>
    max == null
      ? `ELSE ${i}`
      : `WHEN lt.amount::numeric < ${max} THEN ${i}`,
  );
  const rows = await boundedScan<{ bucket: number; n: string; min_amt: string }>(
    `WITH ${scope.sessionWindowsCte}
     SELECT CASE ${caseLines.slice(0, -1).join(" ")} ${caseLines[caseLines.length - 1]} END AS bucket,
            COUNT(*)::text AS n,
            MIN(lt.amount::numeric)::text AS min_amt
     FROM ledger_transactions lt
     WHERE lt.status = 'completed'
       AND lt.type::text = 'deposit'
       AND lt.user_id IN ${scope.userScopeSql}
       ${sinceClause("lt.created_at", since)}
     GROUP BY 1
     ORDER BY 1`,
  );
  const byBucket = new Map(rows.map((r) => [Number(r.bucket), r]));
  const buckets: DepositSizeBucket[] = DEPOSIT_SIZE_BUCKET_EDGES.map((max, i) => ({
    maxUsd: max,
    count: Number(byBucket.get(i)?.n ?? 0),
  }));
  let observedMinUsd: number | null = null;
  for (const r of rows) {
    const min = toNumber(r.min_amt);
    if (observedMinUsd == null || min < observedMinUsd) observedMinUsd = min;
  }
  return { buckets, observedMinUsd };
}

/** Fixed per-user-day bonus bucket edges (USD, ascending; null = open top). */
const TIME_BONUS_BUCKET_EDGES: (number | null)[] = [
  1, 2.5, 5, 10, 15, 20, 25, 50, 75, 100, null,
];

async function scanTimeBonusAnchor(
  since: Date,
  periodDays: number,
): Promise<TimeBonusAnchor | null> {
  const scope = await getMetricsScope();
  const caseLines = TIME_BONUS_BUCKET_EDGES.map((max, i) =>
    max == null ? `ELSE ${i}` : `WHEN per.amt < ${max} THEN ${i}`,
  );
  const rows = await boundedScan<{
    bucket: number;
    user_days: string;
    total: string;
    users: string;
    max_amt: string;
  }>(
    `WITH ${scope.sessionWindowsCte},
     per AS (
       SELECT user_id, date_trunc('day', created_at) AS d, SUM(ABS(amount::numeric)) AS amt
       FROM ledger_transactions
       WHERE status = 'completed'
         AND type::text = 'deposit_bonus'
         AND user_id IN ${scope.userScopeSql}
         ${sinceClause("created_at", since)}
       GROUP BY 1, 2
     )
     SELECT CASE ${caseLines.slice(0, -1).join(" ")} ${caseLines[caseLines.length - 1]} END AS bucket,
            COUNT(*)::text AS user_days,
            COALESCE(SUM(per.amt), 0)::text AS total,
            COUNT(DISTINCT per.user_id)::text AS users,
            COALESCE(MAX(per.amt), 0)::text AS max_amt
     FROM per
     GROUP BY 1
     ORDER BY 1`,
  );
  if (rows.length === 0) return null;

  const byBucket = new Map(rows.map((r) => [Number(r.bucket), r]));
  const buckets: TimeBonusBucket[] = TIME_BONUS_BUCKET_EDGES.map((max, i) => ({
    maxUsd: max,
    userDays: Number(byBucket.get(i)?.user_days ?? 0),
    totalUsd: toNumber(byBucket.get(i)?.total),
  }));

  const userDays = buckets.reduce((s, b) => s + b.userDays, 0);
  const totalUsd = buckets.reduce((s, b) => s + b.totalUsd, 0);
  // Distinct users per bucket overlap across buckets — take the MAX as a
  // floor and the Σ as a cap; the honest distinct-user figure needs its own
  // pass, so approximate with the largest bucket's distinct count summed
  // (documented approximation, only used for the claim-rate display).
  const users = rows.reduce((s, r) => s + Number(r.users), 0);
  const maxPerUserDayUsd = rows.reduce(
    (m, r) => Math.max(m, toNumber(r.max_amt)),
    0,
  );
  if (userDays <= 0) return null;
  return {
    userDays,
    users,
    totalUsd,
    avgPerUserDayUsd: totalUsd / userDays,
    maxPerUserDayUsd,
    claimRatePerUserDay:
      users > 0 ? Math.min(1, userDays / (users * Math.max(1, periodDays))) : 0,
    buckets,
  };
}

/**
 * Level boundaries + per-level customer counts from `user_statistics`
 * (small table, one grouped pass). Thresholds derive as
 * `max(min_xp[L], max_xp[L−1])` with a monotone clamp — robust against the
 * handful of admin-set outlier rows (probe: level 24 min_xp=72k, level 42
 * min_xp=0).
 */
async function scanLevelStats(): Promise<{
  thresholds: Map<number, number>;
  usersAtOrAbove: Map<number, number>;
} | null> {
  const rows = await boundedScan<{
    level: number;
    users: string;
    min_xp: string;
    max_xp: string;
  }>(
    `SELECT us.level, COUNT(*)::text AS users, MIN(us.xp)::text AS min_xp, MAX(us.xp)::text AS max_xp
     FROM user_statistics us
     JOIN "user" u ON u.id = us.user_id
     WHERE u.role NOT IN ('admin', 'support')
     GROUP BY us.level
     ORDER BY us.level`,
  );
  if (rows.length === 0) return null;

  const sorted = rows
    .map((r) => ({
      level: Number(r.level),
      users: Number(r.users),
      minXp: toNumber(r.min_xp),
      maxXp: toNumber(r.max_xp),
    }))
    .sort((a, b) => a.level - b.level);

  const thresholds = new Map<number, number>();
  let prevMaxXp = 0;
  let prevThreshold = 0;
  for (const row of sorted) {
    if (row.level <= 0) {
      thresholds.set(0, 0);
      prevMaxXp = row.maxXp;
      continue;
    }
    const candidate = Math.max(row.minXp, prevMaxXp);
    const threshold = Math.max(prevThreshold, candidate);
    thresholds.set(row.level, threshold);
    prevThreshold = threshold;
    prevMaxXp = row.maxXp;
  }

  // Cumulative users at/above each observed level.
  const usersAtOrAbove = new Map<number, number>();
  let running = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    running += sorted[i].users;
    usersAtOrAbove.set(sorted[i].level, running);
  }
  return { thresholds, usersAtOrAbove };
}

/** Daily rewards (level gate + re-lock % + the pack each one unlocks). */
async function scanDailyRewardConfigs(): Promise<
  { rewardSlug: string; levelRequired: number; relockPct: number; packIds: string[] }[]
> {
  const rows = await boundedScan<{
    slug: string;
    level_required: number;
    daily_unlock_percentage: string | null;
    pack_ids: string[];
  }>(
    `SELECT slug, level_required, daily_unlock_percentage::text AS daily_unlock_percentage, pack_ids
     FROM rewards
     WHERE type::text = 'daily'
     ORDER BY level_required ASC`,
  );
  return rows.map((r) => ({
    rewardSlug: r.slug,
    levelRequired: Number(r.level_required),
    // NULL = the backend's 1% default (schema comment, verified by probe).
    relockPct:
      r.daily_unlock_percentage == null ? 0.01 : toNumber(r.daily_unlock_percentage),
    packIds: r.pack_ids ?? [],
  }));
}

/**
 * Per-pack per-user open-day histogram for the "every-time claimer" share —
 * ONE bounded scan over reward-pack game sessions. "Every time" = claimed
 * on ≥90% of window days.
 */
async function scanEveryTimeClaimers(
  since: Date,
  periodDays: number,
): Promise<Map<string, { claimers: number; everyTime: number }>> {
  const threshold = Math.max(1, Math.floor(periodDays * 0.9));
  const rows = await boundedScan<{
    pack_id: string;
    claimers: string;
    every_time: string;
  }>(
    `WITH per_user AS (
       SELECT p.id AS pack_id, gs.user_id,
              COUNT(DISTINCT date_trunc('day', gs.created_at)) AS days
       FROM game_sessions gs
       JOIN packs p ON p.id = gs.game_id AND p.pack_type = 'reward'
       WHERE gs.game_type = 'pack'
         AND gs.user_id IS NOT NULL
         ${sinceClause("gs.created_at", since)}
       GROUP BY 1, 2
     )
     SELECT pack_id,
            COUNT(*)::text AS claimers,
            SUM(CASE WHEN days >= ${threshold} THEN 1 ELSE 0 END)::text AS every_time
     FROM per_user
     GROUP BY 1`,
  );
  return new Map(
    rows.map((r) => [
      r.pack_id,
      { claimers: Number(r.claimers), everyTime: Number(r.every_time) },
    ]),
  );
}

/** Live (status=active) raffles valued via the shared prize-valuation helper. */
async function scanLiveRaffles(): Promise<LiveRaffleInfo[]> {
  const db = await getDb();
  const rows = await boundedScan<{
    id: string;
    name: string | null;
    prizes: unknown;
    total_entries: number | null;
    participant_count: number | null;
    ends_at: Date | null;
  }>(
    `SELECT id, name, prizes, total_entries, participant_count, ends_at
     FROM raffles
     WHERE status::text = 'active'
     ORDER BY ends_at ASC NULLS LAST
     LIMIT 12`,
  );
  if (rows.length === 0) return [];

  const parsed = rows.map((r) => ({ row: r, lines: parseRafflePrizes(r.prizes) }));
  const valuator = await buildRafflePrizeValuator(
    db,
    parsed.flatMap((p) => p.lines),
  );

  return parsed.map(({ row, lines }) => ({
    id: row.id,
    title: row.name,
    totalEntries: Number(row.total_entries ?? 0),
    participantCount: Number(row.participant_count ?? 0),
    endsAt: row.ends_at ? row.ends_at.toISOString() : null,
    prizeValueUsd: valuator.valueLines(lines),
    prizes: lines.map((l) => ({
      type: l.type,
      id: l.id,
      quantity: l.quantity,
      unitPriceUsd: valuator.unitPriceUsd(l),
    })),
  }));
}

/** MAX(ledger created_at) within a 7d guard window — the freshness stamp. */
async function scanLedgerMaxCreatedAt(): Promise<string | null> {
  const rows = await boundedScan<{ max_created: Date | null }>(
    `SELECT MAX(created_at) AS max_created
     FROM ledger_transactions
     WHERE created_at >= NOW() - INTERVAL '7 days'`,
  );
  const v = rows[0]?.max_created;
  return v ? v.toISOString() : null;
}

// ─── Assembly ────────────────────────────────────────────────────────────────

async function buildEdgePlanV2Baseline(): Promise<EdgePlanV2Baseline> {
  const window = windowFor30d();
  const since = window.since!;
  const periodDays = Math.max(1, daysForInsightsPeriodCapped(EDGE_PLAN_V2_PERIOD));

  // ONE Promise.all across every leg (the v1 baseline + all v2 reads —
  // the previously-serial awaits included). Each leg is safeQuery-wrapped
  // so a failure degrades only its own block.
  const [
    v1Res,
    canonicalRes,
    withdrawalRes,
    affCommissionRes,
    affLeaderboardRes,
    mothaOvRes,
    borrowedRes,
    giftCardRes,
    promoCodeRes,
    depositsByAssetRes,
    adjustmentsRes,
    rainAnchorRes,
    depositHistRes,
    timeBonusRes,
    levelStatsRes,
    dailyRewardCfgRes,
    everyTimeRes,
    liveRafflesRes,
    ledgerMaxRes,
  ] = await Promise.all([
    safeQuery(
      () => getSystemEdgeBaseline(EDGE_PLAN_V2_PERIOD),
      null,
      "edge-plan-v2.v1-baseline",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => getWindowMetrics({ window }),
      null,
      "edge-plan-v2.canonical",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => getWithdrawalBaselineFromLedger(),
      null,
      "edge-plan-v2.withdrawal-split",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => sumLedgerTypes({ types: ["affiliate_claim"], window }),
      null,
      "edge-plan-v2.affiliate-commission",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => sumLedgerTypes({ types: ["affiliate_leaderboard_prize"], window }),
      null,
      "edge-plan-v2.affiliate-leaderboard",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => getMothaGiveawayOverview(EDGE_PLAN_V2_PERIOD),
      null,
      "edge-plan-v2.motha-breakdown",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => getBorrowedWagerTotals(),
      null,
      "edge-plan-v2.borrowed-wager",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => sumLedgerTypes({ types: ["gift_card_redeemed"], window }),
      0,
      "edge-plan-v2.gift-cards",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => sumLedgerTypes({ types: ["promo_code_redeemed"], window }),
      0,
      "edge-plan-v2.promo-codes",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => scanDepositsByAsset(since),
      [] as DepositAssetVolume[],
      "edge-plan-v2.deposits-by-asset",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => scanAdjustmentBreakdown(since),
      null,
      "edge-plan-v2.adjustments",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => scanRainAnchor(since, periodDays),
      null,
      "edge-plan-v2.rain-anchor",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => scanDepositSizeHistogram(since),
      null,
      "edge-plan-v2.deposit-histogram",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => scanTimeBonusAnchor(since, periodDays),
      null,
      "edge-plan-v2.time-bonus-anchor",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => scanLevelStats(),
      null,
      "edge-plan-v2.level-stats",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => scanDailyRewardConfigs(),
      [] as Awaited<ReturnType<typeof scanDailyRewardConfigs>>,
      "edge-plan-v2.daily-reward-configs",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => scanEveryTimeClaimers(since, periodDays),
      null,
      "edge-plan-v2.every-time-claimers",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => scanLiveRaffles(),
      [] as LiveRaffleInfo[],
      "edge-plan-v2.live-raffles",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => scanLedgerMaxCreatedAt(),
      null,
      "edge-plan-v2.ledger-freshness",
      REWARD_QUERY_TIMEOUT_MS,
    ),
  ]);

  // The v1 baseline anchors per-type legs + the per-lever ledger costs on
  // the SAME canonical scope as /ggr + dashboard. NO rescaling of any kind:
  // the old `applyOrganicWagerScale` (which rescaled every game-type leg to
  // the topbar's pack/battle ledger wager — a NON-comparable denominator:
  // borrow-inclusive, upgrader-free) is DELETED. Probe 2026-06-12: that
  // rescale UP-scaled every leg ×2.16 on the new prod DB and fabricated the
  // wrong headline NGR. v1 legs ARE the canonical legs; they stay untouched.
  const v1: SystemEdgeBaseline =
    v1Res.data ??
    // Degraded v1 read — extremely unlikely (getSystemEdgeBaseline has its
    // own outer safeQuery + zeroed fallback), but keep the page alive.
    ({
      periodLabel: insightsRewardsPeriodLabel(EDGE_PLAN_V2_PERIOD),
      periodDays,
      gameTypes: [],
      wager: 0,
      gamingPayout: 0,
      ggr: 0,
      houseEdge: null,
      bets: 0,
      rakebackCost: 0,
      affiliateCost: 0,
      depositBonusCost: 0,
      raceCost: 0,
      raffleCost: 0,
      dailyPacksCost: 0,
      signupPacksCost: 0,
      rainCost: 0,
      mothaCost: 0,
      otherRewardCost: 0,
      rakebackCadences: [],
      affiliateTiers: [],
      affiliateBlendedRate: null,
      dailyPackRows: [],
      rewardPackCatalog: [],
      signupAvgGrant: null,
      signupClaimants: 0,
      signupSignups: 0,
      signupAvgPerSignup: null,
      signupConversionPct: 0,
      welcomePacks: [],
      depositBonusCapUsd: 100,
      depositBonusWindowHours: 24,
      rainWinTotal: 0,
      rainTipTotal: 0,
    } satisfies SystemEdgeBaseline);

  const metrics = canonicalRes.data;
  const canonical: CanonicalMeasuredBlock | null = metrics
    ? {
        wager: metrics.wager,
        gamingPayout: metrics.gamingPayout,
        ggr: metrics.ggr,
        ngr: metrics.ngr,
        rewardCost: metrics.ggr - metrics.ngr,
        houseEdge: metrics.houseEdge,
        bets: metrics.bets,
        rainHouseCost: metrics.rainHouseCost,
      }
    : null;

  // Affiliate commission / leaderboard split — CANONICAL customer-scope
  // ledger legs (sumLedgerTypes — the same scope as every other reward leg;
  // creators excluded). The previous getAffiliateOverview source sat on the
  // LEGACY staff-only exclusion (creators included) and over-reported the
  // split vs the bundled v1 affiliateCost by the creators' claims (recon
  // verify 2026-06-12: +$5,191.24 commission / +$85.00 leaderboard on live
  // prod). Fallback treats the bundled total as all commission — no
  // fabricated figure.
  const affCommissionLeg = affCommissionRes.data;
  const affLeaderboardLeg = affLeaderboardRes.data;
  const haveCanonicalSplit =
    affCommissionLeg != null && affLeaderboardLeg != null;
  const affiliateCommissionCost = haveCanonicalSplit
    ? Math.max(0, affCommissionLeg)
    : splitAffiliateCostBundle(v1.affiliateCost).commission;
  const affiliateLeaderboardCost = haveCanonicalSplit
    ? Math.max(0, affLeaderboardLeg)
    : splitAffiliateCostBundle(v1.affiliateCost).leaderboard;
  const affiliateSplitSource: "ledger" | "fallback" = haveCanonicalSplit
    ? "ledger"
    : "fallback";

  const withdrawalLedger = withdrawalRes.data;
  const estimatedWithdrawalVolumeUsd =
    withdrawalLedger?.volumeUsd ?? Math.max(0, v1.wager * 0.08);
  const balanceWithdrawalShare =
    withdrawalLedger?.balanceShare ?? DEFAULT_BALANCE_WITHDRAWAL_SHARE;

  const baselineSparse =
    v1.gameTypes.every((g) => !g.dataAvailable) ||
    v1.rakebackCost + v1.affiliateCost + v1.dailyPacksCost === 0;

  // ── Daily-pack level gates + usage ──
  const levelStats = levelStatsRes.data;
  const dailyRewardCfgs = dailyRewardCfgRes.data ?? [];
  const everyTime = everyTimeRes.data;

  const thresholdFor = (level: number): number | null => {
    if (level <= 0) return 0;
    return levelStats?.thresholds.get(level) ?? null;
  };
  const eligibleFor = (level: number): number | null => {
    if (!levelStats) return null;
    if (level <= 0) {
      // Everyone with a stats row qualifies at level 0.
      let total = 0;
      for (const [, n] of levelStats.usersAtOrAbove) {
        total = Math.max(total, n);
      }
      return total;
    }
    // usersAtOrAbove holds cumulative counts per OBSERVED level; find the
    // smallest observed level ≥ requested and use its cumulative count.
    let best: number | null = null;
    let bestLevel = Number.POSITIVE_INFINITY;
    for (const [lvl, n] of levelStats.usersAtOrAbove) {
      if (lvl >= level && lvl < bestLevel) {
        bestLevel = lvl;
        best = n;
      }
    }
    return best ?? 0;
  };

  const dailyPackLevels: DailyPackLevelInfo[] = [];
  const dailyPackUsage: DailyPackUsageInfo[] = [];
  const packCfgByPackId = new Map<
    string,
    { rewardSlug: string; levelRequired: number; relockPct: number }
  >();
  for (const cfg of dailyRewardCfgs) {
    for (const packId of cfg.packIds) {
      packCfgByPackId.set(packId, {
        rewardSlug: cfg.rewardSlug,
        levelRequired: cfg.levelRequired,
        relockPct: cfg.relockPct,
      });
    }
  }
  for (const row of v1.dailyPackRows) {
    const cfg = packCfgByPackId.get(row.packId);
    const levelRequired = cfg?.levelRequired ?? 0;
    const xpThreshold = thresholdFor(levelRequired);
    dailyPackLevels.push({
      packId: row.packId,
      rewardSlug: cfg?.rewardSlug ?? "",
      levelRequired,
      xpThreshold,
      wagerLossRequiredUsd: xpThreshold != null ? xpThreshold * XP_TO_USD : null,
      relockPctDefault: cfg?.relockPct ?? 0.01,
    });

    const eligibleUsers = eligibleFor(levelRequired);
    const et = everyTime?.get(row.packId);
    dailyPackUsage.push({
      packId: row.packId,
      opens: row.opens,
      claimers: row.claimers,
      opensPerClaimer: row.claimers > 0 ? row.opens / row.claimers : 0,
      eligibleUsers,
      claimRateVsEligible:
        eligibleUsers != null && eligibleUsers > 0
          ? Math.min(1, row.claimers / eligibleUsers)
          : null,
      everyTimeClaimerPct:
        et && et.claimers > 0 ? Math.min(1, et.everyTime / et.claimers) : null,
    });
  }

  // ── Reward-source volumes (credit-matrix rows; zero new scans) ──
  const rewardSourceVolumes: RewardSourceVolume[] = [
    { sourceId: "rain_win", label: "Rain wins", amountUsd: v1.rainWinTotal },
    { sourceId: "race_prize", label: "Race prizes", amountUsd: v1.raceCost },
    {
      sourceId: "rakeback_claim",
      label: "Rakeback claims",
      amountUsd: v1.rakebackCost,
    },
    {
      sourceId: "affiliate_claim",
      label: "Affiliate commission",
      amountUsd: affiliateCommissionCost,
    },
    {
      sourceId: "affiliate_leaderboard_prize",
      label: "Leaderboard prizes",
      amountUsd: affiliateLeaderboardCost,
    },
    {
      sourceId: "deposit_bonus",
      label: "Deposit bonus",
      amountUsd: v1.depositBonusCost,
    },
    {
      sourceId: "motha",
      label: "Giveaways / tips (motha)",
      amountUsd: v1.mothaCost,
    },
  ].filter((s) => s.amountUsd > 0);

  return {
    ...v1,
    totalWager: canonical?.wager ?? v1.wager,
    // Organic splits retired from the headline path (the rescale is gone);
    // kept for display context where sections still surface them.
    ledgerOrganicWager: 0,
    upgraderOrganicWager: 0,
    periodLabel: insightsRewardsPeriodLabel(EDGE_PLAN_V2_PERIOD),
    periodDays,
    affiliateCommissionCost,
    affiliateLeaderboardCost,
    affiliateSplitSource,
    balanceWithdrawalShare,
    estimatedWithdrawalVolumeUsd,
    withdrawalVolumeSource: withdrawalLedger ? "ledger" : "estimate",
    balanceWithdrawalShareSource: withdrawalLedger ? "ledger" : "estimate",
    baselineSparse,
    mothaBreakdown: mothaOvRes.data
      ? {
          tips: mothaOvRes.data.byChannel.tips,
          rain: mothaOvRes.data.byChannel.rain,
          sponsorship: mothaOvRes.data.byChannel.sponsorship,
          eventCount: mothaOvRes.data.count,
          activeDays: mothaOvRes.data.uniqueClaimants,
        }
      : null,
    packWagerBorrowed: borrowedRes.data?.packWagerBorrowed ?? 0,
    battleWagerBorrowed: borrowedRes.data?.battleWagerBorrowed ?? 0,

    canonical,
    ledgerMaxCreatedAt: ledgerMaxRes.data,
    depositsByAsset: depositsByAssetRes.data ?? [],
    liveRaffles: liveRafflesRes.data ?? [],
    rainAnchor: rainAnchorRes.data,
    giftCardCost: giftCardRes.data ?? 0,
    promoCodeCost: promoCodeRes.data ?? 0,
    adjustmentBreakdown: adjustmentsRes.data?.rows ?? [],
    adjustmentCountedCost: adjustmentsRes.data?.countedCost ?? 0,
    depositSizeHistogram: depositHistRes.data?.buckets ?? [],
    depositBonusMinDepositObservedUsd: depositHistRes.data?.observedMinUsd ?? null,
    timeBonusAnchor: timeBonusRes.data,
    dailyPackLevels,
    dailyPackUsage,
    rewardSourceVolumes,
  };
}

/**
 * Public entry — the cached v2 baseline. `unstable_cache` (60s) so lever
 * interaction never refires the scans; every read inside is safeQuery-
 * bounded so the page degrades per-block instead of collapsing.
 */
const cachedBaseline = unstable_cache(
  () => buildEdgePlanV2Baseline(),
  ["edge-plan-v2-baseline-overhaul-v1"],
  { revalidate: 60, tags: ["insights-analytics", "edge-plan-2"] },
);

export async function getEdgePlanV2Baseline(): Promise<EdgePlanV2Baseline> {
  return cachedBaseline();
}
