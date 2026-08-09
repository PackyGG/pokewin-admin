import { queryMainRows } from "@/lib/drizzle-query";
import { toNumber } from "@/lib/utils/decimal";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { calculateUsersBoundedWindowedPnlBatch } from "./pnl";

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
  /** When the user first crossed into their current place (UTC). */
  positionReachedAt: string | null;
  /**
   * True when the user is on the admin excluded-users blacklist. The
   * standings deliberately still INCLUDE them (so this view mirrors the
   * real, user-facing leaderboard on packy.gg) and just flag them so an
   * operator can tell they're excluded from analytics aggregates.
   */
  excluded?: boolean;
};

export type LeaderboardStandings = {
  rankings: LeaderboardRanking[];
  /**
   * Where the standings came from:
   *   • "settled" — read straight from the authoritative
   *     `affiliate_leaderboard_snapshots` the backend froze when the board
   *     ended. These already carry the per-game wager WEIGHTING (packs /
   *     battles / upgrader count at different rates toward leaderboards),
   *     so they match what was actually paid out.
   *   • "live"    — recomputed live from `affiliate_code_usages` using the
   *     same WEIGHTED amount as the backend leaderboard + the settled
   *     snapshots: COALESCE(weighted_wager_amount_usd, wager_amount_usd).
   *     Used while a board is still active and no snapshot exists yet. It
   *     can still drift slightly from the final settled standings as late
   *     wagers land, but the weighting matches so order / prize tiers agree
   *     with what packy.gg shows live.
   */
  source: "settled" | "live";
};

export type LeaderboardPageEntry = {
  position: number;
  username: string | null;
  totalWageredUsd: number;
  prizeUsd: number | null;
};

export type LeaderboardPage = {
  totalEntries: number;
  /** Sum of every entry's canonical leaderboard-weighted wager. */
  totalWageredUsd: number;
  entries: LeaderboardPageEntry[];
};

/**
 * Lightweight, exact page of public standings for non-admin consumers.
 * Unlike the admin detail query, this deliberately skips P&L, emails,
 * excluded-user markings, and position-reached calculations.
 */
export async function getAffiliateLeaderboardPage(opts: {
  leaderboardId: string;
  creatorUserId: string;
  coCreatorUserIds?: string[];
  affiliateCodes: string[];
  startDate: Date;
  endDate: Date;
  prizeTiers: { position: number; prize_amount_usd: string }[];
  page: number;
  pageSize: number;
}): Promise<LeaderboardPage> {
  const pageSize = Math.max(1, Math.min(Math.floor(opts.pageSize), 10));
  const page = Math.max(0, Math.floor(opts.page));
  const offset = page * pageSize;
  const prizeByPosition = new Map<number, number>();
  for (const tier of opts.prizeTiers) {
    prizeByPosition.set(tier.position, toNumber(tier.prize_amount_usd));
  }

  const snapshots = await queryMainRows<{
    position: string;
    username: string | null;
    total_wagered_usd: string;
    prize_amount_usd: string;
    total_entries: string;
    leaderboard_wagered_usd: string;
  }[]>(
    `SELECT als.position::text AS position,
            u.username,
            als.total_wagered_usd::text AS total_wagered_usd,
            als.prize_amount_usd::text AS prize_amount_usd,
            COUNT(*) OVER()::text AS total_entries,
            SUM(als.total_wagered_usd) OVER()::text AS leaderboard_wagered_usd
     FROM affiliate_leaderboard_snapshots als
     LEFT JOIN "user" u ON u.id = als.user_id
     WHERE als.leaderboard_id = $1
     ORDER BY als.position ASC
     LIMIT $2 OFFSET $3`,
    opts.leaderboardId,
    pageSize,
    offset,
  );
  if (snapshots.length > 0) {
    return {
      totalEntries: Number(snapshots[0]!.total_entries),
      totalWageredUsd: toNumber(snapshots[0]!.leaderboard_wagered_usd),
      entries: snapshots.map((row) => {
        const position = Number(row.position);
        const frozenPrize = toNumber(row.prize_amount_usd);
        return {
          position,
          username: row.username,
          totalWageredUsd: toNumber(row.total_wagered_usd),
          prizeUsd:
            frozenPrize > 0
              ? frozenPrize
              : (prizeByPosition.get(position) ?? null),
        };
      }),
    };
  }

  // An empty later page can still belong to a settled board. Check before
  // falling through to live computation so snapshots remain authoritative.
  if (offset > 0) {
    const [snapshotCount] = await queryMainRows<{
      total_entries: string;
      leaderboard_wagered_usd: string;
    }[]>(
      `SELECT COUNT(*)::text AS total_entries,
              COALESCE(SUM(total_wagered_usd), 0)::text AS leaderboard_wagered_usd
       FROM affiliate_leaderboard_snapshots
       WHERE leaderboard_id = $1`,
      opts.leaderboardId,
    );
    const totalEntries = Number(snapshotCount?.total_entries ?? 0);
    if (totalEntries > 0) {
      return {
        totalEntries,
        totalWageredUsd: toNumber(snapshotCount?.leaderboard_wagered_usd),
        entries: [],
      };
    }
  }

  const coCreatorUserIds = (opts.coCreatorUserIds ?? []).filter(
    (id) => id && id !== opts.creatorUserId,
  );
  const participatingCreatorIds = [opts.creatorUserId, ...coCreatorUserIds];
  const codeFallback = opts.affiliateCodes.length === 0;
  let codes = opts.affiliateCodes;
  if (codeFallback) {
    const owned = await queryMainRows<{ code: string }[]>(
      `SELECT code FROM affiliate_codes WHERE user_id = ANY($1::text[])`,
      participatingCreatorIds,
    );
    codes = owned.map((row) => row.code);
  }
  const upperCodes = Array.from(
    new Set(codes.map((code) => code.trim().toUpperCase()).filter(Boolean)),
  );
  if (upperCodes.length === 0) {
    return { totalEntries: 0, totalWageredUsd: 0, entries: [] };
  }

  const params: unknown[] = [upperCodes, opts.startDate, opts.endDate];
  const creatorFilter = codeFallback
    ? `AND acu.affiliate_user_id = ANY($4::text[])`
    : ``;
  if (codeFallback) params.push(participatingCreatorIds);
  const limitParameter = params.length + 1;
  const offsetParameter = params.length + 2;
  params.push(pageSize, offset);

  const rows = await queryMainRows<{
    position: string;
    username: string | null;
    total_wagered_usd: string;
    total_entries: string;
    leaderboard_wagered_usd: string;
  }[]>(
    `WITH ranked AS (
       SELECT
         ROW_NUMBER() OVER (
           ORDER BY SUM(COALESCE(acu.weighted_wager_amount_usd, acu.wager_amount_usd)::numeric) DESC,
                    acu.referred_user_id ASC
         )::text AS position,
         u.username,
         SUM(COALESCE(acu.weighted_wager_amount_usd, acu.wager_amount_usd)::numeric)::text
           AS total_wagered_usd,
         COUNT(*) OVER()::text AS total_entries,
         SUM(SUM(COALESCE(acu.weighted_wager_amount_usd, acu.wager_amount_usd)::numeric))
           OVER()::text AS leaderboard_wagered_usd
       FROM affiliate_code_usages acu
       JOIN "user" u ON u.id = acu.referred_user_id
       WHERE acu.usage_type::text = 'wager'
         AND UPPER(acu.code) = ANY($1::text[])
         AND acu.created_at >= $2
         AND acu.created_at < $3
         AND u.role::text NOT IN ('admin', 'support')
         ${creatorFilter}
       GROUP BY acu.referred_user_id, u.username
       HAVING SUM(COALESCE(acu.weighted_wager_amount_usd, acu.wager_amount_usd)::numeric) > 0
     )
     SELECT position, username, total_wagered_usd, total_entries,
            leaderboard_wagered_usd
     FROM ranked
     ORDER BY position::bigint ASC
     LIMIT $${limitParameter} OFFSET $${offsetParameter}`,
    ...params,
  );

  return {
    totalEntries: Number(rows[0]?.total_entries ?? 0),
    totalWageredUsd: toNumber(rows[0]?.leaderboard_wagered_usd),
    entries: rows.map((row) => {
      const position = Number(row.position);
      return {
        position,
        username: row.username,
        totalWageredUsd: toNumber(row.total_wagered_usd),
        prizeUsd: prizeByPosition.get(position) ?? null,
      };
    }),
  };
}

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
  /**
   * Backend leaderboard id. When supplied, settled standings are read from
   * `affiliate_leaderboard_snapshots` (the weighted source of truth) if a
   * snapshot exists; otherwise the live raw computation below runs.
   */
  leaderboardId?: string;
  creatorUserId: string;
  coCreatorUserIds?: string[];
  affiliateCodes: string[];
  startDate: Date;
  endDate: Date;
  prizeTiers: { position: number; prize_amount_usd: string }[];
  limit?: number;
}): Promise<LeaderboardStandings> {
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

  // Excluded-users blacklist — used only to FLAG rows now, never to drop
  // them. This view must mirror the real packy.gg leaderboard (a blacklisted
  // user who's actually #1 has to show as #1 here too); the badge tells the
  // operator they're excluded from analytics. Fail-soft to no flags.
  const excludedSet = new Set(
    await getExcludedUserIds().catch(() => [] as string[]),
  );

  // ── Settled standings: prefer the authoritative weighted snapshot ──
  // The game applies per-game wager WEIGHTS (packs / battles / upgrader
  // count at different rates toward leaderboards). Those weights are
  // frozen at wager time and the resulting weighted standings are written
  // into `affiliate_leaderboard_snapshots` when a board settles. Raw
  // `affiliate_code_usages.wager_amount_usd` is UNWEIGHTED, so recomputing
  // from it (the live path below) mis-ranks and mis-prizes any board that
  // ran under non-1× weights. Whenever a snapshot exists, it wins.
  // Lookup is by (leaderboard_id, position) — hits
  // `affiliate_leaderboard_snapshots_leaderboard_position_idx`.
  if (opts.leaderboardId) {
    const snaps = await queryMainRows<{
      user_id: string;
      position: number;
      total_wagered_usd: string;
      prize_amount_usd: string;
      username: string | null;
      email: string | null;
    }[]>(
      `SELECT als.user_id, als.position,
              als.total_wagered_usd::text AS total_wagered_usd,
              als.prize_amount_usd::text AS prize_amount_usd,
              u.username, u.email
       FROM affiliate_leaderboard_snapshots als
       LEFT JOIN "user" u ON u.id = als.user_id
       WHERE als.leaderboard_id = $1
       ORDER BY als.position ASC
       LIMIT $2`,
      opts.leaderboardId,
      limit,
    );
    if (snaps.length > 0) {
      const snapPrizeByPosition = new Map<number, number>();
      for (const t of prizeTiers) {
        snapPrizeByPosition.set(t.position, toNumber(t.prize_amount_usd));
      }
      const pnlByUser = await calculateUsersBoundedWindowedPnlBatch(
        snaps.map((s) => s.user_id),
        startDate,
        endDate,
      ).catch((err) => {
        console.error("[leaderboard] windowed PnL batch failed (snapshot)", err);
        return new Map<string, number>();
      });
      return {
        source: "settled",
        rankings: snaps.map((s) => {
          const snapPrize = toNumber(s.prize_amount_usd);
          return {
            position: s.position,
            userId: s.user_id,
            username: s.username,
            email: s.email,
            totalWageredUsd: toNumber(s.total_wagered_usd),
            housePnlUsd: pnlByUser.get(s.user_id) ?? 0,
            // Prefer the prize frozen on the snapshot; fall back to the
            // current prize-tier table by position when the snapshot
            // didn't carry one (legacy rows default prize to 0).
            prizeUsd:
              snapPrize > 0
                ? snapPrize
                : (snapPrizeByPosition.get(s.position) ?? null),
            // The snapshot doesn't record when a place was reached, and a
            // raw running-total estimate wouldn't line up with the weighted
            // positions — leave it blank for settled standings.
            positionReachedAt: null,
            excluded: excludedSet.has(s.user_id),
          };
        }),
      };
    }
  }

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
    const owned = await queryMainRows<{ code: string }[]>(
      `SELECT code FROM affiliate_codes WHERE user_id = ANY($1::text[])`,
      participatingCreatorIds,
    );
    codes = owned.map((c) => c.code);
  }
  if (codes.length === 0) return { rankings: [], source: "live" }; // no codes resolved for any participating creator

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
  // Rank by the leaderboard-WEIGHTED wager (per-game weight frozen at insert
  // time), matching the backend's live leaderboard + the settled snapshots
  // exactly: COALESCE(weighted_wager_amount_usd, wager_amount_usd) — pre-feature
  // rows have NULL weighted values and count at full weight. Summing raw
  // wager_amount_usd here used to mis-rank/mis-total any board with non-1×
  // game weights vs what packy.gg actually shows.
  const rows = await queryMainRows<Row[]>(
    `SELECT
       acu.referred_user_id AS user_id,
       u.username,
       u.email,
       SUM(COALESCE(acu.weighted_wager_amount_usd, acu.wager_amount_usd)::numeric)::text AS total_wagered
     FROM affiliate_code_usages acu
     JOIN "user" u ON u.id = acu.referred_user_id
     WHERE acu.usage_type::text = 'wager'
       AND UPPER(acu.code) = ANY($1::text[])
       AND acu.created_at >= $2
       AND acu.created_at <  $3
       AND u.role NOT IN ('admin', 'support')
       ${whereExtra}
     GROUP BY acu.referred_user_id, u.username, u.email
     HAVING SUM(COALESCE(acu.weighted_wager_amount_usd, acu.wager_amount_usd)::numeric) > 0
     ORDER BY SUM(COALESCE(acu.weighted_wager_amount_usd, acu.wager_amount_usd)::numeric) DESC
     LIMIT ${limit}`,
    ...params,
  );

  // Build a position → prize lookup once so the per-row mapping is O(1).
  const prizeByPosition = new Map<number, number>();
  for (const t of prizeTiers) {
    prizeByPosition.set(t.position, toNumber(t.prize_amount_usd));
  }

  const userIds = rows.map((r) => r.user_id);
  const totals = rows.map((r) => toNumber(r.total_wagered));
  const thresholds = rows.map((_, i) =>
    i + 1 < rows.length ? totals[i + 1]! : 0,
  );

  const [pnlByUser, reachedAtByUser] = await Promise.all([
    calculateUsersBoundedWindowedPnlBatch(userIds, startDate, endDate).catch(
      (err) => {
        console.error("[leaderboard] windowed PnL batch failed", err);
        return new Map<string, number>();
      },
    ),
    getPositionReachedAtBatch({
      userIds,
      thresholds,
      totals,
      upperCodes,
      startDate,
      endDate,
      codeFallback,
      participatingCreatorIds,
    }).catch((err) => {
      console.error("[leaderboard] position reached-at batch failed", err);
      return new Map<string, Date>();
    }),
  ]);

  const rankings = rows.map((r, i) => {
    const position = i + 1;
    const reached = reachedAtByUser.get(r.user_id);
    return {
      position,
      userId: r.user_id,
      username: r.username,
      email: r.email,
      totalWageredUsd: totals[i]!,
      housePnlUsd: pnlByUser.get(r.user_id) ?? 0,
      prizeUsd: prizeByPosition.get(position) ?? null,
      positionReachedAt: reached ? reached.toISOString() : null,
      excluded: excludedSet.has(r.user_id),
    };
  });
  return { rankings, source: "live" };
}

export type LeaderboardClaim = {
  userId: string;
  username: string | null;
  email: string | null;
  position: number;
  prizeUsd: number;
  claimedAt: string;
  ledgerTxId: string;
};

/**
 * Already-settled prize claims for a single affiliate / creator leaderboard.
 *
 * Reads `affiliate_leaderboard_claims` on the MAIN DB — one immutable row per
 * (leaderboard, user) the moment a participant claims their prize. The
 * `WHERE leaderboard_id = $1` lookup hits the
 * `affiliate_leaderboard_claims_leaderboard_user_unique` index (leaderboard_id
 * is the leading column), verified read-only via EXPLAIN (Bitmap Index Scan,
 * no seq scan). The `user` join is a PK lookup. Ordered by finishing position
 * so the panel renders top finishers first.
 */
export async function getAffiliateLeaderboardClaims(
  leaderboardId: string,
): Promise<LeaderboardClaim[]> {
  const rows = await queryMainRows<{
    user_id: string;
    position: number;
    prize_amount_usd: string;
    claimed_at: Date | string;
    ledger_tx_id: string;
    username: string | null;
    email: string | null;
  }[]>(
    `SELECT alc.user_id, alc.position,
            alc.prize_amount_usd::text AS prize_amount_usd,
            alc.claimed_at, alc.ledger_tx_id,
            u.username, u.email
     FROM affiliate_leaderboard_claims alc
     LEFT JOIN "user" u ON u.id = alc.user_id
     WHERE alc.leaderboard_id = $1
     ORDER BY alc.position ASC`,
    leaderboardId,
  );

  return rows.map((r) => ({
    userId: r.user_id,
    username: r.username,
    email: r.email,
    position: r.position,
    prizeUsd: toNumber(r.prize_amount_usd),
    claimedAt: new Date(r.claimed_at).toISOString(),
    ledgerTxId: r.ledger_tx_id,
  }));
}

type PositionReachedParams = {
  userIds: string[];
  thresholds: number[];
  totals: number[];
  upperCodes: string[];
  startDate: Date;
  endDate: Date;
  codeFallback: boolean;
  participatingCreatorIds: string[];
};

async function getPositionReachedAtBatch(
  params: PositionReachedParams,
): Promise<Map<string, Date>> {
  const {
    userIds,
    thresholds,
    totals,
    upperCodes,
    startDate,
    endDate,
    codeFallback,
    participatingCreatorIds,
  } = params;

  if (userIds.length === 0) return new Map();

  const whereExtra = codeFallback
    ? `AND acu.affiliate_user_id = ANY($7::text[])`
    : ``;
  const sqlParams: unknown[] = codeFallback
    ? [
        userIds,
        thresholds,
        totals,
        upperCodes,
        startDate,
        endDate,
        participatingCreatorIds,
      ]
    : [userIds, thresholds, totals, upperCodes, startDate, endDate];

  const query = `
    WITH params AS (
      SELECT *
      FROM UNNEST($1::text[], $2::numeric[], $3::numeric[])
        AS p(user_id, threshold, total_wager)
    ),
    events AS (
      SELECT
        acu.referred_user_id AS user_id,
        acu.created_at,
        SUM(COALESCE(acu.weighted_wager_amount_usd, acu.wager_amount_usd)::numeric) OVER (
          PARTITION BY acu.referred_user_id
          ORDER BY acu.created_at ASC, acu.id ASC
          ROWS UNBOUNDED PRECEDING
        ) AS running_total
      FROM affiliate_code_usages acu
      WHERE acu.usage_type::text = 'wager'
        AND UPPER(acu.code) = ANY($4::text[])
        AND acu.created_at >= $5
        AND acu.created_at < $6
        AND acu.referred_user_id = ANY($1::text[])
        ${whereExtra}
    ),
    joined AS (
      SELECT
        p.user_id,
        e.created_at,
        e.running_total,
        p.threshold,
        p.total_wager
      FROM params p
      JOIN events e ON e.user_id = p.user_id
    )
    SELECT
      user_id,
      COALESCE(
        MIN(created_at) FILTER (WHERE running_total > threshold),
        MIN(created_at) FILTER (WHERE running_total >= total_wager)
      ) AS reached_at
    FROM joined
    GROUP BY user_id
  `;

  const reachedRows = await queryMainRows<
    { user_id: string; reached_at: Date | string | null }[]
  >(query, ...sqlParams);

  const map = new Map<string, Date>();
  for (const row of reachedRows) {
    if (row.reached_at) map.set(row.user_id, new Date(row.reached_at));
  }
  return map;
}
