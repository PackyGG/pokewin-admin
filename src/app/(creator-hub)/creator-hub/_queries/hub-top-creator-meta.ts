import "server-only";

import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { escapeBlacklistIds } from "@/lib/queries/_blacklist";
import { type DashboardPeriod } from "@/lib/queries/dashboard-period";
import { hubSinceClause } from "./hub-period-sql";

type CountRow = { creator_id: string; value: string };

/**
 * Windowed sign-up counts for a small set of creator ids (Top Creators
 * enrichment). Sign-ups = referred users who joined in the active period.
 */
export async function getWindowedSignupsByCreatorIds(
  creatorIds: string[],
  period: DashboardPeriod,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (creatorIds.length === 0) return result;

  const db = await getDb();
  const excluded = await getExcludedUserIds();
  const blacklistAnd =
    excluded.length > 0
      ? ` AND u.id NOT IN (${escapeBlacklistIds(excluded)})`
      : "";
  const sinceSignup = hubSinceClause("u.created_at", period);
  const idList = creatorIds
    .map((id) => `'${id.replace(/'/g, "''")}'`)
    .join(",");

  const rows = await db.$queryRawUnsafe<CountRow[]>(
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
