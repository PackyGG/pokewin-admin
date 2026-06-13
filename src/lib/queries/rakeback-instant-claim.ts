import "server-only";

import { getDb } from "@/lib/db";
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
 * DRIFT GUARD (CRITICAL)
 * ──────────────────────
 * These columns exist on the DEV game DB but NOT (yet) on the live PROD
 * game DB — the early-claim feature is a backend roll-out in progress. The
 * committed `prisma/schema.prisma` does not carry them either, so the typed
 * Prisma client cannot reference them. We therefore:
 *   1. read via raw SQL against the env-resolved client (`getDb()`), and
 *   2. PROBE `information_schema.columns` first, returning a `supported:
 *      false` shape when the column is absent so a prod-toggled admin gets a
 *      muted "awaiting backend deploy" card instead of a 42703 throw.
 * Same pattern as `getUserWagerProgress` (sweepstakes columns) and the
 * runtime enum drift-guards.
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
 * Early-claim config per cadence, or `null` when this DB env lacks the
 * early-claim columns (→ muted "awaiting backend deploy" card).
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
      /** All settled (claimed) rakeback claims in the window. */
      totalClaimCount: number;
      /** $ paid out via instant claims (rakeback amount). */
      instantAmountUsd: number;
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
  db: Awaited<ReturnType<typeof getDb>>,
  table: string,
  column: string,
): Promise<boolean> {
  const rows = await db.$queryRaw<ColExistsRow[]>`
    SELECT EXISTS (
      SELECT 1
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = ${table}
         AND column_name = ${column}
    ) AS exists`;
  return rows[0]?.exists === true;
}

/**
 * Read the per-cadence early-claim config from `rakeback_config`. Returns
 * `{ supported: false }` when the early-claim columns are absent on this DB
 * env (prod, currently). Read-only.
 */
export async function getRakebackInstantClaimConfig(): Promise<InstantClaimConfig> {
  const db = await getDb();

  // Probe the gating column once — if the payout column is missing the
  // whole early-claim feature is absent on this env.
  if (!(await columnExists(db, "rakeback_config", "early_claim_payout_percent"))) {
    return { supported: false };
  }

  const rows = await db.$queryRaw<
    {
      type: string;
      display_name: string;
      enabled: boolean;
      early_claim_payout_percent: string | null;
      early_claim_cooldown_seconds: number | null;
    }[]
  >`
    SELECT
      type::text                        AS type,
      display_name                      AS display_name,
      enabled                           AS enabled,
      early_claim_payout_percent::text  AS early_claim_payout_percent,
      early_claim_cooldown_seconds      AS early_claim_cooldown_seconds
    FROM rakeback_config
    ORDER BY type ASC`;

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
 * `{ supported: false }` when `rakeback_claims.last_preclaim_at` is absent
 * on this DB env.
 *
 * Scope: customer population only (staff + creators + blacklist excluded),
 * matching every other rakeback money aggregate.
 */
export async function getRakebackInstantClaimUsage(
  period: InstantClaimPeriod,
): Promise<InstantClaimUsage> {
  const db = await getDb();

  if (!(await columnExists(db, "rakeback_claims", "last_preclaim_at"))) {
    return { supported: false };
  }

  const days = daysForPeriod(period);
  const scopeSql = excludeStaffCreatorsAndBlacklistedSqlFromIds(
    await getExcludedUserIds(),
  );

  // Window on `claimed_at` (the settlement time) — an instant claim is still
  // a settled claim, so "share of claims that were instant" compares
  // like-for-like settled rows. Lifetime ("all") has no lower bound.
  const windowSql =
    days === null
      ? ""
      : `AND claimed_at >= now() - interval '${days} days'`;

  const aggRows = await db.$queryRawUnsafe<
    {
      total_count: bigint;
      instant_count: bigint;
      total_usd: string | null;
      instant_usd: string | null;
    }[]
  >(
    `SELECT
       COUNT(*)::bigint                                                        AS total_count,
       COUNT(last_preclaim_at)::bigint                                         AS instant_count,
       COALESCE(SUM(rakeback_amount_usd), 0)::text                             AS total_usd,
       COALESCE(SUM(rakeback_amount_usd) FILTER (WHERE last_preclaim_at IS NOT NULL), 0)::text AS instant_usd
     FROM rakeback_claims
     WHERE claimed_at IS NOT NULL
       ${windowSql}
       AND ${scopeSql}`,
  );

  const byTypeRows = await db.$queryRawUnsafe<
    { type: string; instant_count: bigint; instant_usd: string | null }[]
  >(
    `SELECT
       rakeback_type::text                                         AS type,
       COUNT(*)::bigint                                            AS instant_count,
       COALESCE(SUM(rakeback_amount_usd), 0)::text                AS instant_usd
     FROM rakeback_claims
     WHERE claimed_at IS NOT NULL
       AND last_preclaim_at IS NOT NULL
       ${windowSql}
       AND ${scopeSql}
     GROUP BY rakeback_type
     ORDER BY rakeback_type ASC`,
  );

  const agg = aggRows[0];
  const totalClaimCount = agg ? Number(agg.total_count) : 0;
  const instantCount = agg ? Number(agg.instant_count) : 0;
  const totalAmountUsd = agg ? Number(agg.total_usd ?? 0) : 0;
  const instantAmountUsd = agg ? Number(agg.instant_usd ?? 0) : 0;

  return {
    supported: true,
    period,
    instantCount,
    totalClaimCount,
    instantAmountUsd,
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
