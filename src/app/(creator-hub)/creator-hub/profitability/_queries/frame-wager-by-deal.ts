import "server-only";

import { unstable_cache } from "next/cache";

import { readDrizzleForEnv } from "@/lib/db";
import { queryRows } from "@/lib/drizzle-query";
import { readDbEnv, type DbEnv } from "@/lib/db-env";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { toNumber } from "@/lib/utils/decimal";

/**
 * Per-DEAL variant of {@link getFrameWagerByUser} — same code-cohort wager
 * methodology, but keyed by DEAL (a creator may have many ended deals, each
 * with its own window). The user-keyed version collapses one creator → one
 * row, which is correct for the Active view (one current frame per creator)
 * but wrong for Past Deals (the same creator appears once per ended deal).
 *
 * For a `(dealId, creatorUserId, [start, end])` window the wager is the
 * code-cohort affiliate wager summed strictly INSIDE that window:
 *
 *   Σ acu.wager_amount_usd  over affiliate_code_usages rows where
 *     usage_type = 'wager', affiliate_user_id = the deal's creator,
 *     created_at ∈ [start, end], the referred user is a real customer
 *     (role ∉ {admin, support, creator}, not self-play) and not blacklisted.
 *
 * SAME exclusion scope as the deposit leg (`frame-affiliate-pnl-by-deal`),
 * so Creator Wager / Expected Wager / conversion never count a user the
 * PnL leg already drops.
 *
 * One batched, indexed pass over `affiliate_code_usages` — the per-deal
 * `[start, end]` bounds arrive via a VALUES list (same shape + index the
 * user-keyed sibling uses: Bitmap Index Scan on
 * `idx_affiliate_code_usages_affiliate_referred`). `dealId` is unique per
 * row (the map key); `creatorUserId` may repeat across a creator's deals.
 *
 * MAIN/prod game DB is READ-ONLY; this only SELECTs.
 */

/** One ended-deal window — the wager is summed inside [start, end]. */
export type DealWagerWindow = {
  /** Backend deal id (map key — unique per deal). */
  dealId: string;
  /** Creator whose code-cohort drives the attribution. */
  creatorUserId: string;
  /** Frame start (ISO). */
  startIso: string;
  /** Frame end (ISO). */
  endIso: string;
};

const cachedDealWager = (
  env: DbEnv,
  deals: DealWagerWindow[],
  blacklistIds: string[],
) =>
  unstable_cache(
    async (): Promise<[string, number][]> => {
      const db = readDrizzleForEnv(env);

      // (dealId, creatorUserId, start, end) tuples — dealId is unique per
      // row; creatorUserId may repeat (same creator, multiple ended deals).
      const tuples: string[] = [];
      const params: unknown[] = [];
      deals.forEach((d, i) => {
        const b = i * 4;
        tuples.push(
          `($${b + 1}::text, $${b + 2}::text, $${b + 3}::timestamptz, $${b + 4}::timestamptz)`,
        );
        params.push(d.dealId, d.creatorUserId, d.startIso, d.endIso);
      });

      const blacklistAnd =
        blacklistIds.length > 0
          ? ` AND NOT (u.id = ANY($${params.length + 1}::text[]))`
          : "";
      if (blacklistIds.length > 0) params.push(blacklistIds);

      const rows = await queryRows<
        { deal_id: string; wager: string }[]
      >(db,
        `SELECT f.did AS deal_id,
                COALESCE(SUM(acu.wager_amount_usd::numeric), 0)::text AS wager
           FROM (VALUES ${tuples.join(", ")}) AS f(did, cid, start_ts, end_ts)
           JOIN affiliate_code_usages acu
             ON acu.affiliate_user_id = f.cid
            AND acu.usage_type = 'wager'
            AND acu.created_at >= f.start_ts
            AND acu.created_at <= f.end_ts
           JOIN "user" u ON u.id = acu.referred_user_id
          WHERE u.role NOT IN ('admin', 'support', 'creator')
            AND u.id <> acu.affiliate_user_id${blacklistAnd}
          GROUP BY f.did`,
        ...params,
      );

      return rows.map((r) => [r.deal_id, toNumber(r.wager)]);
    },
    [
      "profitability-deal-wager-v1",
      env,
      ...deals.map(
        (d) => `${d.dealId}:${d.creatorUserId}:${d.startIso}:${d.endIso}`,
      ),
      ...blacklistIds,
    ],
    { revalidate: 300, tags: ["profitability-deal-wager"] },
  );

/**
 * Per-deal code-cohort wager. Returns a Map keyed by `dealId` → wager USD
 * summed strictly inside that deal's window. Deals absent from the map had
 * no qualifying wager (callers default to 0).
 */
export async function getDealWagerByDeal(
  deals: DealWagerWindow[],
): Promise<Map<string, number>> {
  if (deals.length === 0) return new Map();
  const env = await readDbEnv();
  const blacklistIds = await getExcludedUserIds();
  const entries = await cachedDealWager(env, deals, blacklistIds)();
  return new Map(entries);
}
