import "server-only";

import { unstable_cache } from "next/cache";
import { readDrizzleForEnv, getReadDrizzleDb } from "@/lib/db";
import { queryRows } from "@/lib/drizzle-query";
import { readDbEnv, type DbEnv } from "@/lib/db-env";
import { toNumber } from "@/lib/utils/decimal";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { escapeBlacklistIds } from "@/lib/queries/_blacklist";
import { type DashboardPeriod } from "@/lib/queries/dashboard-period";
import {
  TOP_CREATORS_PERIODS,
  topCreatorsSinceClause,
  type TopCreatorsPeriod,
} from "../_lib/top-creators-period";
import { hubSinceClause, hubPeriodToSinceDate } from "./hub-period-sql";

type SignupWindowPeriod = DashboardPeriod | TopCreatorsPeriod;

function signupSinceClause(col: string, period: SignupWindowPeriod): string {
  if ((TOP_CREATORS_PERIODS as readonly string[]).includes(period)) {
    return topCreatorsSinceClause(col, period as TopCreatorsPeriod);
  }
  return hubSinceClause(col, period as DashboardPeriod);
}

type CountRow = { creator_id: string; value: string };
type LeaderRow = {
  creator_id: string;
  username: string | null;
  value: string;
};

export type HubSignupLeader = {
  creatorUserId: string;
  username: string | null;
  signups: number;
};

/**
 * Windowed sign-up counts for a small set of creator ids (Top Creators
 * enrichment). Sign-ups = referred users who joined in the active period.
 */
export async function getWindowedSignupsByCreatorIds(
  creatorIds: string[],
  period: SignupWindowPeriod,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (creatorIds.length === 0) return result;

  const db = await getReadDrizzleDb();
  const excluded = await getExcludedUserIds();
  const blacklistAnd =
    excluded.length > 0
      ? ` AND u.id NOT IN (${escapeBlacklistIds(excluded)})`
      : "";
  const sinceSignup = signupSinceClause("u.created_at", period);
  const idList = creatorIds
    .map((id) => `'${id.replace(/'/g, "''")}'`)
    .join(",");

  const rows = await queryRows<CountRow[]>(db,
    `SELECT u.referred_by AS creator_id, COUNT(*)::text AS value
       FROM "user" u
       JOIN "user" c ON c.id = u.referred_by AND c.role = 'creator'
      WHERE u.referred_by IN (${idList})
        AND u.role NOT IN ('admin', 'support', 'creator')
        AND u.referred_by IS NOT NULL
        ${sinceSignup}
        ${blacklistAnd}
      GROUP BY u.referred_by`,
  );

  for (const row of rows) {
    result.set(row.creator_id, toNumber(row.value));
  }
  return result;
}

async function fetchTopSignupLeaders(
  period: DashboardPeriod,
  limit: number,
  env: DbEnv,
): Promise<HubSignupLeader[]> {
  const db = readDrizzleForEnv(env);
  const excluded = await getExcludedUserIds();
  const blacklistAnd =
    excluded.length > 0
      ? ` AND u.id NOT IN (${escapeBlacklistIds(excluded)})`
      : "";
  // Anchor BOTH engines to one instant for deterministic parity.
  const since = hubPeriodToSinceDate(period);
  const sinceSignup = `AND u.created_at >= '${since.toISOString()}'::timestamptz`;

  const rows = await queryRows<LeaderRow[]>(db,
        `SELECT u.referred_by AS creator_id,
            c.username,
            COUNT(*)::text AS value
       FROM "user" u
       JOIN "user" c ON c.id = u.referred_by AND c.role = 'creator'
      WHERE u.role NOT IN ('admin', 'support', 'creator')
        AND u.referred_by IS NOT NULL
        ${sinceSignup}
        ${blacklistAnd}
      GROUP BY u.referred_by, c.username
      ORDER BY COUNT(*) DESC
      LIMIT ${limit}`,
      );

  return rows.map((r) => ({
    creatorUserId: r.creator_id,
    username: r.username,
    signups: toNumber(r.value),
  }));
}

/**
 * Top creators by referred sign-ups in the overview window (KPI popover).
 *
 * Cached (60s, env-keyed) mirroring the sibling `getHubTopCreatorsByDeposits`:
 * this runs on every Creator Hub dashboard render (it's awaited in the
 * Overview section's `Promise.all`), so an uncached run paid a full
 * `"user"`-self-join scan each time. `env`/`blacklistKey` are resolved in the
 * request scope and folded into the cache key, and the inner fetch uses the
 * env-pinned Drizzle clients (not the request-scoped resolver, which
 * resolves to "prod" inside `unstable_cache` and would leak prod data to a
 * dev-toggled admin). The `HubSignupLeader[]` result is all-primitive (no
 * `Date` fields), so the `unstable_cache` JSON round-trip is identity-safe.
 */
export async function getTopSignupLeaders(
  period: DashboardPeriod,
  limit = 5,
): Promise<HubSignupLeader[]> {
  const env = await readDbEnv();
  const excluded = await getExcludedUserIds();
  const blacklistKey =
    excluded.length > 0 ? escapeBlacklistIds(excluded) : "none";

  return unstable_cache(
    () => fetchTopSignupLeaders(period, limit, env),
    [
      "hub-top-signup-leaders-v1",
      period,
      String(limit),
      env,
      blacklistKey,
    ],
    { revalidate: 60, tags: ["creator-hub"] },
  )();
}
