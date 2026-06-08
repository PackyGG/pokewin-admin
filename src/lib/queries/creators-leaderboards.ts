import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { calculateUsersBoundedWindowedPnlBatch } from "./pnl";
import { blacklistNotInClause } from "./_blacklist";

export type LeaderboardRanking = {
  position: number;
  userId: string;
  username: string | null;
  email: string | null;
  totalWageredUsd: number;
  /** House P&L on this user over the leaderboard window [start, end). */
  housePnlUsd: number;
  // Prize from the leaderboard's prize_tiers matched against this
  // user's position. null when the user is below the lowest tier.
  prizeUsd: number | null;
};

/**
 * Compute the live standings for an affiliate leaderboard event.
 *
 * Affiliate leaderboards are creator-run events: a creator buys in,
 * the platform optionally adds a site bonus, and over a set window
 * users tied to one of the creator's affiliate codes compete on
 * wager volume. The page-level data ({title, codes, dates, prize
 * tiers, approval status, …}) lives on the backend service and is
 * fetched via affiliateLeaderboardsApi.get(id); this query computes
 * the actual user-by-user rankings against the main DB so the admin
 * panel can show "who's at #1, #2, …" alongside the configuration.
 *
 * Methodology:
 *   1. Resolve the code set this leaderboard is scoped to. Drives
 *      off `affiliateCodes` if the leaderboard names specific codes;
 *      otherwise falls back to every code the participating creators
 *      own (the "all codes" case the page surfaces explicitly).
 *      Casing is normalised because `affiliate_code_usages` is
 *      mixed-case for legacy rows — see creators-codes.ts.
 *   2. Sum each user's wager *attributed to those codes*, not their
 *      total wager volume. `affiliate_code_usages` writes one
 *      `usage_type = 'wager'` row per wager carrying the
 *      `wager_amount_usd` booked against whichever code was active
 *      at the time. Summing that column — rather than the user's
 *      whole ledger — splits a user who wagers under code A then
 *      switches to code B correctly: A's leaderboard sees only the
 *      A wager, B's only the B wager. (The previous implementation
 *      summed each participant's entire ledger wager, so switching
 *      codes double-counted the volume onto every leaderboard the
 *      user had ever touched.)
 *   3. Order DESC by wagered, exclude staff (admin/support) so
 *      internal accounts never appear on the ranking. GROUP BY
 *      referred_user_id already yields one row per user.
 *   4. Match each row's index (1-based) against the prize tier
 *      table to assign prizeUsd. Tiers are looked up by exact
 *      position; a row whose position has no tier just gets null.
 */
export async function getAffiliateLeaderboardRankings(opts: {
  creatorUserId: string;
  coCreatorUserIds?: string[];
  affiliateCodes: string[];
  startDate: Date;
  endDate: Date;
  prizeTiers: { position: number; prize_amount_usd: string }[];
  limit?: number;
}): Promise<LeaderboardRanking[]> {
  const { creatorUserId, startDate, endDate, prizeTiers } = opts;
  const coCreatorUserIds = (opts.coCreatorUserIds ?? []).filter(
    (id) => id && id !== creatorUserId,
  );
  // Union of all creators whose codes count toward this leaderboard.
  // Primary creator first preserves existing single-creator behavior; the
  // array form is also used in the fallback below when callers don't
  // supply an explicit affiliateCodes list.
  const participatingCreatorIds = [creatorUserId, ...coCreatorUserIds];
  const limit = Math.max(1, Math.min(Math.floor(opts.limit ?? 100), 500));

  const db = await getDb();
  const excluded = await getExcludedUserIds();
  const blacklistIdNotIn = blacklistNotInClause("u.id", excluded);

  // Resolve the code set this leaderboard is scoped to. Empty array
  // on the input = "all codes this creator owns" (matches what the
  // page renders for the "all codes" affordance).
  //
  // Branching is intentional:
  //   • Empty `affiliateCodes` (the "all codes for this creator"
  //     fallback): we ALSO require acu.affiliate_user_id = creatorUserId
  //     in the WHERE below. Otherwise, if a code was ever transferred
  //     between creators, historical affiliate_code_usages rows tagged
  //     to the OLD owner would leak into THIS creator's standings.
  //   • Explicit `affiliateCodes`: scope follows the code string. If a
  //     code was transferred, the standings intentionally include the
  //     pre-transfer activity — that's the point of giving the admin
  //     control over which codes belong to the leaderboard.
  const codeFallback = opts.affiliateCodes.length === 0;
  let codes = opts.affiliateCodes;
  if (codeFallback) {
    // Multi-creator: union codes from primary + every co-creator. Each
    // participating creator's codes are eligible — that's the whole point
    // of the shared-leaderboard feature.
    const owned = await db.$queryRawUnsafe<{ code: string }[]>(
      `SELECT code FROM affiliate_codes WHERE user_id = ANY($1::text[])`,
      participatingCreatorIds,
    );
    codes = owned.map((c) => c.code);
  }
  if (codes.length === 0) return []; // no codes resolved for any participating creator

  // Casing dance — same convention as creators-codes.ts:
  // affiliate_clicks is always uppercase, affiliate_code_usages is
  // mixed for legacy rows. We compare on UPPER() of the row's code
  // against UPPER() of every input code so both casings match.
  const upperCodes = Array.from(new Set(codes.map((c) => c.toUpperCase())));

  type Row = {
    user_id: string;
    username: string | null;
    email: string | null;
    total_wagered: string;
  };

  // Param indices shift when the code-fallback path adds the participating
  // creator IDs as $4. Build the WHERE clause + params separately so each
  // path stays readable. The fallback narrows usage rows to ones tagged
  // to one of the participating creators so transferred codes don't leak
  // pre-transfer activity into the standings; the explicit-codes path
  // skips that filter intentionally (codes are the source of truth there).
  const whereExtra = codeFallback ? `AND acu.affiliate_user_id = ANY($4::text[])` : ``;
  const params: unknown[] = codeFallback
    ? [upperCodes, startDate, endDate, participatingCreatorIds]
    : [upperCodes, startDate, endDate];

  // Sum wager booked against the leaderboard's code(s) directly from
  // affiliate_code_usages: one `usage_type = 'wager'` row per wager,
  // each carrying the wager_amount_usd attributed to the code that was
  // active at the time. Grouping by referred_user_id collapses a user's
  // many wager rows into a single standing. usage_type is compared via
  // ::text because the dev DB's enum can lag the schema (enum-drift
  // guard, same convention as the rest of the queries layer).
  const rows = await db.$queryRawUnsafe<Row[]>(
    `SELECT
       acu.referred_user_id AS user_id,
       u.username,
       u.email,
       SUM(acu.wager_amount_usd::numeric)::text AS total_wagered
     FROM affiliate_code_usages acu
     JOIN "user" u ON u.id = acu.referred_user_id
     WHERE acu.usage_type::text = 'wager'
       AND UPPER(acu.code) = ANY($1::text[])
       AND acu.created_at >= $2
       AND acu.created_at <  $3
       AND u.role NOT IN ('admin', 'support') ${blacklistIdNotIn}
       ${whereExtra}
     GROUP BY acu.referred_user_id, u.username, u.email
     HAVING SUM(acu.wager_amount_usd::numeric) > 0
     ORDER BY SUM(acu.wager_amount_usd::numeric) DESC
     LIMIT ${limit}`,
    ...params,
  );

  // Build a position → prize lookup once so the per-row mapping is O(1).
  const prizeByPosition = new Map<number, number>();
  for (const t of prizeTiers) {
    prizeByPosition.set(t.position, toNumber(t.prize_amount_usd));
  }

  const userIds = rows.map((r) => r.user_id);
  const pnlByUser = await calculateUsersBoundedWindowedPnlBatch(
    userIds,
    startDate,
    endDate,
  ).catch((err) => {
    console.error("[leaderboard] windowed PnL batch failed", err);
    return new Map<string, number>();
  });

  return rows.map((r, i) => {
    const position = i + 1;
    return {
      position,
      userId: r.user_id,
      username: r.username,
      email: r.email,
      totalWageredUsd: toNumber(r.total_wagered),
      housePnlUsd: pnlByUser.get(r.user_id) ?? 0,
      prizeUsd: prizeByPosition.get(position) ?? null,
    };
  });
}
