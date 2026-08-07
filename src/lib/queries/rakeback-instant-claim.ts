import { queryMainRows } from "@/lib/drizzle-query";
import "server-only";

import { unstable_cache } from "next/cache";
import { readDbEnv } from "@/lib/db-env";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { excludeStaffCreatorsAndBlacklistedSqlFromIds } from "./_blacklist";

/**
 * Rakeback "instant claim" (early-claim / pre-claim) admin reads.
 *
 * Domain
 * ──────
 * The game backend lets a user claim accrued rakeback EARLY — before the
 * cadence period closes — in exchange for a discounted lump sum. The knobs
 * live on the game DB's `rakeback_config` table:
 *   • early_claim_payout_percent   — % of the accrued amount an instant
 *     claim pays out (e.g. 70 = the user gets 70% now, the house keeps 30%).
 *   • early_claim_cooldown_seconds — min seconds between instant claims.
 * And each `rakeback_claims` row records `last_preclaim_at` — non-NULL means
 * that claim used the instant/early-claim flow.
 *
 * COLUMN PROBE (defensive)
 * ────────────────────────
 * The early-claim feature is LIVE on prod: these columns exist on the live
 * PROD game DB and there are real instant claims on it (verified read-only,
 * 2026-06-14). It is also present on dev. The checked-in Drizzle schema
 * does NOT carry these columns, so the generated table schema cannot
 * reference them. We therefore:
 *   1. read via parameterized SQL through the env-resolved Drizzle client, and
 *   2. PROBE `information_schema.columns` first, returning a `supported:
 *      false` shape if the column is ever absent on the active env (e.g. a
 *      dev DB that hasn't been migrated) so the surface degrades gracefully
 *      instead of throwing 42703.
 * The probe is cheap defensive code and is kept; it is NOT a signal that the
 * feature is off on prod — on prod every probe returns `true`. Same pattern
 * as `getUserWagerProgress` (sweepstakes columns) and the runtime enum
 * drift-guards.
 *
 * READ-ONLY. No mutations here — editing the early-claim config requires a
 * backend admin endpoint that is not deployed (all `/admin/rakeback*` config
 * routes 404), so this module only surfaces the current state + usage.
 */

/** Selectable usage window. `all` = lifetime (no lower bound). */
export type InstantClaimPeriod = "7d" | "30d" | "90d" | "all";

export const INSTANT_CLAIM_PERIODS: InstantClaimPeriod[] = [
  "7d",
  "30d",
  "90d",
  "all",
];

export function isInstantClaimPeriod(v: unknown): v is InstantClaimPeriod {
  return v === "7d" || v === "30d" || v === "90d" || v === "all";
}

/** Whole days for a window, or null for lifetime. */
function daysForPeriod(period: InstantClaimPeriod): number | null {
  switch (period) {
    case "7d":
      return 7;
    case "30d":
      return 30;
    case "90d":
      return 90;
    case "all":
      return null;
  }
}

export function instantClaimPeriodLabel(period: InstantClaimPeriod): string {
  switch (period) {
    case "7d":
      return "Last 7 days";
    case "30d":
      return "Last 30 days";
    case "90d":
      return "Last 90 days";
    case "all":
      return "All time";
  }
}

/** Default instant payout when config is unavailable (30% house fee → 70% paid). */
export const DEFAULT_INSTANT_CLAIM_PAYOUT_PERCENT = 70;

/**
 * Reverse the instant-claim discount: paid amount → full accrued rakeback
 * before the early-claim fee. `payoutPercent` is the % of accrued the user
 * receives (e.g. 70 = 30% fee).
 */
export function accruedRakebackBeforeInstantFee(
  paidUsd: number,
  payoutPercent: number = DEFAULT_INSTANT_CLAIM_PAYOUT_PERCENT,
): number {
  if (!Number.isFinite(paidUsd) || paidUsd <= 0) return 0;
  if (!Number.isFinite(payoutPercent) || payoutPercent <= 0 || payoutPercent > 100) {
    return paidUsd;
  }
  return paidUsd / (payoutPercent / 100);
}

/** Build a lookup of instant payout % by rakeback cadence type. */
export function instantClaimPayoutPercentByType(
  config: InstantClaimConfig,
): Map<string, number> {
  const map = new Map<string, number>();
  if (!config.supported) return map;
  for (const tier of config.tiers) {
    if (tier.earlyClaimPayoutPercent > 0) {
      map.set(tier.type, tier.earlyClaimPayoutPercent);
    }
  }
  return map;
}

export function instantClaimPayoutPercentForType(
  payoutByType: Map<string, number>,
  rakebackType: string,
): number {
  return payoutByType.get(rakebackType) ?? DEFAULT_INSTANT_CLAIM_PAYOUT_PERCENT;
}

/** Per-cadence early-claim config, read from `rakeback_config`. */
export type InstantClaimTierConfig = {
  type: string;
  displayName: string;
  enabled: boolean;
  /** % of accrued rakeback an instant claim pays out (0..100). */
  earlyClaimPayoutPercent: number;
  /** Min seconds between instant claims. */
  earlyClaimCooldownSeconds: number;
};

/**
 * Early-claim config per cadence. `{ supported: false }` only when the
 * active DB env lacks the early-claim columns (→ muted degraded card); the
 * columns ARE present on prod, where the feature is live.
 */
export type InstantClaimConfig =
  | { supported: true; tiers: InstantClaimTierConfig[] }
  | { supported: false };

/** Aggregated instant-claim usage over the active window. */
export type InstantClaimUsage =
  | {
      supported: true;
      period: InstantClaimPeriod;
      /** Claims that used the instant/early-claim flow. */
      instantCount: number;
      /** Distinct users who made at least one instant claim in the window. */
      instantUniqueUsers: number;
      /** All settled (claimed) rakeback claims in the window. */
      totalClaimCount: number;
      /** $ paid out via instant claims (rakeback amount). */
      instantAmountUsd: number;
      /** $ retained by the house via the instant-claim fee (accrued − paid). */
      instantSavedUsd: number;
      /** $ paid out across all settled claims in the window. */
      totalAmountUsd: number;
      /** instantCount / totalClaimCount, 0..1 (0 when no claims). */
      instantShareByCount: number;
      /** instantAmountUsd / totalAmountUsd, 0..1 (0 when no $). */
      instantShareByAmount: number;
      /** Per-cadence instant-claim split. */
      byType: {
        type: string;
        instantCount: number;
        instantAmountUsd: number;
      }[];
    }
  | { supported: false };

type ColExistsRow = { exists: boolean };

async function columnExists(
  table: string,
  column: string,
): Promise<boolean> {
  const rows = await queryMainRows<ColExistsRow[]>(
    `SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
        AND column_name = $2
    ) AS exists`,
    table,
    column,
  );
  return rows[0]?.exists === true;
}

/**
 * Read the per-cadence early-claim config from `rakeback_config`. Returns
 * `{ supported: false }` only if the early-claim columns are absent on the
 * active DB env (they ARE present on prod — this guards an unmigrated dev
 * env). Read-only.
 */
async function queryRakebackInstantClaimConfig(): Promise<InstantClaimConfig> {
  // Probe the gating column once — if the payout column is missing the
  // whole early-claim feature is absent on this env.
  if (!(await columnExists("rakeback_config", "early_claim_payout_percent"))) {
    return { supported: false };
  }

  const rows = await queryMainRows<
    {
      type: string;
      display_name: string;
      enabled: boolean;
      early_claim_payout_percent: string | null;
      early_claim_cooldown_seconds: number | null;
    }[]
  >(
    `SELECT
      type::text                        AS type,
      display_name                      AS display_name,
      enabled                           AS enabled,
      early_claim_payout_percent::text  AS early_claim_payout_percent,
      early_claim_cooldown_seconds      AS early_claim_cooldown_seconds
    FROM rakeback_config
    ORDER BY type ASC`,
  );

  return {
    supported: true,
    tiers: rows.map((r) => ({
      type: r.type,
      displayName: r.display_name,
      enabled: r.enabled,
      earlyClaimPayoutPercent: r.early_claim_payout_percent
        ? Number(r.early_claim_payout_percent)
        : 0,
      earlyClaimCooldownSeconds: r.early_claim_cooldown_seconds ?? 0,
    })),
  };
}

/**
 * Aggregate instant-claim usage over the ACTIVE window only (active-
 * timeframe-only — the page never preloads other windows). Returns
 * `{ supported: false }` only if `rakeback_claims.last_preclaim_at` is
 * absent on the active DB env (it IS present on prod — this guards an
 * unmigrated dev env).
 *
 * Scope: canonical CUSTOMER population (staff + creators + blacklist
 * excluded), per `getMetricsScope`. NOTE: the /insights/rewards/rakeback
 * overview modules currently use the wider staff-only exclusion
 * (`role NOT IN ('admin','support')`, creators KEPT), so this block's
 * total-paid is creator-excluding while that surface's headline is
 * creator-including — they can differ by the creator-claimed amount. See
 * the owner-sign-off proposal to align the overview (insights-rewards
 * rakeback overview.ts).
 */
async function queryRakebackInstantClaimUsage(
  period: InstantClaimPeriod,
): Promise<InstantClaimUsage> {
  // Run the two cheap column probes + the exclusion-id resolution
  // concurrently (they're independent) instead of three serial round-trips.
  const [hasPreclaim, excludedIds, hasPayoutPercent] = await Promise.all([
    columnExists("rakeback_claims", "last_preclaim_at"),
    getExcludedUserIds(),
    columnExists("rakeback_config", "early_claim_payout_percent"),
  ]);

  if (!hasPreclaim) {
    return { supported: false };
  }

  const days = daysForPeriod(period);
  const scopeSql = excludeStaffCreatorsAndBlacklistedSqlFromIds(excludedIds);

  // Per-row fee retained: paid × (100 − payout%) / payout%
  const savedExpr = hasPayoutPercent
    ? `rc.rakeback_amount_usd::numeric * (100 - COALESCE(cfg.early_claim_payout_percent::numeric, ${DEFAULT_INSTANT_CLAIM_PAYOUT_PERCENT})) / NULLIF(COALESCE(cfg.early_claim_payout_percent::numeric, ${DEFAULT_INSTANT_CLAIM_PAYOUT_PERCENT}), 0)`
    : `rc.rakeback_amount_usd::numeric * (100 - ${DEFAULT_INSTANT_CLAIM_PAYOUT_PERCENT}) / ${DEFAULT_INSTANT_CLAIM_PAYOUT_PERCENT}`;

  const configJoin = hasPayoutPercent
    ? "LEFT JOIN rakeback_config cfg ON cfg.type = rc.rakeback_type"
    : "";

  // Window on `claimed_at` (the settlement time) — an instant claim is still
  // a settled claim, so "share of claims that were instant" compares
  // like-for-like settled rows. Lifetime ("all") has no lower bound.
  const windowSql =
    days === null
      ? ""
      : `AND claimed_at >= now() - interval '${days} days'`;

  // The headline aggregate and the per-cadence breakdown are independent
  // scans of the same window — run them concurrently so a cold load pays one
  // round-trip's latency, not two in series.
  const [aggRows, byTypeRows] = await Promise.all([
    queryMainRows<
      {
        total_count: string;
        instant_count: string;
        instant_users: string;
        total_usd: string | null;
        instant_usd: string | null;
        instant_saved_usd: string | null;
      }[]
    >(
      `SELECT
       COUNT(*)::bigint                                                        AS total_count,
       COUNT(rc.last_preclaim_at)::bigint                                      AS instant_count,
       COUNT(DISTINCT rc.user_id) FILTER (WHERE rc.last_preclaim_at IS NOT NULL)::bigint AS instant_users,
       COALESCE(SUM(rc.rakeback_amount_usd), 0)::text                           AS total_usd,
       COALESCE(SUM(rc.rakeback_amount_usd) FILTER (WHERE rc.last_preclaim_at IS NOT NULL), 0)::text AS instant_usd,
       COALESCE(SUM(${savedExpr}) FILTER (WHERE rc.last_preclaim_at IS NOT NULL), 0)::text AS instant_saved_usd
     FROM rakeback_claims rc
     ${configJoin}
     WHERE rc.claimed_at IS NOT NULL
       ${windowSql}
       AND ${scopeSql}`,
    ),
    queryMainRows<
      { type: string; instant_count: string; instant_usd: string | null }[]
    >(
      `SELECT
       rc.rakeback_type::text                                         AS type,
       COUNT(*)::bigint                                               AS instant_count,
       COALESCE(SUM(rc.rakeback_amount_usd), 0)::text                 AS instant_usd
     FROM rakeback_claims rc
     WHERE rc.claimed_at IS NOT NULL
       AND rc.last_preclaim_at IS NOT NULL
       ${windowSql}
       AND ${scopeSql}
     GROUP BY rc.rakeback_type
     ORDER BY rc.rakeback_type ASC`,
    ),
  ]);

  const agg = aggRows[0];
  const totalClaimCount = agg ? Number(agg.total_count) : 0;
  const instantCount = agg ? Number(agg.instant_count) : 0;
  const instantUniqueUsers = agg ? Number(agg.instant_users) : 0;
  const totalAmountUsd = agg ? Number(agg.total_usd ?? 0) : 0;
  const instantAmountUsd = agg ? Number(agg.instant_usd ?? 0) : 0;
  const instantSavedUsd = agg ? Number(agg.instant_saved_usd ?? 0) : 0;

  return {
    supported: true,
    period,
    instantCount,
    instantUniqueUsers,
    totalClaimCount,
    instantAmountUsd,
    instantSavedUsd,
    totalAmountUsd,
    instantShareByCount:
      totalClaimCount > 0 ? instantCount / totalClaimCount : 0,
    instantShareByAmount:
      totalAmountUsd > 0 ? instantAmountUsd / totalAmountUsd : 0,
    byType: byTypeRows.map((r) => ({
      type: r.type,
      instantCount: Number(r.instant_count),
      instantAmountUsd: Number(r.instant_usd ?? 0),
    })),
  };
}

// ─── Prod-only cache wrappers (mirror shard-pack-opens.ts) ─────────────
//
// Both reads are result-identical when cached: the early-claim config + the
// `rakeback_claims` aggregates are only ever mutated by the GAME backend
// (the admin panel has no write path here — config edits 404, claims are
// read-only), so there is no admin mutation to invalidate against. The page
// already wraps these in `safeQuery` + a 15s timeout; caching just removes the
// repeated raw scans (the `all` window is an unbounded lifetime aggregate over
// `rakeback_claims`).
//
// `unstable_cache` runs its callback OUTSIDE the request's dynamic scope, so
// `cookies()` (and `readDbEnv` inside the client resolver) falls back to "prod". Caching
// a dev-toggled request would serve PROD data to a dev admin, so we cache ONLY
// on prod (the default + hot path); a dev-toggled admin runs the query
// directly. Payloads are all-primitive shapes, so the cache JSON round-trip is
// lossless.

const cachedInstantClaimConfig = unstable_cache(
  () => queryRakebackInstantClaimConfig(),
  ["rakeback-instant-claim-config-v1"],
  { revalidate: 60, tags: ["rakeback-instant-claim"] },
);

/**
 * Public entry point for the per-cadence early-claim config. Cached 60s on
 * prod; direct (uncached) on a dev-toggled admin so they see live dev data.
 */
export async function getRakebackInstantClaimConfig(): Promise<InstantClaimConfig> {
  const env = await readDbEnv();
  if (env !== "prod") return queryRakebackInstantClaimConfig();
  return cachedInstantClaimConfig();
}

// Active short windows share a 60s TTL keyed on the period; the heavier
// lifetime ("all") window gets its own 300s cache so paginating/refreshing
// doesn't re-run the unbounded aggregate every load. Active-timeframe-only is
// preserved: only the requested period is fetched + cached.
const cachedInstantClaimUsage = unstable_cache(
  (period: InstantClaimPeriod) => queryRakebackInstantClaimUsage(period),
  ["rakeback-instant-claim-usage-v1"],
  { revalidate: 60, tags: ["rakeback-instant-claim"] },
);

const cachedInstantClaimUsageAll = unstable_cache(
  () => queryRakebackInstantClaimUsage("all"),
  ["rakeback-instant-claim-usage-all-v1"],
  { revalidate: 300, tags: ["rakeback-instant-claim"] },
);

/**
 * Public entry point for instant-claim usage over the ACTIVE window. Cached on
 * prod (60s for the short windows, 300s for the lifetime aggregate); direct on
 * a dev-toggled admin. ACTIVE-TIMEFRAME-ONLY: only the requested window is
 * fetched/cached.
 */
export async function getRakebackInstantClaimUsage(
  period: InstantClaimPeriod,
): Promise<InstantClaimUsage> {
  const env = await readDbEnv();
  if (env !== "prod") return queryRakebackInstantClaimUsage(period);
  if (period === "all") return cachedInstantClaimUsageAll();
  return cachedInstantClaimUsage(period);
}
