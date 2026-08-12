import "server-only";

import { unstable_cache } from "next/cache";

import { readDrizzleForEnv } from "@/lib/db";
import { queryRows } from "@/lib/drizzle-query";
import { readDbEnv, type DbEnv } from "@/lib/db-env";
import { toNumber } from "@/lib/utils/decimal";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";

/**
 * 3-day rolling deposit + wager momentum per creator — ONE indexed,
 * 3-day-bounded read.
 *
 * ─── Why this exists (2026-08-12) ────────────────────────────────────
 *
 * `/creators/[userId]`'s "Momentum (3d)" KPI tile called
 * `getCodeAndWagerByUser([userId])` to get exactly two numbers:
 * `deposits3dUsd` and `wagers3dUsd`. That helper fires SIX round-trips —
 * five MAIN reads (codes, signups, lifetime FTDs, 3-day deposits, wagers)
 * plus one ADMIN audit read — and the detail page discards four of the six
 * results outright: code / signups / FTDs / lifetime wager volume all come
 * from the `getCreatorDetail()` aggregate the same strip already awaits.
 *
 * Worse than the count: the wager leg there is UNBOUNDED. It carries the
 * lifetime `total_wagered` sum, so it scans every `affiliate_code_usages`
 * wager row this creator has ever had, purely to hand back a 3-day figure
 * the page then throws away most of.
 *
 * Under the process-wide mirror admission cap, total reads per render is
 * the thing that matters, so 6 → 1 on a page that already issues a dozen
 * MAIN reads is a real unblocking, and the survivor is bounded to 3 days.
 *
 * ─── Numbers are byte-identical ──────────────────────────────────────
 *
 * The two legs in `code-and-wager-by-user.ts` share the same source, join
 * and filters and differ only in `usage_type` and which amount column they
 * sum, so they fold into one grouped scan:
 *   • deposits: `usage_type='deposit'`, SUM(deposit_amount_usd), WHERE
 *     created_at >= NOW() - 3 days.
 *   • wagers:   `usage_type='wager'`, SUM(wager_amount_usd) — there the
 *     3-day bound sits in a CASE (because that query ALSO computed the
 *     lifetime sum); with the lifetime sum dropped, the identical bound
 *     moves to the WHERE clause, which selects exactly the same rows.
 * Staff exclusion, self-attribution drop and the blacklist are copied
 * verbatim, so both figures match the list card's MomentumRow exactly.
 */
export type CreatorMomentum3d = {
  /** 3-day rolling deposit volume — `acu.deposit_amount_usd`. */
  deposits3dUsd: number;
  /** 3-day rolling wager volume — `acu.wager_amount_usd`. */
  wagers3dUsd: number;
};

type MomentumRow = {
  creator_user_id: string;
  deposits_3d: string;
  wagers_3d: string;
};

/**
 * The single round-trip, wrapped in `unstable_cache` on the same 180s
 * revalidate as `getCodeAndWagerByUser` (this is the same card metadata,
 * just narrowed) so repeat loads of a creator's detail page don't re-pay it.
 *
 * Env + blacklist are request-scoped (the env toggle reads a cookie, the
 * blacklist is an ADMIN-DB read) and cannot be resolved inside an
 * `unstable_cache` callback, so they are resolved outside and threaded in
 * through this factory closure — identical handling to its sibling.
 */
const cachedMomentumEntries = (
  env: DbEnv,
  excludedIds: string[],
  userIds: string[],
) =>
  unstable_cache(
    async (): Promise<[string, CreatorMomentum3d][]> => {
      const db = readDrizzleForEnv(env);
      const blacklistAnd =
        excludedIds.length > 0
          ? ` AND u.id NOT IN (${excludedIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(",")})`
          : "";

      // Rides the same index the sibling legs do — Bitmap Index Scan on
      // idx_affiliate_code_usages_affiliate_referred for
      // `affiliate_user_id = ANY($1)`, with usage_type / created_at applied
      // as heap filters and the "user" join on user_pkey. Bounded to 3 days,
      // so it never touches the lifetime tail of the table.
      const rows = await queryRows<MomentumRow[]>(
        db,
        `SELECT acu.affiliate_user_id AS creator_user_id,
                COALESCE(SUM(CASE WHEN acu.usage_type::text = 'deposit'
                                  THEN acu.deposit_amount_usd::numeric ELSE 0 END), 0)::text AS deposits_3d,
                COALESCE(SUM(CASE WHEN acu.usage_type::text = 'wager'
                                  THEN acu.wager_amount_usd::numeric ELSE 0 END), 0)::text AS wagers_3d
           FROM affiliate_code_usages acu
           JOIN "user" u ON u.id = acu.referred_user_id
          WHERE acu.affiliate_user_id = ANY($1::text[])
            AND acu.usage_type::text IN ('deposit', 'wager')
            AND acu.created_at >= NOW() - INTERVAL '3 days'
            AND u.role NOT IN ('admin', 'support', 'creator')
            AND u.id != acu.affiliate_user_id${blacklistAnd}
          GROUP BY acu.affiliate_user_id`,
        userIds,
      );

      const byId = new Map(rows.map((r) => [r.creator_user_id, r]));
      // Every requested id gets an entry so callers can `.get(id)` without a
      // presence guard — a creator with no activity in the window reads 0/0,
      // matching the list card's quiet state.
      return userIds.map((userId) => {
        const row = byId.get(userId);
        return [
          userId,
          {
            deposits3dUsd: row ? toNumber(row.deposits_3d) : 0,
            wagers3dUsd: row ? toNumber(row.wagers_3d) : 0,
          },
        ];
      });
    },
    ["creators-momentum-3d-v1", env, ...excludedIds, "|users|", ...userIds],
    { revalidate: 180, tags: ["creators-code-and-wager"] },
  );

/**
 * 3-day deposit + wager momentum for a batch of creator user-ids, keyed on
 * user_id. Missing creators get a zeroed record.
 */
export async function getMomentum3dByUser(
  userIds: string[],
): Promise<Map<string, CreatorMomentum3d>> {
  if (userIds.length === 0) return new Map();

  // Resolved in REQUEST scope (cookie + ADMIN-DB read) and threaded into the
  // cache key so prod/dev and each blacklist land in their own slot. The ids
  // are sorted so key identity doesn't depend on caller ordering; the result
  // is a Map, so order never reaches the caller.
  const env = await readDbEnv();
  const excludedIds = [...(await getExcludedUserIds())].sort();
  const sortedUserIds = [...userIds].sort();

  return new Map(await cachedMomentumEntries(env, excludedIds, sortedUserIds)());
}
