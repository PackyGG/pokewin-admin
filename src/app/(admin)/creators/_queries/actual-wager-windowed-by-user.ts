import "server-only";

import { unstable_cache } from "next/cache";

import { getDevDb, getProdDb } from "@/lib/db";
import { readDbEnv, type DbEnv } from "@/lib/db-env";
import { toNumber } from "@/lib/utils/decimal";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";

/**
 * Windowed wager volume booked against each creator's code over the
 * last 7 / 14 / 30 days — `acu.wager_amount_usd` for `usage_type='wager'`
 * rows, scoped to real customers (staff + creators + blacklist dropped),
 * keyed by `affiliate_user_id`.
 *
 * Powers the Creator Deal Profitability conversion check: a deal's
 * expected wager (derived from its cost) is compared against the actual
 * wager the creator drove inside the deal's payout window. The three
 * windows come back in ONE scan via CASE sums so a roster of active deals
 * costs a single round-trip.
 */
export type WindowedWager = {
  /** Σ `acu.wager_amount_usd` over the last 7 days. */
  d7: number;
  /** Σ `acu.wager_amount_usd` over the last 14 days. */
  d14: number;
  /** Σ `acu.wager_amount_usd` over the last 30 days. */
  d30: number;
};

type WindowedWagerRow = {
  creator_user_id: string;
  d7: string;
  d14: string;
  d30: string;
};

/**
 * The single windowed-wager scan behind {@link getWindowedWagerByUser},
 * wrapped in `unstable_cache` (180s revalidate — deal-profitability
 * roster metadata, a ≤3-min staleness is fine).
 *
 * Env + blacklist are env-dependent (Main-DB via the env toggle + an
 * admin-DB read) and CANNOT be resolved inside an `unstable_cache`
 * callback (it reads the request cookie), so they're resolved OUTSIDE and
 * threaded in via this factory closure — exactly how code-and-wager-by-user.ts
 * handles it. They're folded into the key parts so prod/dev and each
 * blacklist land in a separate slot; the resolved `userIds` are appended
 * after a sentinel so two id lists can't collide in the key. Returns
 * serializable entries (an `unstable_cache` callback can't store a `Map`);
 * the public helper rebuilds the Map.
 */
const cachedWindowedWagerEntries = (
  env: DbEnv,
  excludedIds: string[],
  userIds: string[],
) =>
  unstable_cache(
    async (): Promise<[string, WindowedWager][]> => {
      const db = env === "dev" ? getDevDb() : getProdDb();
      const blacklistAnd =
        excludedIds.length > 0
          ? ` AND u.id NOT IN (${excludedIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(",")})`
          : "";

      const rows = await db.$queryRawUnsafe<WindowedWagerRow[]>(
        `SELECT acu.affiliate_user_id AS creator_user_id,
                COALESCE(SUM(CASE WHEN acu.created_at >= NOW() - INTERVAL '7 days'
                                   THEN acu.wager_amount_usd::numeric ELSE 0 END), 0)::text AS d7,
                COALESCE(SUM(CASE WHEN acu.created_at >= NOW() - INTERVAL '14 days'
                                   THEN acu.wager_amount_usd::numeric ELSE 0 END), 0)::text AS d14,
                COALESCE(SUM(CASE WHEN acu.created_at >= NOW() - INTERVAL '30 days'
                                   THEN acu.wager_amount_usd::numeric ELSE 0 END), 0)::text AS d30
           FROM affiliate_code_usages acu
           JOIN "user" u ON u.id = acu.referred_user_id
          WHERE acu.usage_type::text = 'wager'
            AND u.role NOT IN ('admin', 'support', 'creator')
            AND u.id != acu.affiliate_user_id
            AND acu.affiliate_user_id = ANY($1::text[])${blacklistAnd}
          GROUP BY acu.affiliate_user_id`,
        userIds,
      );

      const byId = new Map(rows.map((r) => [r.creator_user_id, r]));

      const entries: [string, WindowedWager][] = [];
      for (const userId of userIds) {
        const row = byId.get(userId);
        entries.push([
          userId,
          {
            d7: row ? toNumber(row.d7) : 0,
            d14: row ? toNumber(row.d14) : 0,
            d30: row ? toNumber(row.d30) : 0,
          },
        ]);
      }

      return entries;
    },
    [
      "creators-windowed-wager-v1",
      env,
      ...excludedIds,
      "|users|",
      ...userIds,
    ],
    { revalidate: 180, tags: ["creators-windowed-wager"] },
  );

/**
 * Fetch the 7 / 14 / 30-day wager volume for a list of creator user_ids
 * in batch. Keyed on user_id; missing creators get a zeroed record so
 * callers can `.get(id) ?? { d7: 0, d14: 0, d30: 0 }` without guards.
 */
export async function getWindowedWagerByUser(
  userIds: string[],
): Promise<Map<string, WindowedWager>> {
  if (userIds.length === 0) return new Map();

  // Resolve env + blacklist in REQUEST scope (cookie + admin-DB reads that
  // can't run inside the unstable_cache callback) and thread them in so
  // prod/dev and each blacklist land in a separate slot — same handling as
  // code-and-wager-by-user.ts. The userIds are sorted so the cache key is
  // stable regardless of roster order (the result Map is keyed by userId,
  // so order doesn't affect the shape).
  const env = await readDbEnv();
  const excludedIds = [...(await getExcludedUserIds())].sort();
  const sortedUserIds = [...userIds].sort();

  return new Map(
    await cachedWindowedWagerEntries(env, excludedIds, sortedUserIds)(),
  );
}
