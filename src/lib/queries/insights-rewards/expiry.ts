import { blacklistNotInSql, queryRows, sql } from "@/lib/queries/insights-rewards/_drizzle-query";
import { unstable_cache } from "next/cache";
import { getDrizzleDb } from "@/lib/db";
import { readDbEnv } from "@/lib/db-env";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { toNumber } from "@/lib/utils/decimal";
import {
  daysForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";

/**
 * Reward-expiry insights — RAKEBACK-SCOPED MVP.
 *
 * ──────────────────────────────────────────────────────────────────────
 * WHY THIS IS NARROW (verified against live prod, 2026-06-14)
 * ──────────────────────────────────────────────────────────────────────
 * The original brief asked for an "at risk (unclaimed, expiring in 24h)"
 * and "lost (unclaimed, expired)" view derived from
 * `rakeback_claims.claimed_at IS NULL`. That model does NOT hold:
 *
 *   - `rakeback_claims.claimed_at` is technically NULLABLE, but on live
 *     prod EVERY row (8,663/8,663) has `claimed_at` set, and for EVERY
 *     row `claimed_at = created_at`. The row is materialised at the
 *     instant of claim — there is no persisted "accrued-but-unclaimed"
 *     row that could later expire.
 *   - Confirmed by the backend contract too: pending rakeback is computed
 *     LIVE from wager history at claim time and "shrinks rakeback on
 *     still-unclaimed periods, never settled claims"
 *     (`src/lib/backend-api/source-wager-weights.ts`), and reward-expiry
 *     windows are "enforced at claim time only … already-settled claims
 *     are never re-touched" (`src/lib/backend-api/reward-expiry.ts`).
 *
 * So the dollar amount of rakeback that expires UNCLAIMED is not stored
 * anywhere this admin can read — neither in the Admin DB, the Main DB,
 * nor any current backend admin endpoint (the endpoint exposes the
 * window CONFIG, not pending balances). Building an "at risk / lost
 * unclaimed" panel would mean rendering a fabricated or always-zero
 * number that misrepresents reality. We do NOT do that.
 *
 * WHAT WE TRUTHFULLY SURFACE INSTEAD
 *   1. The live expiry CONFIG per rakeback type (claim window in days,
 *      read straight from `rakeback_config.expiration_days`). This is the
 *      lever the admin already controls on /security/reward-expiry but
 *      previously had no visibility into the consequences of.
 *   2. "Forfeited-by-lapsing" — a behavioural proxy built from the
 *      claim history that DOES exist: users who claimed in the prior-
 *      equal window and then stopped (their prior-window rakeback is the
 *      best available signal for program value the user walked away from).
 *      This reuses the same claim-history math as the rakeback "lapsed"
 *      tab, scoped here to the program-effectiveness angle.
 *
 * Other reward types (race / leaderboard / balance) expose claim windows
 * too (`reward-expiry.ts`) but have no admin-readable claim-linkage that
 * cleanly separates "expired unclaimed" from "never earned" — flagged as
 * a follow-up on the page, NOT fabricated here.
 *
 * HOUSE-POV COLOUR NOTE
 *   Rakeback owed to a user is a house COST. Money still on the table the
 *   user MIGHT yet claim leans rose (we may still pay it). But value the
 *   user FORFEITED by never claiming is not a clean house win — the house
 *   technically keeps the cash, yet it represents WASTED MARKETING SPEND
 *   (a retention lever that failed to land). So the page frames forfeited
 *   value in AMBER/NEUTRAL: it is a program-effectiveness signal, not a
 *   profit line.
 *
 * Source: `rakeback_config` + `rakeback_claims` (Main DB, read-only).
 * Customer scope: staff (admin/support) excluded inline + dynamic
 * `excluded_users` blacklist, matching the rest of the rakeback surface.
 */

const DRIFT_GUARD_CACHE_MS = 5 * 60 * 1000;

/** Per-type live claim window, in whole days after the period ends. */
export type RakebackExpiryWindow = {
  type: "daily" | "weekly" | "monthly";
  displayName: string;
  /** Whole days after the period ends that the claim stays claimable. */
  expirationDays: number | null;
  enabled: boolean;
};

/** A single lapsed-claimant cohort row (forfeited-by-lapsing proxy). */
export type ForfeitedLapsedRow = {
  userId: string;
  username: string | null;
  priorRakeback: number;
  priorClaims: number;
  lastClaimedAt: string | null;
};

export type RakebackForfeited = {
  /** Users who claimed in the prior-equal window and then stopped. */
  totalLapsedUsers: number;
  /** Sum of their prior-window rakeback = value they walked away from. */
  totalForfeitedValue: number;
  /** Top 25 by prior rakeback, for the detail table. */
  sampleUsers: ForfeitedLapsedRow[];
  /** Per-type split of the forfeited value. */
  byType: {
    type: "daily" | "weekly" | "monthly";
    forfeitedValue: number;
    lapsedClaims: number;
  }[];
};

export type RakebackExpiryData = {
  /** Live expiry config per rakeback type. */
  windows: RakebackExpiryWindow[];
  /**
   * Whether `rakeback_config.expiration_days` exists on the live DB. If a
   * drifted DB lacks it, windows render muted ("not configured") rather
   * than throwing 42703.
   */
  expirationConfigured: boolean;
  /** Behavioural forfeited-by-lapsing proxy for the active window. */
  forfeited: RakebackForfeited | null;
};

/** Whether `rakeback_config.expiration_days` exists on the live DB. */
let driftCache: { has: boolean; at: number } | null = null;

async function hasExpirationDaysColumn(): Promise<boolean> {
  const now = Date.now();
  if (driftCache && now - driftCache.at < DRIFT_GUARD_CACHE_MS) {
    return driftCache.has;
  }
  const db = await getDrizzleDb();
  try {
    const rows = await queryRows<{ exists: boolean }[]>(db, sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'rakeback_config'
          AND column_name = 'expiration_days'
      ) AS exists
    `);
    const has = rows[0]?.exists === true;
    driftCache = { has, at: now };
    return has;
  } catch {
    // If the probe itself fails, degrade to "not configured" rather than
    // letting the page throw.
    driftCache = { has: false, at: now };
    return false;
  }
}

async function fetchWindows(): Promise<{
  windows: RakebackExpiryWindow[];
  expirationConfigured: boolean;
}> {
  const db = await getDrizzleDb();
  const hasExp = await hasExpirationDaysColumn();

  // Only SELECT expiration_days when it exists — keeps a drifted DB from
  // throwing 42703 (undefined column).
  const expSelect = hasExp ? "expiration_days" : "NULL::int AS expiration_days";
  const rows = await queryRows<
    {
      type: string;
      display_name: string;
      expiration_days: number | null;
      enabled: boolean;
    }[]
  >(db, sql`
    SELECT type::text AS type, display_name, ${sql.raw(expSelect)}, enabled
    FROM rakeback_config
    ORDER BY CASE type::text
      WHEN 'daily' THEN 1 WHEN 'weekly' THEN 2 WHEN 'monthly' THEN 3 ELSE 4 END
  `);

  const windows: RakebackExpiryWindow[] = rows
    .filter(
      (r): r is typeof r & { type: "daily" | "weekly" | "monthly" } =>
        r.type === "daily" || r.type === "weekly" || r.type === "monthly",
    )
    .map((r) => ({
      type: r.type,
      displayName: r.display_name,
      expirationDays:
        r.expiration_days != null ? Number(r.expiration_days) : null,
      enabled: r.enabled,
    }));

  return { windows, expirationConfigured: hasExp };
}

/**
 * Forfeited-by-lapsing proxy. Users who claimed rakeback in the prior-
 * equal window but NOT in the current window — their prior-window
 * rakeback is the best available read on program value the user walked
 * away from. Lifetime windows have no prior frame → null.
 *
 * Mirrors the staff + blacklist exclusion of the rest of the rakeback
 * surface so the numbers reconcile.
 */
async function computeForfeited(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<RakebackForfeited | null> {
  const days = daysForInsightsPeriod(period);
  if (days === null) return null;
  const db = await getDrizzleDb();
  const blacklistJoin = blacklistNotInSql("u.id", blacklistIds);

  // current_users: anyone who claimed in the current window.
  // prior_lapsed: claimers in the prior-equal window with > 0 rakeback.
  // lapsed = prior_lapsed minus current_users.
  const rows = await queryRows<
    {
      user_id: string;
      username: string | null;
      prior_rakeback: string;
      prior_claims: string;
      last_claimed_at: Date | string | null;
    }[]
  >(db, sql`
    WITH current_users AS (
      SELECT DISTINCT rc.user_id
      FROM rakeback_claims rc
      JOIN "user" u ON u.id = rc.user_id
      WHERE rc.claimed_at IS NOT NULL
        AND u.role NOT IN ('admin', 'support') ${blacklistJoin}
        AND rc.claimed_at >= NOW() - (${days} * INTERVAL '1 day')
    ),
    prior_lapsed AS (
      SELECT
        rc.user_id,
        SUM(rc.rakeback_amount_usd::numeric) AS prior_rakeback,
        COUNT(*) AS prior_claims,
        MAX(rc.claimed_at) AS last_claimed_at
      FROM rakeback_claims rc
      JOIN "user" u ON u.id = rc.user_id
      WHERE rc.claimed_at IS NOT NULL
        AND u.role NOT IN ('admin', 'support') ${blacklistJoin}
        AND rc.claimed_at >= NOW() - (${days * 2} * INTERVAL '1 day')
        AND rc.claimed_at <  NOW() - (${days} * INTERVAL '1 day')
      GROUP BY rc.user_id
      HAVING SUM(rc.rakeback_amount_usd::numeric) > 0
    )
    SELECT
      p.user_id,
      u.username,
      p.prior_rakeback::text AS prior_rakeback,
      p.prior_claims::text AS prior_claims,
      p.last_claimed_at AS last_claimed_at
    FROM prior_lapsed p
    JOIN "user" u ON u.id = p.user_id
    WHERE NOT EXISTS (
      SELECT 1 FROM current_users c WHERE c.user_id = p.user_id
    )
    ORDER BY p.prior_rakeback DESC
  `);

  // Per-type split of the forfeited value (prior-window rakeback by type
  // for the lapsed users only).
  const lapsedIds = rows.map((r) => r.user_id);
  let byType: RakebackForfeited["byType"] = [];
  if (lapsedIds.length > 0) {
    const typeRows = await queryRows<
      { rakeback_type: string; forfeited: string; claims: string }[]
    >(db, sql`
      SELECT
        rc.rakeback_type::text AS rakeback_type,
        SUM(rc.rakeback_amount_usd::numeric)::text AS forfeited,
        COUNT(*)::text AS claims
      FROM rakeback_claims rc
      WHERE rc.claimed_at IS NOT NULL
        AND rc.user_id IN (${sql.join(
          lapsedIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
        AND rc.claimed_at >= NOW() - (${days * 2} * INTERVAL '1 day')
        AND rc.claimed_at <  NOW() - (${days} * INTERVAL '1 day')
      GROUP BY rc.rakeback_type
    `);
    byType = typeRows
      .filter(
        (r): r is typeof r & { rakeback_type: "daily" | "weekly" | "monthly" } =>
          r.rakeback_type === "daily" ||
          r.rakeback_type === "weekly" ||
          r.rakeback_type === "monthly",
      )
      .map((r) => ({
        type: r.rakeback_type,
        forfeitedValue: toNumber(r.forfeited),
        lapsedClaims: Number(r.claims),
      }))
      .sort((a, b) => b.forfeitedValue - a.forfeitedValue);
  }

  let totalForfeited = 0;
  const sampleUsers: ForfeitedLapsedRow[] = [];
  for (const r of rows) {
    const prior = toNumber(r.prior_rakeback);
    totalForfeited += prior;
    if (sampleUsers.length < 25) {
      const last =
        r.last_claimed_at == null
          ? null
          : r.last_claimed_at instanceof Date
            ? r.last_claimed_at.toISOString()
            : String(r.last_claimed_at);
      sampleUsers.push({
        userId: r.user_id,
        username: r.username,
        priorRakeback: prior,
        priorClaims: Number(r.prior_claims),
        lastClaimedAt: last,
      });
    }
  }

  return {
    totalLapsedUsers: rows.length,
    totalForfeitedValue: totalForfeited,
    sampleUsers,
    byType,
  };
}

async function computeExpiry(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<RakebackExpiryData> {
  const [{ windows, expirationConfigured }, forfeited] = await Promise.all([
    fetchWindows(),
    computeForfeited(period, blacklistIds),
  ]);
  return { windows, expirationConfigured, forfeited };
}

// ENV-KEYED cache (mirrors users-detail-cache.ts): cache ONLY on prod so a
// dev-toggled admin always sees live dev data instead of a prod-warmed
// entry. `unstable_cache` runs outside the request scope, so the cached
// callback's getDrizzleDb() resolves to prod regardless — caching it for a dev
// admin would serve them prod numbers. Short layer for finite windows,
// long layer for the lifetime sweep.
const cachedShort = unstable_cache(
  (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeExpiry(period, blacklistIds),
  ["insights-rewards-expiry-v1"],
  { revalidate: 60, tags: ["rewards-analytics", "insights-rewards-rakeback"] },
);

const cachedLong = unstable_cache(
  (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeExpiry(period, blacklistIds),
  ["insights-rewards-expiry-lifetime-v1"],
  { revalidate: 300, tags: ["rewards-analytics", "insights-rewards-rakeback"] },
);

export async function getRakebackExpiry(
  period: InsightsRewardsPeriod,
): Promise<RakebackExpiryData> {
  const env = await readDbEnv();
  const blacklist = await getExcludedUserIds();
  const sorted = [...blacklist].sort();
  if (env !== "prod") return computeExpiry(period, sorted);
  return period === "all"
    ? cachedLong(period, sorted)
    : cachedShort(period, sorted);
}
