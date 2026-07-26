import "server-only";

import { unstable_cache } from "next/cache";
import { inArray, sql } from "drizzle-orm";

import { getDrizzleDb } from "@/lib/db";
import { affiliate_leaderboard_snapshots } from "@/lib/db-schema/main/schema";
import { queryMainRows } from "@/lib/drizzle-query";
import { toNumber } from "@/lib/utils/decimal";
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
 * column is `SUM(COALESCE(acu.weighted_wager_amount_usd, acu.wager_amount_usd))`
 * over `affiliate_code_usages` rows with `usage_type = 'wager'`, scoped to
 * the board's code(s) inside its `[start_date, end_date)` window, excluding
 * only staff. The board's TOTAL wager is simply that same sum WITHOUT the
 * per-user GROUP BY — the sum of every standing's `totalWageredUsd`.
 *
 * The WEIGHTED amount (per-game leaderboard weight frozen at insert time,
 * falling back to raw for pre-feature rows) is used so this card matches the
 * backend leaderboard + the detail-page standings exactly. Blacklisted users
 * are intentionally NOT filtered out here — the standings include them (the
 * view mirrors the real packy.gg leaderboard), so the total must too. Casing +
 * the "all codes" fallback are handled identically to the ranking query.
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

type WagerRow = {
  leaderboard_id: string;
  raw_wagered: string;
  weighted_wagered: string;
};

/** Per-board wager totals: raw (unweighted) + leaderboard-weighted. */
export type WagerBreakdown = { raw: number; weighted: number };

/**
 * Compute total wager per leaderboard for a (small, card-sized) set of
 * boards in a single aggregate scan. Returns a Map keyed by leaderboard
 * id → { raw, weighted } USD. Boards with no qualifying wager activity are
 * absent from the map (callers default to 0 / hide the figure).
 *
 * Both figures come from ONE scan over the immutable `affiliate_code_usages`
 * rows: `raw` = Σ wager_amount_usd, `weighted` = Σ COALESCE(weighted, raw).
 * For SETTLED boards the weighted figure is overridden with the authoritative
 * `affiliate_leaderboard_snapshots` total (what was actually paid); raw still
 * comes from the scan (snapshots don't store it).
 */
async function computeCreatorLeaderboardWagerMap(
  boards: LeaderboardWagerInput[],
): Promise<Map<string, WagerBreakdown>> {
  const result = new Map<string, WagerBreakdown>();
  if (boards.length === 0) return result;

  const db = await getDrizzleDb();

  // ── Settled boards: authoritative weighted snapshot total ──
  // Per-game wager weights (packs / battles / upgrader) are applied at wager
  // time and frozen into affiliate_leaderboard_snapshots when a board settles.
  // We OVERRIDE the scanned weighted figure with the snapshot for settled
  // boards so it matches exactly what was paid. `raw` always comes from the
  // scan below (snapshots don't carry an unweighted total).
  const boardIds = boards.map((b) => b.id);
  const snapSums = await db
    .select({
      leaderboard_id: affiliate_leaderboard_snapshots.leaderboard_id,
      total_wagered_usd:
        sql<string>`COALESCE(SUM(${affiliate_leaderboard_snapshots.total_wagered_usd}), 0)`,
    })
    .from(affiliate_leaderboard_snapshots)
    .where(inArray(affiliate_leaderboard_snapshots.leaderboard_id, boardIds))
    .groupBy(affiliate_leaderboard_snapshots.leaderboard_id);
  const settledWeightedById = new Map<string, number>();
  for (const s of snapSums) {
    settledWeightedById.set(
      s.leaderboard_id,
      toNumber(s.total_wagered_usd),
    );
  }

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
      const owned = await queryMainRows<{ user_id: string; code: string }[]>(
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
  const rows = await queryMainRows<WagerRow[]>(
    `WITH board_codes (leaderboard_id, code, start_ts, end_ts, restrict_creator, creator_ids) AS (
       VALUES
        ${valuesRows}
     )
     SELECT bc.leaderboard_id AS leaderboard_id,
            SUM(acu.wager_amount_usd::numeric)::text AS raw_wagered,
            SUM(COALESCE(acu.weighted_wager_amount_usd, acu.wager_amount_usd)::numeric)::text AS weighted_wagered
       FROM board_codes bc
       JOIN affiliate_code_usages acu
         ON UPPER(acu.code) = bc.code
        AND acu.usage_type::text = 'wager'
        AND acu.created_at >= bc.start_ts
        AND acu.created_at <  bc.end_ts
        AND (NOT bc.restrict_creator OR acu.affiliate_user_id = ANY(bc.creator_ids))
       JOIN "user" u ON u.id = acu.referred_user_id
      WHERE u.role NOT IN ('admin', 'support')
      GROUP BY bc.leaderboard_id`,
    ...params,
  );

  for (const row of rows) {
    const raw = toNumber(row.raw_wagered);
    // Settled boards: prefer the authoritative snapshot weighted total;
    // otherwise use the scanned weighted sum.
    const weighted =
      settledWeightedById.get(row.leaderboard_id) ??
      toNumber(row.weighted_wagered);
    result.set(row.leaderboard_id, { raw, weighted });
  }

  // A settled board whose participants produced no scan row (e.g. all now
  // staff, or "all codes" with none currently owned) would otherwise drop its
  // authoritative snapshot total. Backfill weighted from the snapshot; raw is
  // unknown without scan rows, so it stays 0.
  for (const [id, weighted] of settledWeightedById) {
    if (!result.has(id)) result.set(id, { raw: 0, weighted });
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
 * The request-scoped resolver runs INSIDE the cached function, so — like the sibling
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
  // v2: cached value shape changed from `[id, number]` to `[id, {raw,weighted}]`.
  ["creators-detail-leaderboard-wager-v2"],
  { revalidate: CREATOR_COST_CACHE_TTL_SECONDS },
);

// unstable_cache serialises the cached value to JSON, which can't round-
// trip a Map — store/return plain [id, {raw,weighted}] entries and rebuild
// the Map at the boundary.
async function computeCreatorLeaderboardWagerMapAsEntries(
  boards: LeaderboardWagerInput[],
): Promise<[string, WagerBreakdown][]> {
  const map = await computeCreatorLeaderboardWagerMap(boards);
  return Array.from(map.entries());
}

/**
 * Public entry — raw + weighted wager per leaderboard for the card's board
 * set, batched + cached. Returns a Map keyed by leaderboard id →
 * { raw, weighted } USD (boards with no qualifying wager are absent).
 */
export async function getCreatorLeaderboardWagerBreakdownMap(
  boards: LeaderboardWagerInput[],
): Promise<Map<string, WagerBreakdown>> {
  if (boards.length === 0) return new Map();
  const entries = await cachedCreatorLeaderboardWagerMap(
    boardSignature(boards),
    boards,
  );
  return new Map(entries);
}

/**
 * Backward-compatible entry returning ONLY the weighted total per board
 * (the canonical "total wager", matching the backend leaderboard + settled
 * snapshots). Callers that want both figures use
 * {@link getCreatorLeaderboardWagerBreakdownMap}.
 */
export async function getCreatorLeaderboardWagerMap(
  boards: LeaderboardWagerInput[],
): Promise<Map<string, number>> {
  const breakdown = await getCreatorLeaderboardWagerBreakdownMap(boards);
  return new Map(
    Array.from(breakdown, ([id, b]) => [id, b.weighted] as [string, number]),
  );
}
