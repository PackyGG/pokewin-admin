import "server-only";

import { unstable_cache } from "next/cache";

import { getDevDb, getProdDb } from "@/lib/db";
import { readDbEnv, type DbEnv } from "@/lib/db-env";
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
 * single round-trip covers the whole roster. Staff + self-play excluded
 * (same gate the roster wager uses).
 */
const cachedFrameWager = (env: DbEnv, frames: FrameWindow[]) =>
  unstable_cache(
    async (): Promise<[string, number][]> => {
      const db = env === "dev" ? getDevDb() : getProdDb();

      const tuples: string[] = [];
      const params: unknown[] = [];
      frames.forEach((f, i) => {
        const b = i * 3;
        tuples.push(`($${b + 1}::text, $${b + 2}::timestamptz, $${b + 3}::timestamptz)`);
        params.push(f.userId, f.startIso, f.endIso);
      });

      const rows = await db.$queryRawUnsafe<
        { affiliate_user_id: string; wager: string }[]
      >(
        `SELECT acu.affiliate_user_id,
                COALESCE(SUM(acu.wager_amount_usd::numeric), 0)::text AS wager
           FROM affiliate_code_usages acu
           JOIN "user" u ON u.id = acu.referred_user_id
           JOIN (VALUES ${tuples.join(", ")}) AS f(cid, start_ts, end_ts)
             ON f.cid = acu.affiliate_user_id
          WHERE acu.usage_type::text = 'wager'
            AND u.role NOT IN ('admin', 'support', 'creator')
            AND u.id <> acu.affiliate_user_id
            AND acu.created_at >= f.start_ts
            AND acu.created_at <= f.end_ts
          GROUP BY acu.affiliate_user_id`,
        ...params,
      );

      return rows.map((r) => [r.affiliate_user_id, toNumber(r.wager)]);
    },
    [
      "profitability-frame-wager-v1",
      env,
      ...frames.map((f) => `${f.userId}:${f.startIso}:${f.endIso}`),
    ],
    { revalidate: 180, tags: ["profitability-frame-wager"] },
  );

export async function getFrameWagerByUser(
  frames: FrameWindow[],
): Promise<Map<string, number>> {
  if (frames.length === 0) return new Map();
  const env = await readDbEnv();
  const entries = await cachedFrameWager(env, frames)();
  return new Map(entries);
}
