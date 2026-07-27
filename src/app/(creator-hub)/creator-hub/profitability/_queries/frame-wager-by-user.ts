import "server-only";

import { unstable_cache } from "next/cache";

import { readDrizzleForEnv } from "@/lib/db";
import { queryRows } from "@/lib/drizzle-query";
import { readDbEnv, type DbEnv } from "@/lib/db-env";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { toNumber } from "@/lib/utils/decimal";

/** One creator's deal-frame window — the wager is summed inside [start, end]. */
export type FrameWindow = {
  userId: string;
  startIso: string;
  endIso: string;
};

/**
 * Code-cohort affiliate wager per creator, summed strictly INSIDE each
 * creator's own deal-frame window. One indexed pass over
 * `affiliate_code_usages` (Bitmap Index Scan on
 * `idx_affiliate_code_usages_affiliate_referred`, EXPLAIN-verified) — the
 * per-creator [start, end] bounds are joined in via a VALUES list so a
 * single round-trip covers the whole roster. Staff/creator roles, self-play
 * AND the `excluded_users` blacklist are excluded — the SAME scope the
 * deposit leg (`frame-affiliate-pnl-by-user`) applies, so the Creator
 * Wager / Expected Wager / Avg Conversion top-bar boxes never count a
 * user the deposits leg already drops.
 */
const cachedFrameWager = (
  env: DbEnv,
  frames: FrameWindow[],
  blacklistIds: string[],
) =>
  unstable_cache(
    async (): Promise<[string, number][]> => {
      const db = readDrizzleForEnv(env);

      const tuples: string[] = [];
      const params: unknown[] = [];
      frames.forEach((f, i) => {
        const b = i * 3;
        tuples.push(`($${b + 1}::text, $${b + 2}::timestamptz, $${b + 3}::timestamptz)`);
        params.push(f.userId, f.startIso, f.endIso);
      });

      const blacklistAnd =
        blacklistIds.length > 0
          ? ` AND NOT (u.id = ANY($${params.length + 1}::text[]))`
          : "";
      if (blacklistIds.length > 0) params.push(blacklistIds);

      const rows = await queryRows<
        { affiliate_user_id: string; wager: string }[]
      >(db,
        `SELECT acu.affiliate_user_id,
                COALESCE(SUM(acu.wager_amount_usd::numeric), 0)::text AS wager
           FROM affiliate_code_usages acu
           JOIN "user" u ON u.id = acu.referred_user_id
           JOIN (VALUES ${tuples.join(", ")}) AS f(cid, start_ts, end_ts)
             ON f.cid = acu.affiliate_user_id
          WHERE acu.usage_type = 'wager'
            AND u.role NOT IN ('admin', 'support', 'creator')
            AND u.id <> acu.affiliate_user_id${blacklistAnd}
            AND acu.created_at >= f.start_ts
            AND acu.created_at <= f.end_ts
          GROUP BY acu.affiliate_user_id`,
        ...params,
      );

      return rows.map((r) => [r.affiliate_user_id, toNumber(r.wager)]);
    },
    [
      "profitability-frame-wager-v2",
      env,
      ...frames.map((f) => `${f.userId}:${f.startIso}:${f.endIso}`),
      ...blacklistIds,
    ],
    { revalidate: 180, tags: ["profitability-frame-wager"] },
  );

export async function getFrameWagerByUser(
  frames: FrameWindow[],
): Promise<Map<string, number>> {
  if (frames.length === 0) return new Map();
  const env = await readDbEnv();
  const blacklistIds = await getExcludedUserIds();
  const entries = await cachedFrameWager(env, frames, blacklistIds)();
  return new Map(entries);
}
