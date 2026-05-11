import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";

// Wager events the platform counts as "wagered for leaderboard
// purposes". Same set used by analytics-cohorts / analytics-top so
// every leaderboard-style ranking in the admin agrees on what
// counts as wager volume.
const WAGER_TYPES = "('pack_opening','battle_bet','battle_sponsorship')";

export type LeaderboardRanking = {
  position: number;
  userId: string;
  username: string | null;
  email: string | null;
  totalWageredUsd: number;
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
 *   1. Determine the population of users tied to this leaderboard.
 *      Drives off `affiliateCodes` if the leaderboard names specific
 *      codes; otherwise falls back to every code the creator owns
 *      (the "all codes" case the page surfaces explicitly). Casing
 *      is normalised because `affiliate_code_usages` is mixed-case
 *      for legacy rows — see the casing notes in creators-codes.ts.
 *   2. Sum each user's wager-type ledger transactions inside the
 *      [start_date, end_date) window. amounts are stored negative
 *      on the user's side (it's a debit), so we ABS them.
 *   3. Order DESC by wagered, dedupe per user, exclude staff
 *      (admin/support) so internal accounts never appear on the
 *      ranking.
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
  const blacklistIdNotIn =
    excluded.length > 0
      ? `AND u.id NOT IN (${excluded.map((id) => `'${id.replace(/'/g, "''")}'`).join(",")})`
      : "";

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

  const rows = await db.$queryRawUnsafe<Row[]>(
    `WITH leaderboard_users AS (
       SELECT DISTINCT acu.referred_user_id
       FROM affiliate_code_usages acu
       WHERE UPPER(acu.code) = ANY($1::text[])
       ${whereExtra}
     )
     SELECT
       lt.user_id,
       u.username,
       u.email,
       SUM(ABS(lt.amount::numeric))::text AS total_wagered
     FROM ledger_transactions lt
     JOIN leaderboard_users lu ON lu.referred_user_id = lt.user_id
     JOIN "user" u ON u.id = lt.user_id
     WHERE lt.status = 'completed'
       AND lt.type IN ${WAGER_TYPES}
       AND lt.created_at >= $2
       AND lt.created_at <  $3
       AND u.role NOT IN ('admin', 'support') ${blacklistIdNotIn}
     GROUP BY lt.user_id, u.username, u.email
     HAVING SUM(ABS(lt.amount::numeric)) > 0
     ORDER BY SUM(ABS(lt.amount::numeric)) DESC
     LIMIT ${limit}`,
    ...params,
  );

  // Build a position → prize lookup once so the per-row mapping is O(1).
  const prizeByPosition = new Map<number, number>();
  for (const t of prizeTiers) {
    prizeByPosition.set(t.position, toNumber(t.prize_amount_usd));
  }

  return rows.map((r, i) => {
    const position = i + 1;
    return {
      position,
      userId: r.user_id,
      username: r.username,
      email: r.email,
      totalWageredUsd: toNumber(r.total_wagered),
      prizeUsd: prizeByPosition.get(position) ?? null,
    };
  });
}
