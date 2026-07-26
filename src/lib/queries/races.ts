import { unstable_cache } from "next/cache";
import { drizzleForEnv } from "@/lib/db";
import { queryMainRows, queryRows } from "@/lib/drizzle-query";
import { readDbEnv, type DbEnv } from "@/lib/db-env";
import { toNumber } from "@/lib/utils/decimal";
import type { PaginatedResult } from "@/lib/types";
import { getRewardExpiry } from "@/lib/backend-api/reward-expiry";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import {
  computeRaceClaimWindow,
  type RaceClaimWindow,
} from "@/lib/reward-expiry/race-claim-window";

export type RacePrizeTier = {
  id: string;
  raceType: string;
  position: number;
  prizeAmountUsd: number;
};

export type RacePeriod = {
  id: string;
  raceType: string;
  startsAt: string;
  endsAt: string;
  autoRenew: boolean;
  status: string;
  // Global claim kill-switch. Only meaningful for ended periods: while
  // claimsFrozen is true no winner can claim. unfrozenAt/By record who
  // opened claims (lifted the freeze) and when.
  claimsFrozen: boolean;
  claimsUnfrozenAt: string | null;
  claimsUnfrozenBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RaceClaimItem = {
  id: string;
  userId: string;
  username: string | null;
  raceType: string;
  racePeriodStart: string;
  position: number;
  prizeAmountUsd: number;
  claimedAt: string;
};

export type RaceClaimHoldInfo = {
  id: string;
  reason: string;
  createdBy: string;
  createdAt: string;
};

export type RaceLeaderboardEntry = {
  id: string;
  userId: string;
  username: string | null;
  position: number;
  wageredUsd: number;
  /** Projected prize from race_prize_tiers; null when no tier for this position. */
  prizeAmountUsd: number | null;
  // Per-user claim review state for the selected period. `hold` is the active
  // (un-released) hold blocking this user's claim, if any. `claimedAt` is set
  // once the prize has been paid out — a claimed prize can no longer be frozen.
  // Both are null in the all-time ("all") view, which has no single period.
  hold: RaceClaimHoldInfo | null;
  claimedAt: string | null;
  /**
   * True when the user is on the admin excluded-users blacklist. The
   * standings deliberately still INCLUDE them (so this view mirrors the
   * real, user-facing leaderboard on packy.gg) and just flag them so an
   * operator can tell they're excluded from analytics aggregates. Mirrors
   * the same flag on the affiliate leaderboards (creators-leaderboards.ts).
   */
  excluded: boolean;
};

export async function getRacePrizeTiers() {
  const tiers = await queryMainRows<
    { id: string; race_type: string; position: number; prize_amount_usd: string }[]
  >(
    `SELECT id, race_type::text AS race_type, position, prize_amount_usd::text
       FROM race_prize_tiers ORDER BY race_type, position`,
  );

  return tiers.map((r) => ({
    id: r.id,
    raceType: r.race_type,
    position: r.position,
    prizeAmountUsd: toNumber(r.prize_amount_usd),
  }));
}

export async function getRaceClaims(params: {
  page?: number;
  perPage?: number;
  raceType?: string;
}): Promise<PaginatedResult<RaceClaimItem>> {
  const { page = 1, perPage = 20, raceType } = params;
  const safePage = Math.max(1, Math.floor(page));
  const safePerPage = Math.max(1, Math.min(200, Math.floor(perPage)));
  const filter = raceType && raceType !== "all" ? "WHERE rc.race_type::text = $1" : "";
  const values = raceType && raceType !== "all" ? [raceType] : [];
  const [claims, countRows] = await Promise.all([
    queryMainRows<
      {
        id: string;
        user_id: string;
        username: string | null;
        race_type: string;
        race_period_start: Date | string;
        position: number;
        prize_amount_usd: string;
        claimed_at: Date | string;
      }[]
    >(
      `SELECT rc.id, rc.user_id, u.username, rc.race_type::text AS race_type,
              rc.race_period_start, rc.position, rc.prize_amount_usd::text,
              rc.claimed_at
         FROM race_claims rc LEFT JOIN "user" u ON u.id = rc.user_id
         ${filter}
         ORDER BY rc.claimed_at DESC
         LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      ...values,
      safePerPage,
      (safePage - 1) * safePerPage,
    ),
    queryMainRows<{ total: string }[]>(
      `SELECT COUNT(*)::text AS total FROM race_claims rc ${filter}`,
      ...values,
    ),
  ]);
  const total = Number(countRows[0]?.total ?? 0);

  return {
    data: claims.map((c) => ({
      id: c.id,
      userId: c.user_id,
      username: c.username,
      raceType: c.race_type,
      racePeriodStart: new Date(c.race_period_start).toISOString(),
      position: c.position,
      prizeAmountUsd: toNumber(c.prize_amount_usd),
      claimedAt: new Date(c.claimed_at).toISOString(),
    })),
    total,
    page: safePage,
    perPage: safePerPage,
    totalPages: Math.ceil(total / safePerPage),
  };
}

export type RaceLeaderboardPeriod = {
  periodStart: string;
  participants: number;
  /**
   * True when this period_start is the currently-running race (its race_periods
   * row is status='active'). A running MONTHLY race has NO snapshot rows yet —
   * snapshots are generated when a period ENDS, and only daily/weekly get live
   * snapshots while running (verified read-only against prod: the active
   * monthly period had 0 snapshot rows while the active weekly had 153). Such a
   * race is injected here with participants=0 so the Standings view surfaces +
   * defaults to the current race instead of silently falling back to the last
   * ENDED period.
   */
  isActive: boolean;
};

/**
 * The leaderboards selectable for a race type. Primarily the periods that
 * actually exist in race_leaderboard_snapshots (one group per period_start) —
 * instead of guessing a calendar date that may not line up with any real
 * period (monthly races run on custom cadences, so a "1st of the month" guess
 * shows nothing). The currently-active race (from race_periods) is always
 * included even when it has no snapshot rows yet, so the running race is never
 * missing from the picker. Most-recent first.
 */
export async function getRaceLeaderboardPeriods(params: {
  raceType: string;
  limit?: number;
}): Promise<RaceLeaderboardPeriod[]> {
  const { raceType, limit = 120 } = params;

  // All-time has no single period — nothing to select.
  if (!raceType || raceType === "all") return [];

  const [groups, activeRows] = await Promise.all([
    queryMainRows<{ period_start: Date | string; count: string }[]>(
      `SELECT period_start, COUNT(*)::text AS count
         FROM race_leaderboard_snapshots
        WHERE race_type::text = $1
        GROUP BY period_start
        ORDER BY period_start DESC LIMIT $2`,
      raceType,
      Math.max(1, Math.min(500, limit)),
    ),
    // Tiny lookup — one active row per race type (seq scan is optimal, same
    // read-only pattern as getRacePeriodsOverview). Used to surface a running
    // race that has no snapshot rows yet. `starts_at` is `timestamp without
    // time zone`; read its calendar day DB-side as a UTC-naive string
    // (to_char) instead of round-tripping through a JS Date, whose parsing of
    // that column type is driver-dependent. This key equals `starts_at::date`,
    // the same value getLiveRaceLeaderboard matches on.
    queryMainRows<{ start_date: string }[]>(
      `
      SELECT to_char(starts_at, 'YYYY-MM-DD') AS start_date
      FROM race_periods
      WHERE race_type::text = $1 AND status = 'active'
      ORDER BY starts_at DESC
      LIMIT 1
      `,
      raceType,
    ),
  ]);

  // Snapshots key their period_start to the calendar day the period started
  // (verified against prod: an ended period's snapshots sit under
  // DATE(starts_at)), so the active period's key is derived the same way.
  const activeStart = activeRows[0]?.start_date ?? null;

  const periods: RaceLeaderboardPeriod[] = groups.map((g) => {
    const periodStart = new Date(g.period_start).toISOString().slice(0, 10);
    return {
      periodStart,
      participants: Number(g.count),
      isActive: activeStart === periodStart,
    };
  });

  // Inject the running race when it has no snapshot rows yet (the monthly
  // case). Daily/weekly active periods already appear via `groups` (live
  // snapshots), so this only ever adds a missing entry, never a duplicate.
  if (activeStart && !periods.some((p) => p.periodStart === activeStart)) {
    periods.push({ periodStart: activeStart, participants: 0, isActive: true });
  }

  // Most-recent first; the active period sorts to the top by its start date.
  periods.sort((a, b) =>
    a.periodStart < b.periodStart ? 1 : a.periodStart > b.periodStart ? -1 : 0,
  );

  return periods;
}

export async function getRaceLeaderboard(params: {
  raceType?: string;
  periodStart?: string;
  search?: string;
  page?: number;
  perPage?: number;
}): Promise<PaginatedResult<RaceLeaderboardEntry>> {
  const { raceType = "daily", periodStart, search, page = 1, perPage = 20 } = params;
  const safePage = Math.max(1, Math.floor(page));
  const safePerPage = Math.max(1, Math.min(200, Math.floor(perPage)));

  if (raceType === "all") {
    return getAllTimeLeaderboard({ search, page, perPage });
  }

  const values: unknown[] = [raceType];
  const filters = ["rls.race_type::text = $1"];
  if (periodStart) {
    values.push(new Date(periodStart));
    filters.push(`rls.period_start = $${values.length}`);
  }
  if (search) {
    values.push(`%${search.toLowerCase()}%`, search);
    filters.push(
      `(LOWER(u.username) LIKE $${values.length - 1}
        OR LOWER(u.email) LIKE $${values.length - 1}
        OR u.id = $${values.length})`,
    );
  }
  const whereSql = filters.join(" AND ");

  // `position` on race_leaderboard_snapshots is only finalized once a period
  // ends — a backend job assigns 1..N (by wagered_usd desc) at that point.
  // While the period is still running every row's position stays 0 (verified
  // read-only against prod: the active weekly period starting 2026-07-06 had
  // all 371 rows at position 0, while the prior ended period was correctly
  // 1..N and matched ORDER BY wagered_usd DESC exactly through the
  // prize-tier range). Sorting by the raw column then shows every row as
  // "#0" in an arbitrary order. Detect that case and rank live by
  // wagered_usd instead of trusting the unset column.
  const maxPositionRows = await queryMainRows<{ max_position: number | null }[]>(
    `SELECT MAX(rls.position) AS max_position
       FROM race_leaderboard_snapshots rls
       LEFT JOIN "user" u ON u.id = rls.user_id
      WHERE ${whereSql}`,
    ...values,
  );
  const unfinalized = (maxPositionRows[0]?.max_position ?? 0) === 0;

  // Excluded-users blacklist — used only to FLAG rows, never to drop them.
  // Mirrors the affiliate leaderboards: a blacklisted user who's actually #1
  // still has to show as #1 here. Fail-soft to no flags.
  const excludedSet = new Set(
    await getExcludedUserIds().catch(() => [] as string[]),
  );

  const [entries, countRows, tiers] = await Promise.all([
    queryMainRows<
      {
        id: string;
        user_id: string;
        username: string | null;
        position: number;
        wagered_usd: string;
      }[]
    >(
      `SELECT rls.id, rls.user_id, u.username, rls.position,
              rls.wagered_usd::text
         FROM race_leaderboard_snapshots rls
         LEFT JOIN "user" u ON u.id = rls.user_id
        WHERE ${whereSql}
        ORDER BY ${unfinalized ? "rls.wagered_usd DESC, rls.user_id ASC" : "rls.position ASC"}
        LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      ...values,
      safePerPage,
      (safePage - 1) * safePerPage,
    ),
    queryMainRows<{ total: string }[]>(
      `SELECT COUNT(*)::text AS total
         FROM race_leaderboard_snapshots rls
         LEFT JOIN "user" u ON u.id = rls.user_id
        WHERE ${whereSql}`,
      ...values,
    ),
    queryMainRows<{ position: number; prize_amount_usd: string }[]>(
      `SELECT position, prize_amount_usd::text
         FROM race_prize_tiers WHERE race_type::text = $1`,
      raceType,
    ),
  ]);
  const total = Number(countRows[0]?.total ?? 0);

  // No snapshot rows for this period. If it's the currently-RUNNING race,
  // compute standings LIVE from game_sessions — a monthly race is only
  // snapshotted when it ENDS (daily/weekly get live snapshot rows and are
  // served by the path above, so this only ever fires for the monthly gap).
  // Validated read-only against prod: SUM(race-eligible bet_amount) over the
  // race window reproduces the finalized snapshot wagered_usd cent-exact.
  if (total === 0 && periodStart) {
    const live = await getLiveRaceLeaderboard({
      raceType,
      periodStart,
      search,
      page,
      perPage,
      excludedUserIds: [...excludedSet],
    });
    if (live) return live;
  }

  const tierByPosition = new Map(
    tiers.map((t) => [t.position, toNumber(t.prize_amount_usd)] as const),
  );

  // Overlay per-user claim review state (active holds + paid claims) for the
  // selected period so the leaderboard doubles as the fraud-review surface.
  // Only the rows on this page are looked up — one round-trip each.
  const userIds = entries.map((e) => e.user_id);
  const periodDate = periodStart ? new Date(periodStart) : null;
  const holdByUser = new Map<string, RaceClaimHoldInfo>();
  const claimedAtByUser = new Map<string, string>();
  if (periodDate && userIds.length > 0) {
    const [holds, claims] = await Promise.all([
      queryMainRows<
        {
          id: string;
          user_id: string;
          reason: string;
          created_by: string;
          created_at: Date | string;
        }[]
      >(
        `SELECT id, user_id, reason, created_by, created_at
           FROM race_claim_holds
          WHERE race_type::text = $1 AND race_period_start = $2
            AND released_at IS NULL AND user_id = ANY($3::text[])`,
        raceType,
        periodDate,
        userIds,
      ),
      queryMainRows<{ user_id: string; claimed_at: Date | string }[]>(
        `SELECT user_id, claimed_at FROM race_claims
          WHERE race_type::text = $1 AND race_period_start = $2
            AND user_id = ANY($3::text[])`,
        raceType,
        periodDate,
        userIds,
      ),
    ]);
    for (const h of holds) {
      holdByUser.set(h.user_id, {
        id: h.id,
        reason: h.reason,
        createdBy: h.created_by,
        createdAt: new Date(h.created_at).toISOString(),
      });
    }
    for (const c of claims) {
      claimedAtByUser.set(c.user_id, new Date(c.claimed_at).toISOString());
    }
  }

  return {
    data: entries.map((e, i) => {
      const rank = unfinalized ? (safePage - 1) * safePerPage + i + 1 : e.position;
      return {
        id: e.id,
        userId: e.user_id,
        username: e.username,
        position: rank,
        wageredUsd: toNumber(e.wagered_usd),
        prizeAmountUsd: tierByPosition.get(rank) ?? null,
        hold: holdByUser.get(e.user_id) ?? null,
        claimedAt: claimedAtByUser.get(e.user_id) ?? null,
        excluded: excludedSet.has(e.user_id),
      };
    }),
    total,
    page: safePage,
    perPage: safePerPage,
    totalPages: Math.ceil(total / safePerPage),
  };
}

/**
 * Live standings for a RUNNING race, computed from game_sessions.
 *
 * Why this exists: a monthly race is only written into
 * race_leaderboard_snapshots when it ENDS (daily/weekly get live snapshot rows
 * while running, so those are served from the snapshot path). Without this the
 * admin sees nothing for the current monthly race until it closes.
 *
 * Source of truth: the race leaderboard is the sum of each user's
 * race-eligible LEADERBOARD-WEIGHTED wager over the period window —
 * `game_sessions.weighted_bet_amount`, not raw `bet_amount`. Per-game
 * leaderboard weights (packs/battles/upgrader, admin-configurable in bps on
 * /security) are applied at wager time and frozen on the row, so a game
 * whose weight was temporarily reduced (verified read-only against prod:
 * upgrader_bps was cut to 6000 then 5000 on 2026-06-13/14 before later
 * returning to 10000) leaves `weighted_bet_amount < bet_amount` for wagers
 * placed in that window. Summing raw `bet_amount` instead over-counts those
 * users and can misrank them relative to the real (weighted) leaderboard —
 * confirmed against prod for the active monthly race starting 2026-06-19,
 * where it swapped two adjacent standings. `weighted_bet_amount` is
 * COALESCEd to `bet_amount` for the (pre-2026-06-13) rows that predate the
 * column, where the two are equal anyway.
 *
 * Returns null when `periodStart` is NOT a currently-active race period, so
 * the caller falls back to its empty result (this never fabricates standings
 * for an ended period that simply has no snapshots).
 */
export async function getLiveRaceLeaderboard(params: {
  raceType: string;
  periodStart: string;
  search?: string;
  page?: number;
  perPage?: number;
  /** Excluded-users blacklist, resolved by the caller (admin DB, can't run in the cache scope). */
  excludedUserIds: string[];
}): Promise<PaginatedResult<RaceLeaderboardEntry> | null> {
  const {
    raceType,
    periodStart,
    search,
    page = 1,
    perPage = 20,
    excludedUserIds,
  } = params;
  if (!raceType || raceType === "all") return null;
  const safePage = Math.max(1, Math.floor(page));
  const safePerPage = Math.max(1, Math.min(200, Math.floor(perPage)));

  // Only the currently-RUNNING race gets a live view. Match the active
  // race_period by its (UTC-naive) start DATE == periodStart, and read the
  // window bounds DB-side as UTC-naive strings. Both game_sessions.created_at
  // and race_periods.starts_at/ends_at are `timestamp without time zone` on the
  // SAME UTC-naive clock, so the window is a direct naive comparison — no
  // timezone conversion and no driver-dependent Date round-trip (verified: the
  // pg driver parses that column type as LOCAL, which would shift the window
  // hours off). No active match → not live; return null so the caller falls
  // back to its empty result (never fabricates standings for an ended period).
  const win = await queryMainRows<
    { starts_naive: string; ends_naive: string }[]
  >(
    `
    SELECT
      to_char(starts_at, 'YYYY-MM-DD HH24:MI:SS') AS starts_naive,
      to_char(ends_at,   'YYYY-MM-DD HH24:MI:SS') AS ends_naive
    FROM race_periods
    WHERE race_type::text = $1
      AND status = 'active'
      AND starts_at::date = $2::date
    ORDER BY created_at DESC
    LIMIT 1
    `,
    raceType,
    periodStart,
  );
  const activeWindow = win[0];
  if (!activeWindow) return null;

  // Resolve env in the request scope (cookie), then compute inside the cache
  // keyed on that env so the prod/dev toggle is respected.
  const env = await readDbEnv();
  const { rows, total, tiers } = await cachedLiveRaceStandings(
    env,
    raceType,
    activeWindow.starts_naive,
    activeWindow.ends_naive,
    search?.trim() ? search.trim() : null,
    safePage,
    safePerPage,
  );

  const tierByPosition = new Map(tiers.map((t) => [t.position, t.prize] as const));
  const excluded = new Set(excludedUserIds);

  return {
    data: rows.map((r) => ({
      id: r.user_id,
      userId: r.user_id,
      username: r.username,
      position: r.position,
      wageredUsd: toNumber(r.wagered),
      prizeAmountUsd: tierByPosition.get(r.position) ?? null,
      // A running race has no finalized claims/holds yet.
      hold: null,
      claimedAt: null,
      excluded: excluded.has(r.user_id),
    })),
    total,
    page: safePage,
    perPage: safePerPage,
    totalPages: Math.max(1, Math.ceil(total / safePerPage)),
  };
}

type LiveStandingRow = {
  user_id: string;
  username: string | null;
  wagered: string;
  position: number;
};

/**
 * Cached live-standings compute (30s), keyed on env + window + paging + search
 * so it only ever holds the ACTIVE period's window (Active-Timeframe-Only).
 *
 * Index-safety: `startsNaive`/`endsNaive` are UTC-naive strings compared
 * directly against `game_sessions.created_at` (also UTC-naive) as `::timestamp`
 * constants, `created_at` bare — the range hits
 * idx_game_sessions_created_at_user_bet (verified read-only via EXPLAIN: Bitmap
 * Index Scan, ~47ms over a month window, no seq scan — unchanged by reading
 * `weighted_bet_amount`, since the `race_eligible` filter already forces a
 * heap fetch on every matched row regardless). `race_eligible` mirrors the
 * backend's race inclusion. ROW_NUMBER over the aggregated (~1k) users
 * assigns each user their TRUE global position, so a searched user still shows
 * their real rank.
 *
 * Sums `weighted_bet_amount` (COALESCEd to `bet_amount` for pre-2026-06-13
 * rows that predate the column, where the two are equal), NOT raw
 * `bet_amount` — see the leaderboard-weighting caveat on
 * `getLiveRaceLeaderboard` above.
 */
const cachedLiveRaceStandings = unstable_cache(
  async (
    env: DbEnv,
    raceType: string,
    startsNaive: string,
    endsNaive: string,
    search: string | null,
    page: number,
    perPage: number,
  ): Promise<{
    rows: LiveStandingRow[];
    total: number;
    tiers: { position: number; prize: number }[];
  }> => {
    const db = drizzleForEnv(env);
    const safePage = Math.max(1, Math.floor(page));
    const safePerPage = Math.max(1, Math.min(200, Math.floor(perPage)));
    const offset = (safePage - 1) * safePerPage;
    const like = search ? `%${search}%` : null;
    const idEq = search ?? "";

    const [rows, countRes, tiers] = await Promise.all([
      queryRows<LiveStandingRow[]>(db, `
        WITH agg AS (
          SELECT g.user_id, SUM(COALESCE(g.weighted_bet_amount, g.bet_amount)) AS wagered
          FROM game_sessions g
          WHERE g.race_eligible = true
            AND g.user_id IS NOT NULL
            AND g.created_at >= $1::timestamp
            AND g.created_at <  $2::timestamp
          GROUP BY g.user_id
          HAVING SUM(COALESCE(g.weighted_bet_amount, g.bet_amount)) > 0
        ),
        ranked AS (
          SELECT
            user_id,
            wagered,
            (ROW_NUMBER() OVER (ORDER BY wagered DESC, user_id ASC))::int AS position
          FROM agg
        )
        SELECT r.user_id, u.username, r.wagered::text AS wagered, r.position
        FROM ranked r
        JOIN "user" u ON u.id = r.user_id
        WHERE ($3::text IS NULL
               OR u.username ILIKE $3
               OR u.email ILIKE $3
               OR r.user_id = $4)
        ORDER BY r.position
        LIMIT $5 OFFSET $6
      `, startsNaive, endsNaive, like, idEq, safePerPage, offset),
      queryRows<{ count: string }[]>(db, `
        SELECT COUNT(*)::bigint AS count FROM (
          SELECT g.user_id
          FROM game_sessions g
          LEFT JOIN "user" u ON u.id = g.user_id
          WHERE g.race_eligible = true
            AND g.user_id IS NOT NULL
            AND g.created_at >= $1::timestamp
            AND g.created_at <  $2::timestamp
            AND ($3::text IS NULL
              OR u.username ILIKE $3 OR u.email ILIKE $3 OR g.user_id = $4)
          GROUP BY g.user_id
          HAVING SUM(COALESCE(g.weighted_bet_amount, g.bet_amount)) > 0
        ) t
      `, startsNaive, endsNaive, like, idEq),
      queryRows<{ position: number; prize_amount_usd: string }[]>(
        db,
        `SELECT position, prize_amount_usd::text
           FROM race_prize_tiers WHERE race_type::text = $1`,
        raceType,
      ),
    ]);

    return {
      rows,
      total: Number(countRes[0]?.count ?? 0),
      tiers: tiers.map((t) => ({
        position: t.position,
        prize: toNumber(t.prize_amount_usd),
      })),
    };
  },
  ["race-live-standings-v1"],
  { revalidate: 30 },
);

/**
 * Total prize currently projected for players flagged "marked by admin"
 * (the excluded-users blacklist) on a single leaderboard — a fraud-exposure
 * counter: "how much prize money is a flagged player currently in line to win".
 *
 * A prize only exists for the top positions (race_prize_tiers), so this ranks
 * exactly the prize range and sums the tier prize for every marked player in
 * it. Reuses getRaceLeaderboard so it shares the SAME ranking (finalized
 * snapshot, live position-0 snapshot, OR the live game_sessions path) plus the
 * same `excluded` flag + prize-tier mapping the table renders — the number can
 * never disagree with the standings shown. Independent of the operator's
 * current page/search (always the whole prize range of the selected period).
 */
export async function getRaceMarkedPrizeExposure(params: {
  raceType: string;
  periodStart?: string;
}): Promise<{ total: number; count: number }> {
  const { raceType, periodStart } = params;
  const empty = { total: 0, count: 0 };
  if (!raceType || raceType === "all") return empty;

  // Prize range = the top N positions that carry a tier prize.
  const tiers = await getRacePrizeTiers();
  const maxTierPos = tiers.reduce(
    (m, t) => (t.raceType === raceType && t.position > m ? t.position : m),
    0,
  );
  if (maxTierPos === 0) return empty;

  const board = await getRaceLeaderboard({
    raceType,
    periodStart,
    page: 1,
    perPage: maxTierPos,
  });

  // Sum in integer cents so a handful of tier prizes never drifts on float.
  let cents = 0;
  let count = 0;
  for (const e of board.data) {
    if (e.excluded && e.prizeAmountUsd != null && e.prizeAmountUsd > 0) {
      cents += Math.round(e.prizeAmountUsd * 100);
      count += 1;
    }
  }
  return { total: cents / 100, count };
}

/**
 * Total prize money ALREADY CLAIMED by winners for a single leaderboard
 * period — shown next to the marked-prize exposure pill so an operator sees
 * both "how much is at risk (flagged players)" and "how much has actually
 * gone out the door" at a glance.
 *
 * Reads `race_claims` directly (one row per paid-out claim, written when a
 * winner claims their prize) rather than the leaderboard/snapshot path — a
 * claim can lag its period ending, so this always reflects the true payout
 * state regardless of whether the period is still live. `race_claims` is
 * tiny (186 rows total across all race types combined, verified read-only
 * against prod) so a Seq Scan filtered to one (race_type, period) pair is
 * optimal — confirmed via EXPLAIN: <0.1ms, no index needed (mirrors the
 * "tiny lookup" precedent on `race_periods` in `getRaceLeaderboardPeriods`).
 */
export async function getRaceTotalClaimed(params: {
  raceType: string;
  periodStart?: string;
}): Promise<{ total: number; count: number }> {
  const { raceType, periodStart } = params;
  if (!raceType || raceType === "all" || !periodStart) {
    return { total: 0, count: 0 };
  }

  const [result] = await queryMainRows<
    { total: string | null; count: string }[]
  >(
    `SELECT SUM(prize_amount_usd::numeric)::text AS total,
            COUNT(*)::text AS count
       FROM race_claims
      WHERE race_type::text = $1
        AND race_period_start = $2`,
    raceType,
    new Date(periodStart),
  );

  return {
    total: toNumber(result?.total ?? 0),
    count: Number(result?.count ?? 0),
  };
}

/**
 * Active period for each race type and the most recently ended one as a
 * compact history. Used by the Periods tab on /rewards/leaderboards so admins
 * can see at a glance which races are running, when they end, and whether
 * auto-renew is on. Monthly typically has no active row until an admin
 * manually starts one.
 */
export async function getRacePeriodsOverview(params?: {
  recentLimit?: number;
}): Promise<{ active: RacePeriod[]; recent: RacePeriod[] }> {
  const recentLimit = Math.max(
    1,
    Math.min(200, Math.floor(params?.recentLimit ?? 20)),
  );
  type RacePeriodRow = {
    id: string;
    race_type: string;
    starts_at: Date | string;
    ends_at: Date | string;
    auto_renew: boolean;
    status: string;
    claims_frozen: boolean;
    claims_unfrozen_at: Date | string | null;
    claims_unfrozen_by: string | null;
    created_at: Date | string;
    updated_at: Date | string;
  };

  const [active, recent] = await Promise.all([
    queryMainRows<RacePeriodRow[]>(
      `SELECT id, race_type::text AS race_type, starts_at, ends_at, auto_renew,
              status::text AS status, claims_frozen, claims_unfrozen_at,
              claims_unfrozen_by, created_at, updated_at
         FROM race_periods
        WHERE status = 'active'
        ORDER BY race_type`,
    ),
    queryMainRows<RacePeriodRow[]>(
      `SELECT id, race_type::text AS race_type, starts_at, ends_at, auto_renew,
              status::text AS status, claims_frozen, claims_unfrozen_at,
              claims_unfrozen_by, created_at, updated_at
         FROM race_periods
        WHERE status = 'ended'
        ORDER BY ends_at DESC
        LIMIT $1`,
      recentLimit,
    ),
  ]);

  const map = (p: RacePeriodRow): RacePeriod => ({
    id: p.id,
    raceType: p.race_type,
    startsAt: new Date(p.starts_at).toISOString(),
    endsAt: new Date(p.ends_at).toISOString(),
    autoRenew: p.auto_renew,
    status: p.status,
    claimsFrozen: p.claims_frozen,
    claimsUnfrozenAt: p.claims_unfrozen_at
      ? new Date(p.claims_unfrozen_at).toISOString()
      : null,
    claimsUnfrozenBy: p.claims_unfrozen_by,
    createdAt: new Date(p.created_at).toISOString(),
    updatedAt: new Date(p.updated_at).toISOString(),
  });

  return {
    active: active.map(map),
    recent: recent.map(map),
  };
}

/**
 * Claim-window context for a standings period — period end from snapshots or
 * race_periods, plus live race_days from the reward-expiry API.
 */
export async function getRaceStandingsClaimWindow(params: {
  raceType: string;
  periodStart: string;
}): Promise<RaceClaimWindow> {
  const { raceType, periodStart } = params;
  const periodStartDate = new Date(`${periodStart}T00:00:00.000Z`);
  const nextDay = new Date(periodStartDate.getTime() + 86_400_000);

  const [snapshotRows, racePeriodRows, expiryResult] = await Promise.all([
    queryMainRows<{ period_end: Date }[]>(
      `SELECT period_end
         FROM race_leaderboard_snapshots
        WHERE race_type::text = $1 AND period_start = $2
        ORDER BY period_end DESC
        LIMIT 1`,
      raceType,
      periodStartDate,
    ),
    queryMainRows<
      { ends_at: Date | string; status: string; claims_frozen: boolean }[]
    >(
      `SELECT ends_at, status::text AS status, claims_frozen
         FROM race_periods
        WHERE race_type::text = $1
          AND starts_at >= $2
          AND starts_at < $3
        ORDER BY created_at DESC
        LIMIT 1`,
      raceType,
      periodStartDate,
      nextDay,
    ),
    getRewardExpiry().then(
      (e) => e.race_days as number,
      () => null as number | null,
    ),
  ]);
  const snapshot = snapshotRows[0] ?? null;
  const racePeriod = racePeriodRows[0] ?? null;

  const periodEnd =
    snapshot?.period_end ??
    (racePeriod?.status === "ended" || racePeriod?.status === "active"
      ? racePeriod.ends_at
      : null);

  return computeRaceClaimWindow({
    periodEndIso: periodEnd?.toISOString() ?? null,
    raceExpiryDays: expiryResult,
    claimsFrozen: racePeriod?.claims_frozen ?? false,
  });
}

async function getAllTimeLeaderboard(params: {
  search?: string;
  page?: number;
  perPage?: number;
}): Promise<PaginatedResult<RaceLeaderboardEntry>> {
  const { search, page = 1, perPage = 20 } = params;
  const safePage = Math.max(1, Math.floor(page));
  const safePerPage = Math.max(1, Math.min(200, Math.floor(perPage)));
  const offset = (safePage - 1) * safePerPage;
  const searchFilter = search ? `%${search}%` : null;

  const [rows, countResult] = await Promise.all([
    queryMainRows<
      { user_id: string; username: string | null; total_wagered: number }[]
    >(
      `
      -- All-time wagered MUST come from balances.total_wagered (the user's
      -- true lifetime figure, same source the user-detail page shows), NOT
      -- from SUM(race_leaderboard_snapshots.wagered_usd). Snapshots are one
      -- row per (user, race_type, period), and daily/weekly/monthly periods
      -- OVERLAP — the same wager is recorded in each race type — so summing
      -- across them multiplied the total (e.g. 2x). Membership is still the
      -- set of race participants (distinct snapshot users).
      SELECT
        s.user_id,
        u.username,
        COALESCE(b.total_wagered, 0)::float AS total_wagered
      FROM (SELECT DISTINCT user_id FROM race_leaderboard_snapshots) s
      LEFT JOIN "user" u ON u.id = s.user_id
      LEFT JOIN balances b ON b.user_id = s.user_id
      WHERE ($1::text IS NULL OR u.username ILIKE $1 OR u.email ILIKE $1 OR s.user_id = $2)
      ORDER BY total_wagered DESC
      LIMIT $3 OFFSET $4
    `,
      searchFilter,
      search ?? "",
      safePerPage,
      offset,
    ),
    queryMainRows<{ count: string }[]>(
      `
      SELECT COUNT(DISTINCT s.user_id) AS count
      FROM race_leaderboard_snapshots s
      LEFT JOIN "user" u ON u.id = s.user_id
      WHERE ($1::text IS NULL OR u.username ILIKE $1 OR u.email ILIKE $1 OR s.user_id = $2)
    `,
      searchFilter,
      search ?? "",
    ),
  ]);

  const total = Number(countResult[0]?.count ?? 0);

  const excludedSet = new Set(
    await getExcludedUserIds().catch(() => [] as string[]),
  );

  return {
    data: rows.map((r, i) => ({
      id: r.user_id,
      userId: r.user_id,
      username: r.username,
      position: offset + i + 1,
      wageredUsd: r.total_wagered,
      prizeAmountUsd: null,
      // All-time view spans every period, so per-period claim review state
      // (holds/claims) doesn't apply.
      hold: null,
      claimedAt: null,
      excluded: excludedSet.has(r.user_id),
    })),
    total,
    page: safePage,
    perPage: safePerPage,
    totalPages: Math.ceil(total / safePerPage),
  };
}
