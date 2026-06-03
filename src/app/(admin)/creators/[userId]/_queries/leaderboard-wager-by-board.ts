import "server-only";

import { unstable_cache } from "next/cache";

import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";
import { CREATOR_COST_CACHE_TTL_SECONDS } from "./_cost-cache";

/**
 * Inline "total wager" per affiliate leaderboard, for the
 * /creators/[userId] Leaderboards card — so the owner sees each board's
 * wager volume without clicking into the board.
 *
 * ─── WHAT "TOTAL WAGER" MEANS (matches the detail view exactly) ──────
 *
 * The leaderboard DETAIL page (`/creators/leaderboards/[id]`) renders
 * per-user standings via `getAffiliateLeaderboardRankings`, whose wager
 * column is `SUM(acu.wager_amount_usd)` over `affiliate_code_usages`
 * rows with `usage_type = 'wager'`, scoped to the board's code(s) inside
 * its `[start_date, end_date)` window, excluding staff + blacklisted
 * users. The board's TOTAL wager is simply that same sum WITHOUT the
 * per-user GROUP BY — the sum of every standing's `totalWageredUsd`.
 *
 * `acu.wager_amount_usd` is the canonical creator-wager column used
 * across every creator surface (the ranking query, the list-card
 * `getCodeAndWagerByUser`, etc.) — any borrow-correction is already
 * baked into it at write time, so this introduces no new wager
 * definition. Casing + the "all codes" fallback are handled identically
 * to the ranking query (see methodology notes inline).
 *
 * ─── WHY BATCHED (one scan for the whole card, not N) ───────────────
 *
 * The card shows up to PREVIEW_LIMIT (10) boards. Rather than N
 * per-board scans, this builds a single `(leaderboard_id, code, start,
 * end, …)` tuple table and joins `affiliate_code_usages` once, grouping
 * the sum back per leaderboard. One code-resolution round-trip (only for
 * boards using the "all codes" fallback) + one aggregate scan, cached
 * per board-set signature and degrade-on-failure at the call site.
 */

/** One leaderboard's identity needed to scope its wager sum. */
export type LeaderboardWagerInput = {
  /** Backend leaderboard id (map key). */
  id: string;
  /**
   * Primary owner. Used (with co-creators) to resolve the code set when
   * `affiliateCodes` is empty (the board's "all codes" affordance).
   */
  creatorUserId: string;
  /** Co-creators whose codes also count toward this board. */
  coCreatorUserIds: string[];
  /**
   * Codes this board is scoped to. Empty = "all codes owned by the
   * participating creators" (the fallback path, same as the ranking
   * query). Casing is normalised downstream.
   */
  affiliateCodes: string[];
  /** Scoring window start (inclusive). */
  startDate: Date;
  /** Scoring window end (exclusive). */
  endDate: Date;
};

type WagerRow = { leaderboard_id: string; total_wagered: string };

/**
 * Compute total wager per leaderboard for a (small, card-sized) set of
 * boards in a single aggregate scan. Returns a Map keyed by leaderboard
 * id → total wagered USD. Boards with no qualifying wager activity are
 * absent from the map (callers default to 0 / hide the figure).
 */
async function computeCreatorLeaderboardWagerMap(
  boards: LeaderboardWagerInput[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (boards.length === 0) return result;

  const db = await getDb();
  const excluded = await getExcludedUserIds();
  const blacklistIdNotIn = blacklistNotInClause("u.id", excluded);

  // Resolve the code set for any board that didn't name explicit codes.
  // Same "all codes for the participating creators" fallback the ranking
  // query uses. One batched round-trip over the union of every fallback
  // board's participating-creator ids; we then map each owned code back
  // to its owner so the per-board fallback can keep the
  // transferred-code guard (acu.affiliate_user_id ∈ that board's
  // participating creators).
  const fallbackBoards = boards.filter((b) => b.affiliateCodes.length === 0);
  let codesByOwner = new Map<string, string[]>();
  if (fallbackBoards.length > 0) {
    const ownerIds = Array.from(
      new Set(
        fallbackBoards.flatMap((b) => [
          b.creatorUserId,
          ...b.coCreatorUserIds.filter((id) => id && id !== b.creatorUserId),
        ]),
      ),
    );
    if (ownerIds.length > 0) {
      const owned = await db.$queryRawUnsafe<{ user_id: string; code: string }[]>(
        `SELECT user_id, code FROM affiliate_codes WHERE user_id = ANY($1::text[])`,
        ownerIds,
      );
      const m = new Map<string, string[]>();
      for (const row of owned) {
        const list = m.get(row.user_id);
        if (list) list.push(row.code);
        else m.set(row.user_id, [row.code]);
      }
      codesByOwner = m;
    }
  }

  // Build the per-(board, code) tuple table. Each row carries:
  //   - leaderboard_id + the board's window
  //   - the UPPER-cased code to match against UPPER(acu.code) (acu is
  //     mixed-case for legacy rows; affiliate_clicks is uppercase — same
  //     casing dance as the ranking query)
  //   - restrict_creator + creator_ids: the transferred-code guard. For
  //     explicit-code boards the code IS the source of truth, so no
  //     creator restriction (restrict_creator = false). For "all codes"
  //     fallback boards we narrow to usage rows tagged to one of THAT
  //     board's participating creators so a transferred code can't leak
  //     a different owner's pre-transfer activity — exactly the ranking
  //     query's branching.
  type Tuple = {
    id: string;
    code: string;
    start: Date;
    end: Date;
    restrict: boolean;
    creatorIds: string[];
  };
  const tuples: Tuple[] = [];
  for (const b of boards) {
    const participating = [
      b.creatorUserId,
      ...b.coCreatorUserIds.filter((id) => id && id !== b.creatorUserId),
    ];
    const fallback = b.affiliateCodes.length === 0;
    const rawCodes = fallback
      ? participating.flatMap((cid) => codesByOwner.get(cid) ?? [])
      : b.affiliateCodes;
    const upperCodes = Array.from(
      new Set(rawCodes.map((c) => c.toUpperCase())),
    );
    for (const code of upperCodes) {
      tuples.push({
        id: b.id,
        code,
        start: b.startDate,
        end: b.endDate,
        restrict: fallback,
        creatorIds: participating,
      });
    }
  }
  // No code resolved for any board (e.g. every board is "all codes" but
  // the creators own none) → no wager to attribute.
  if (tuples.length === 0) return result;

  // Flatten the tuples into positional params. Each tuple contributes 6
  // params; the VALUES list references them by 1-based index. Postgres
  // casts the literal columns once via the casts on the first VALUES row
  // pattern, so we cast each column explicitly in the row template.
  const params: unknown[] = [];
  const valuesRows = tuples
    .map((t) => {
      const base = params.length;
      params.push(t.id, t.code, t.start, t.end, t.restrict, t.creatorIds);
      return `($${base + 1}::text, $${base + 2}::text, $${base + 3}::timestamptz, $${base + 4}::timestamptz, $${base + 5}::boolean, $${base + 6}::text[])`;
    })
    .join(",\n        ");

  // Single aggregate scan: join the board/code tuples to the wager
  // usages, apply the same staff + blacklist exclusion + (for fallback
  // boards) the participating-creator guard, and sum per leaderboard.
  // usage_type is compared via ::text because the dev DB's enum can lag
  // the schema — same enum-drift guard the rest of the queries layer uses.
  const rows = await db.$queryRawUnsafe<WagerRow[]>(
    `WITH board_codes (leaderboard_id, code, start_ts, end_ts, restrict_creator, creator_ids) AS (
       VALUES
        ${valuesRows}
     )
     SELECT bc.leaderboard_id AS leaderboard_id,
            SUM(acu.wager_amount_usd::numeric)::text AS total_wagered
       FROM board_codes bc
       JOIN affiliate_code_usages acu
         ON UPPER(acu.code) = bc.code
        AND acu.usage_type::text = 'wager'
        AND acu.created_at >= bc.start_ts
        AND acu.created_at <  bc.end_ts
        AND (NOT bc.restrict_creator OR acu.affiliate_user_id = ANY(bc.creator_ids))
       JOIN "user" u ON u.id = acu.referred_user_id
      WHERE u.role NOT IN ('admin', 'support') ${blacklistIdNotIn}
      GROUP BY bc.leaderboard_id`,
    ...params,
  );

  for (const row of rows) {
    result.set(row.leaderboard_id, toNumber(row.total_wagered));
  }
  return result;
}

/**
 * Stable cache signature for a board set: id + window + resolved code
 * scope, sorted so the key is order-independent. The wager totals move
 * as users wager, so a short TTL (shared with the other per-creator cost
 * panels) keeps a repeat load / "Refresh to retry" from re-scanning
 * while still surfacing fresh activity within a few minutes.
 *
 * `getDb()` is called INSIDE the cached function, so — like the sibling
 * cost caches — the env resolves to PROD inside the `unstable_cache`
 * scope. That's correct for this admin surface (prod is the real data).
 */
function boardSignature(boards: LeaderboardWagerInput[]): string {
  return boards
    .map((b) =>
      [
        b.id,
        b.startDate.getTime(),
        b.endDate.getTime(),
        b.affiliateCodes.length > 0
          ? b.affiliateCodes
              .map((c) => c.toUpperCase())
              .sort()
              .join("|")
          : `*${[b.creatorUserId, ...b.coCreatorUserIds].sort().join(",")}`,
      ].join(":"),
    )
    .sort()
    .join(";");
}

const cachedCreatorLeaderboardWagerMap = unstable_cache(
  // unstable_cache keys on the function args; the signature string is the
  // first arg so cache hits track the exact board-set. The boards array
  // is passed through as the second arg the compute actually consumes.
  async (_signature: string, boards: LeaderboardWagerInput[]) =>
    computeCreatorLeaderboardWagerMapAsEntries(boards),
  ["creators-detail-leaderboard-wager-v1"],
  { revalidate: CREATOR_COST_CACHE_TTL_SECONDS },
);

// unstable_cache serialises the cached value to JSON, which can't round-
// trip a Map — store/return plain [id, usd] entries and rebuild the Map
// at the boundary.
async function computeCreatorLeaderboardWagerMapAsEntries(
  boards: LeaderboardWagerInput[],
): Promise<[string, number][]> {
  const map = await computeCreatorLeaderboardWagerMap(boards);
  return Array.from(map.entries());
}

/**
 * Public entry — total wager per leaderboard for the card's board set,
 * batched + cached. Returns a Map keyed by leaderboard id → total
 * wagered USD (boards with no qualifying wager are absent).
 */
export async function getCreatorLeaderboardWagerMap(
  boards: LeaderboardWagerInput[],
): Promise<Map<string, number>> {
  if (boards.length === 0) return new Map();
  const entries = await cachedCreatorLeaderboardWagerMap(
    boardSignature(boards),
    boards,
  );
  return new Map(entries);
}
