import { unstable_cache } from "next/cache";
import { drizzleForEnv } from "@/lib/db";
import { queryMainRows, queryRows } from "@/lib/drizzle-query";
import { readDbEnv } from "@/lib/db-env";
import { safeQuery } from "@/lib/errors/safe-query";
import { toNumber } from "@/lib/utils/decimal";
import { isUuid } from "@/lib/utils/ids";
import type { PaginatedResult } from "@/lib/types";
import { battle_status, battle_mode } from "@/lib/db-schema/main/schema";

// Allowlists from the generated Drizzle enums — validate user-supplied
// filter values before they hit the query rather than blind-casting.
const BATTLE_STATUSES = new Set<string>(battle_status.enumValues);
const BATTLE_MODES = new Set<string>(battle_mode.enumValues);

export type BattleListItem = {
  id: string;
  userId: string;
  username: string | null;
  mode: string;
  teams: number;
  playersPerTeam: number;
  status: string;
  betAmount: number;
  winnerTeam: number | null;
  regionCode: string;
  createdAt: string;
  totalPayout: number | null;
  houseEdge: number | null;
  /**
   * % of every participant's bet that the house fronted. 0 = fully
   * cash-paid. Surfaced on the battles list so admins can spot
   * borrowed battles at a glance, same convention as the detail
   * page's Borrow row.
   */
  borrowPercentage: number;
  /**
   * % of the pack that was sponsored by another user. 0 = no
   * sponsorship. Bundled here for the same reason — admins want a
   * full at-a-glance picture of how the bet was funded without
   * opening the detail page.
   */
  sponsorshipPercentage: number;
  /**
   * USD value the house fronted across the whole battle (sum across
   * all participants). `betAmount × playersTotal × borrow% / 100`.
   * Pre-computed so the badge's tooltip can show a real $ number
   * instead of forcing the admin to multiply.
   */
  borrowedAmountUsd: number;
  /**
   * Total card value paid out across the WHOLE battle (winner takes
   * all, but this is the sum across every PF result regardless of
   * which team won — i.e. the actual size of the hit). Used as the
   * sort key for the "Biggest Hit" filter and surfaced as a column
   * so admins can scan for high-value battles. Null for non-completed
   * battles (no payout yet).
   */
  totalPotUsd: number | null;
  /**
   * Winner's payout multiplier: `totalPotUsd / betAmount`. Per-player
   * POV — what the winner walked away with vs what they personally
   * paid in. A $100 buy-in that hit $10,000 = 100×, regardless of
   * how many teams. This is the primary signal for the "Biggest Hit"
   * sort (admins specifically want multiplier-driven ranking — a $100
   * → $10k hit beats a $5k → $40k hit even though the absolute pot is
   * smaller). Null for non-completed battles or zero-bet edge cases.
   */
  hitMultiplier: number | null;
  /**
   * True when this row is a PENDING battle (`in_progress` / `animating`)
   * whose outcome is already materialized in the DB — i.e. `winner_team`
   * and `total_unpacked` are populated even though the on-site animation
   * hasn't settled and the provably_fair_results rows aren't written yet.
   * For these rows `totalPotUsd` / `houseEdge` / `hitMultiplier` / payout
   * are sourced from `total_unpacked` (the PF-sum path is empty while
   * animating). Lets the UI flag the row as "outcome locked / settling"
   * vs a true no-outcome-yet row. Always false for completed / waiting /
   * cancelled battles.
   */
  outcomeLocked: boolean;
};

/**
 * Sort modes for the /battles list. `recent` = newest first (default
 * site-wide behaviour). `bet` = highest single-player buy-in first
 * (proxy for "expensive battles" — combined with the Teams column an
 * admin can read off the total pot). `hit` = biggest WIN MULTIPLIER
 * first (`totalCardValue / bet_amount`, per-player POV); forces
 * status=completed so unfinished battles don't pollute the leaderboard.
 *
 * The hit sort is intentionally multiplier-based rather than absolute-
 * pot-based: admins want to surface lucky low-bet hits ($100 → $10k =
 * 100×) over fat-pot grinds ($5k → $40k = 8×). Switching this back to
 * absolute pot would bury the most viral hits in the noise.
 */
export type BattleSortMode = "recent" | "bet" | "hit";

/**
 * Caps the row count we pull into memory for the biggest-hit sort.
 * The pre-cap is done in SQL via a CTE that computes the multiplier
 * for every completed battle (with a COALESCE fallback to cards.price
 * for cards that were sold/exchanged out of inventory) and returns
 * the top N by multiplier DESC. This is the ONLY way to catch
 * low-bet huge-multiplier hits (e.g. $1 → $1000 = 1000×) without
 * loading every battle into memory. Tuned for: page-of-20 × 25
 * pages of headroom.
 */
const BIGGEST_HIT_CAP = 500;

export async function getBattles(params: {
  page?: number;
  perPage?: number;
  status?: string;
  mode?: string;
  search?: string;
  /**
   * Sort mode. Default `recent` (newest first). `bet` orders by
   * `bet_amount DESC` (highest single buy-in first). `hit` forces
   * status=completed and orders by total payout via in-memory sort
   * over a `BIGGEST_HIT_CAP`-sized window.
   */
  sortBy?: BattleSortMode;
  /**
   * Optional time-window filter. Currently only `24h` is supported —
   * narrows the result set to battles created in the last 24 hours.
   * Composes with `sortBy` (e.g. `sortBy=hit, since=24h` = biggest
   * hits today).
   */
  since?: "24h";
}): Promise<PaginatedResult<BattleListItem>> {
  const { page = 1, perPage = 20, status, mode, search, sortBy = "recent", since } = params;
  const safePage = Math.max(1, Math.floor(page));
  const safePerPage = Math.max(1, Math.min(200, Math.floor(perPage)));
  const binds: unknown[] = [];
  const filters: string[] = [];

  if (status && status !== "all" && BATTLE_STATUSES.has(status)) {
    binds.push(status);
    filters.push(`b.status::text = $${binds.length}`);
  }

  if (mode && mode !== "all" && BATTLE_MODES.has(mode)) {
    binds.push(mode);
    filters.push(`b.mode::text = $${binds.length}`);
  }

  if (search) {
    // `battles.id` is a Postgres `@db.Uuid` column — feeding a non-UUID
    // search term (e.g. a username, the documented use) into an id-equality
    // leg makes Postgres throw `22P02 invalid input syntax for type uuid`,
    // which `safeQuery` degrades to the "Couldn't load the battles list"
    // band, so username search never returns results. Only include the id
    // leg when the term is actually UUID-shaped; otherwise search username
    // only. Mirrors the `isUuid` guard in rain.ts / transactions.ts.
    binds.push(`%${search.toLowerCase()}%`);
    const usernameBind = `$${binds.length}`;
    if (isUuid(search)) {
      binds.push(search);
      filters.push(
        `(LOWER(u.username) LIKE ${usernameBind} OR b.id = $${binds.length}::uuid)`,
      );
    } else {
      filters.push(`LOWER(u.username) LIKE ${usernameBind}`);
    }
  }

  // Time-window filter — applied additively so it composes cleanly with
  // the status/mode/search filters above. 24h is the only supported
  // window for now; expand here if we ever need 7d/30d.
  if (since === "24h") {
    binds.push(new Date(Date.now() - 24 * 60 * 60 * 1000));
    filters.push(`b.created_at >= $${binds.length}`);
  }
  const whereSql = filters.length > 0 ? filters.join(" AND ") : "TRUE";

  // "Biggest hit" only makes sense for battles that finished — pending
  // / cancelled rows have no payout. The dedicated SQL path below
  // (sortBy === "hit") forces status = 'completed' directly in the
  // CTE, so we don't need to touch `where.status` for that case.
  // Non-hit sorts respect the user's status tab as-is.

  // Pagination strategy diverges by sort mode:
  //   - recent / bet → standard DB-side skip/take, count() for total
  //   - hit → two-stage: SQL CTE picks the top `BIGGEST_HIT_CAP`
  //     battle IDs by computed multiplier, then a bounded detail read
  //     loads full data for those IDs. We re-order to match the SQL
  //     result, project, then slice for the page. `total` is clamped
  //     to the cap so the pagination UI doesn't offer pages we
  //     can't render.

  type ListBattle = {
    id: string;
    user_id: string;
    username: string | null;
    mode: string;
    teams: number;
    players_per_team: number;
    status: string;
    bet_amount: string;
    winner_team: number | null;
    region_code: string;
    created_at: Date;
    borrow_percentage: number | null;
    sponsorship_percentage: number | null;
    total_unpacked: string | null;
    user: { username: string | null } | null;
    battle_participants: {
      id: string;
      user_id: string;
      team_number: number;
      game_sessions: {
        provably_fair_results: {
          result_metadata: unknown;
          user_inventory: { value_at_obtained: string } | null;
        }[];
      };
    }[];
  };
  let battles: ListBattle[];
  let total: number;

  async function hydrateBattles(
    baseRows: Omit<ListBattle, "user" | "battle_participants">[],
  ): Promise<ListBattle[]> {
    if (baseRows.length === 0) return [];
    const ids = baseRows.map((battle) => battle.id);
    const participantRows = await queryMainRows<
      {
        battle_id: string;
        participant_id: string;
        user_id: string;
        team_number: number;
        result_metadata: unknown;
        value_at_obtained: string | null;
        pf_id: string | null;
      }[]
    >(
      `SELECT bp.battle_id, bp.id AS participant_id, bp.user_id,
              bp.team_number, pf.id AS pf_id, pf.result_metadata,
              ui.value_at_obtained::text
         FROM battle_participants bp
         LEFT JOIN game_sessions gs ON gs.id = bp.game_session_id
         LEFT JOIN provably_fair_results pf ON pf.game_session_id = gs.id
         LEFT JOIN user_inventory ui ON ui.id = pf.inventory_item_id
        WHERE bp.battle_id = ANY($1::uuid[])
        ORDER BY bp.battle_id, bp.team_number, bp.team_position, pf.nonce`,
      ids,
    );
    const byBattle = new Map<string, ListBattle["battle_participants"]>();
    const byParticipant = new Map<
      string,
      ListBattle["battle_participants"][number]
    >();
    for (const row of participantRows) {
      let participant = byParticipant.get(row.participant_id);
      if (!participant) {
        participant = {
          id: row.participant_id,
          user_id: row.user_id,
          team_number: row.team_number,
          game_sessions: { provably_fair_results: [] },
        };
        byParticipant.set(row.participant_id, participant);
        const list = byBattle.get(row.battle_id) ?? [];
        list.push(participant);
        byBattle.set(row.battle_id, list);
      }
      if (row.pf_id) {
        participant.game_sessions.provably_fair_results.push({
          result_metadata: row.result_metadata,
          user_inventory:
            row.value_at_obtained == null
              ? null
              : { value_at_obtained: row.value_at_obtained },
        });
      }
    }
    return baseRows.map((battle) => ({
      ...battle,
      user: { username: battle.username },
      battle_participants: byBattle.get(battle.id) ?? [],
    }));
  }

  async function loadBaseBattles(
    filter: string,
    order: string,
    values: readonly unknown[],
    limit: number,
    offset: number,
  ) {
    return queryMainRows<
      Omit<ListBattle, "user" | "battle_participants">[]
    >(
      `SELECT b.id, b.user_id, u.username, b.mode::text AS mode, b.teams,
              b.players_per_team, b.status::text AS status,
              b.bet_amount::text, b.winner_team, b.region_code, b.created_at,
              b.borrow_percentage, b.sponsorship_percentage,
              b.total_unpacked::text
         FROM battles b
         LEFT JOIN "user" u ON u.id = b.user_id
        WHERE ${filter}
        ORDER BY ${order}
        LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      ...values,
      limit,
      offset,
    );
  }

  if (sortBy === "hit") {
    // ── Multiplier-based pre-cap (SQL) ───────────────────────────────
    //
    // Compute `total_card_value / bet_amount` for every completed
    // battle matching the time/mode filters, sort by multiplier DESC,
    // take top BIGGEST_HIT_CAP. Joins user_inventory for the post-
    // battle card values; falls back to cards.price (via the JSON
    // card_id in result_metadata) for cards that were sold/exchanged
    // out of inventory immediately after the win. Comparing via
    // c.id::text avoids a uuid-cast error on any non-uuid card_id
    // strings that might exist in legacy result_metadata.
    //
    // `mode_clause` and `since_clause` are inlined safely — both come
    // from a fixed allowlist (enum value + literal "24h"), not user
    // input that could carry SQL.
    // Reliability: this multiplier CTE scans every completed battle with a
    // 5-way join. It previously ran uncached AND untimed, so a cold run could
    // hang the whole /battles page (and a pg statement-timeout would crash it).
    // It is now cached per (env, mode, since) for 120s and bounded by a 15s
    // safeQuery timeout that degrades to an empty biggest-hit list instead of
    // blocking/crashing the page. Measured ~7.3s warm on prod; 15s gives a cold
    // run headroom to complete and populate the cache (then instant for 120s).
    // The durable fix is the recommended battle_participants(battle_id) +
    // provably_fair_results FK indexes (see prisma/recommended-indexes.sql),
    // which bring this well under a second.
    const env = await readDbEnv();
    const loadTopHitIds = unstable_cache(
      async (m: string | null, s: string | null): Promise<string[]> => {
        const cdb = drizzleForEnv(env);
        const modeClause = m && m !== "all" ? "AND b.mode::text = $1" : "";
        // 24h keeps its tight floor; every other mode (lifetime/all) is
        // capped at the 365d house convention (CLAUDE.md "Performance &
        // Daten-Laden") so this 5-way-join CTE always has a lower bound
        // instead of scanning the full battle history. No-op on current
        // data (< 90d old); bounds pathological future scans.
        const lookbackDays = s === "24h" ? 1 : 365;
        const dayBind = m && m !== "all" ? 2 : 1;
        const limitBind = dayBind + 1;
        const rows = await queryRows<{ id: string }[]>(
          cdb,
          `
          WITH battle_multipliers AS (
            SELECT
              b.id,
              b.bet_amount::numeric AS bet_amount,
              COALESCE(SUM(COALESCE(ui.value_at_obtained::numeric, c.price::numeric, 0)), 0) AS total_card_value
            FROM battles b
            LEFT JOIN battle_participants bp ON bp.battle_id = b.id
            LEFT JOIN game_sessions gs ON gs.id = bp.game_session_id
            LEFT JOIN provably_fair_results pf ON pf.game_session_id = gs.id
            LEFT JOIN user_inventory ui ON ui.id = pf.inventory_item_id
            LEFT JOIN cards c ON c.id::text = pf.result_metadata->>'card_id'
            WHERE b.status = 'completed'
              AND b.bet_amount::numeric > 0
              ${modeClause}
              AND b.created_at >= NOW() - make_interval(days => $${dayBind}::int)
            GROUP BY b.id, b.bet_amount
          )
          SELECT id::text AS id
          FROM battle_multipliers
          WHERE total_card_value > 0
          ORDER BY (total_card_value / bet_amount) DESC NULLS LAST
          LIMIT $${limitBind}
          `,
          ...(m && m !== "all" ? [m] : []),
          lookbackDays,
          BIGGEST_HIT_CAP,
        );
        return rows.map((r) => r.id);
      },
      ["battles-biggest-hit-ids-v1", env],
      { revalidate: 120, tags: ["battles-biggest-hit"] },
    );

    const topIdsResult = await safeQuery(
      () => loadTopHitIds(mode ?? null, since ?? null),
      [] as string[],
      "battles.biggestHitIds",
      15_000,
    );
    const topIds = topIdsResult.data;

    // Fetch full data for the pre-capped IDs and rebuild order. The
    // search filter is applied here (rather than in the SQL CTE) so
    // admins combining search with sort=hit still get accurate top-
    // multiplier results that match their query — at the cost of
    // potentially fewer than perPage rows when the search is narrow.
    const hitValues: unknown[] = [topIds];
    const hitFilters = [`b.id = ANY($1::uuid[])`];
    if (search) {
      hitValues.push(`%${search.toLowerCase()}%`);
      const usernameBind = `$${hitValues.length}`;
      if (isUuid(search)) {
        hitValues.push(search);
        hitFilters.push(
          `(LOWER(u.username) LIKE ${usernameBind} OR b.id = $${hitValues.length}::uuid)`,
        );
      } else {
        hitFilters.push(`LOWER(u.username) LIKE ${usernameBind}`);
      }
    }
    const found =
      topIds.length === 0
        ? []
        : await loadBaseBattles(
            hitFilters.join(" AND "),
            "array_position($1::uuid[], b.id)",
            hitValues,
            BIGGEST_HIT_CAP,
            0,
          );
    battles = await hydrateBattles(found);
    total = battles.length;
  } else {
    const [baseRows, countRows] = await Promise.all([
      loadBaseBattles(
        whereSql,
        sortBy === "bet" ? "b.bet_amount DESC" : "b.created_at DESC",
        binds,
        safePerPage,
        (safePage - 1) * safePerPage,
      ),
      queryMainRows<{ total: string }[]>(
        `SELECT COUNT(*)::text AS total
           FROM battles b LEFT JOIN "user" u ON u.id = b.user_id
          WHERE ${whereSql}`,
        ...binds,
      ),
    ]);
    battles = await hydrateBattles(baseRows);
    total = Number(countRows[0]?.total ?? 0);
  }

  // Collect ALL card IDs from result_metadata across all battles for price lookup
  // This mirrors the detail page logic: use user_inventory.value_at_obtained if available,
  // otherwise fall back to card.price (needed for cards that aren't in winner's inventory)
  const allCardIds = new Set<string>();
  for (const b of battles) {
    for (const p of b.battle_participants) {
      for (const pf of p.game_sessions.provably_fair_results) {
        const meta = pf.result_metadata as Record<string, unknown> | null;
        if (meta?.card_id) allCardIds.add(meta.card_id as string);
      }
    }
  }
  const cardPriceMap = new Map<string, number>();
  if (allCardIds.size > 0) {
    const cards = await queryMainRows<{ id: string; price: string }[]>(
      `SELECT id, price::text FROM cards WHERE id = ANY($1::uuid[])`,
      [...allCardIds],
    );
    for (const c of cards) cardPriceMap.set(c.id, toNumber(c.price));
  }

  const projected: BattleListItem[] = battles.map((b) => {
    const betAmount = toNumber(b.bet_amount);
    const totalPlayers = b.battle_participants.length;
    const totalWagered = betAmount * totalPlayers;

    // Flatten all PF results across all participants (same as detail page)
    // then sum card values using user_inventory if available, else card.price
    const allPfResults = b.battle_participants.flatMap(
      (p) => p.game_sessions.provably_fair_results
    );

    function pfValue(pf: typeof allPfResults[number]) {
      if (pf.user_inventory) return toNumber(pf.user_inventory.value_at_obtained);
      const meta = pf.result_metadata as Record<string, unknown> | null;
      const cardId = meta?.card_id as string | undefined;
      return cardId ? (cardPriceMap.get(cardId) ?? 0) : 0;
    }

    // Global payout (all cards) for house edge AND for the biggest-hit
    // sort. This is the size of the actual hit — winner takes all, so
    // this is what got paid out.
    const totalCardValue = allPfResults.reduce((s, pf) => s + pfValue(pf), 0);
    const houseEdge = totalWagered > 0 ? ((totalWagered - totalCardValue) / totalWagered) * 100 : null;

    // Creator's payout: winner takes all cards, loser gets nothing
    const creatorTeam = b.battle_participants.find((p) => p.user_id === b.user_id)?.team_number;
    const creatorWon = creatorTeam != null && creatorTeam === b.winner_team;
    const creatorPayout = creatorWon ? totalCardValue : 0;

    // Borrow exposure for this battle: every participant pays
    // bet_amount, of which borrow% comes from the house. Total
    // fronted USD is bet × N players × borrow%.
    const borrowPct = b.borrow_percentage ?? 0;
    const borrowedAmountUsd =
      borrowPct > 0 ? totalWagered * (borrowPct / 100) : 0;

    // Hit multiplier from the winner's POV — what they got back vs
    // their own bet (not the total wagered across all players).
    // Matches the user's mental model: "I paid 100, won 10000 = 100×".
    const hitMultiplier =
      betAmount > 0 ? totalCardValue / betAmount : 0;

    // ── Pre-resolved (pending) outcome ───────────────────────────────
    // While a battle is `in_progress` / `animating` the provably_fair_
    // results rows aren't written yet, so the PF-sum path above yields 0.
    // But `winner_team` + `total_unpacked` are ALREADY populated in the
    // DB (the outcome is materialized before the on-site animation
    // settles). So for pending rows we source the Hit from
    // `total_unpacked` — the same number that equals the settled PF-sum
    // on completed battles — and compute the house edge / multiplier /
    // creator payout off it. `outcomeLocked` flags these so the UI can
    // mark them "settling" instead of showing "—".
    const isPending = b.status === "in_progress" || b.status === "animating";
    const pendingHit =
      isPending && b.total_unpacked != null ? toNumber(b.total_unpacked) : null;
    const outcomeLocked = isPending && pendingHit != null;
    const pendingHouseEdge =
      totalWagered > 0 && pendingHit != null
        ? ((totalWagered - pendingHit) / totalWagered) * 100
        : null;
    const pendingHitMultiplier =
      betAmount > 0 && pendingHit != null ? pendingHit / betAmount : null;
    // Creator payout for pending uses the SAME winner_team logic — it's
    // set while animating, so `creatorWon` is already correct above.
    const pendingCreatorPayout = creatorWon ? pendingHit : 0;

    return {
      id: b.id,
      userId: b.user_id,
      username: b.user?.username ?? null,
      mode: b.mode,
      teams: b.teams,
      playersPerTeam: b.players_per_team,
      status: b.status,
      betAmount,
      winnerTeam: b.winner_team,
      regionCode: b.region_code,
      createdAt: b.created_at.toISOString(),
      totalPayout: b.status === "completed"
        ? creatorPayout
        : outcomeLocked
          ? pendingCreatorPayout
          : null,
      houseEdge: b.status === "completed"
        ? houseEdge
        : outcomeLocked
          ? pendingHouseEdge
          : null,
      borrowPercentage: borrowPct,
      sponsorshipPercentage: b.sponsorship_percentage ?? 0,
      borrowedAmountUsd,
      // Total pot = sum of all cards regardless of who won. Set for
      // completed battles (PF-sum) and pre-resolved pending battles
      // (from total_unpacked); null for waiting/cancelled (no outcome).
      totalPotUsd: b.status === "completed"
        ? totalCardValue
        : outcomeLocked
          ? pendingHit
          : null,
      hitMultiplier: b.status === "completed"
        ? hitMultiplier
        : outcomeLocked
          ? pendingHitMultiplier
          : null,
      outcomeLocked,
    };
  });

  // For the biggest-hit sort the SQL CTE already returned the top
  // BIGGEST_HIT_CAP battles by multiplier and `battles` is in that
  // order; here we just slice the requested page. We don't re-sort
  // in JS — the JS-side multiplier should match the SQL one (same
  // COALESCE rule), and small drift from sold cards is acceptable.
  if (sortBy === "hit") {
    const sliceStart = (safePage - 1) * safePerPage;
    return {
      data: projected.slice(sliceStart, sliceStart + safePerPage),
      total,
      page: safePage,
      perPage: safePerPage,
      totalPages: Math.ceil(total / safePerPage),
    };
  }

  return {
    data: projected,
    total,
    page: safePage,
    perPage: safePerPage,
    totalPages: Math.ceil(total / safePerPage),
  };
}

export async function getBattleDetail(id: string) {
  type DetailPf = {
    id: string;
    result_metadata: unknown;
    user_inventory: {
      id: string;
      card_id: string;
      value_at_obtained: string;
    } | null;
  };
  type DetailParticipant = {
    id: string;
    user_id: string;
    team_number: number;
    team_position: number;
    client_seed: string;
    user: { username: string | null } | null;
    bots: { username: string | null } | null;
    game_sessions: {
      result: unknown;
      bet_amount: string;
      provably_fair_results: DetailPf[];
    };
  };
  const [battleRows, participantRows, proofRows] = await Promise.all([
    queryMainRows<
      {
        id: string;
        user_id: string;
        username: string | null;
        mode: string;
        teams: number;
        players_per_team: number;
        status: string;
        bet_amount: string;
        winner_team: number | null;
        total_unpacked: string | null;
        pack_ids: string[];
        region_code: string;
        created_at: Date;
        borrow_percentage: number | null;
        sponsorship_percentage: number | null;
        server_seed_hash: string;
        eos_block_hash: string | null;
        password: string | null;
      }[]
    >(
      `SELECT b.id, b.user_id, u.username, b.mode::text AS mode, b.teams,
              b.players_per_team, b.status::text AS status, b.bet_amount::text,
              b.winner_team, b.total_unpacked::text, b.pack_ids, b.region_code,
              b.created_at, b.borrow_percentage, b.sponsorship_percentage
              , b.server_seed_hash, b.eos_block_hash, b.password
         FROM battles b LEFT JOIN "user" u ON u.id = b.user_id
        WHERE b.id = $1::uuid LIMIT 1`,
      id,
    ),
    queryMainRows<
      {
        participant_id: string;
        user_id: string;
        team_number: number;
        team_position: number;
        client_seed: string;
        username: string | null;
        bot_username: string | null;
        result: unknown;
        bet_amount: string;
        pf_id: string | null;
        result_metadata: unknown;
        inventory_id: string | null;
        card_id: string | null;
        value_at_obtained: string | null;
      }[]
    >(
      `SELECT bp.id AS participant_id, bp.user_id, bp.team_number,
              bp.team_position, bp.client_seed, u.username,
              bot.username AS bot_username, gs.result, gs.bet_amount::text,
              pf.id AS pf_id, pf.result_metadata, ui.id AS inventory_id,
              ui.card_id, ui.value_at_obtained::text
         FROM battle_participants bp
         LEFT JOIN "user" u ON u.id = bp.user_id
         LEFT JOIN bots bot ON bot.id = bp.bot_id
         LEFT JOIN game_sessions gs ON gs.id = bp.game_session_id
         LEFT JOIN provably_fair_results pf ON pf.game_session_id = gs.id
         LEFT JOIN user_inventory ui ON ui.id = pf.inventory_item_id
        WHERE bp.battle_id = $1::uuid
        ORDER BY bp.team_number, bp.team_position, pf.nonce`,
      id,
    ),
    queryMainRows<
      {
        id: string;
        client_seed: string;
        server_seed_hash: string;
        server_seed: string | null;
        nonce: number;
        ticket: number;
        result_hash: string;
        result_metadata: unknown;
      }[]
    >(
      `SELECT id, client_seed, server_seed_hash, server_seed, nonce,
              ticket, result_hash, result_metadata
         FROM provably_fair_results
        WHERE battle_id = $1::uuid ORDER BY created_at ASC`,
      id,
    ),
  ]);
  const baseBattle = battleRows[0];
  const participantMap = new Map<string, DetailParticipant>();
  for (const row of participantRows) {
    let participant = participantMap.get(row.participant_id);
    if (!participant) {
      participant = {
        id: row.participant_id,
        user_id: row.user_id,
        team_number: row.team_number,
        team_position: row.team_position,
        client_seed: row.client_seed,
        user: { username: row.username },
        bots: row.bot_username == null ? null : { username: row.bot_username },
        game_sessions: {
          result: row.result,
          bet_amount: row.bet_amount,
          provably_fair_results: [],
        },
      };
      participantMap.set(row.participant_id, participant);
    }
    if (row.pf_id) {
      participant.game_sessions.provably_fair_results.push({
        id: row.pf_id,
        result_metadata: row.result_metadata,
        user_inventory:
          row.inventory_id && row.card_id && row.value_at_obtained != null
            ? {
                id: row.inventory_id,
                card_id: row.card_id,
                value_at_obtained: row.value_at_obtained,
              }
            : null,
      });
    }
  }
  const battle = baseBattle
    ? {
        ...baseBattle,
        user: { username: baseBattle.username },
        battle_participants: [...participantMap.values()],
        provably_fair_results: proofRows,
      }
    : null;

  if (!battle) return null;

  // Collect all provably_fair_results and extract card IDs
  type CardEntry = {
    id: string;
    cardName: string;
    imageUrl: string | null;
    rarity: string | null;
    valueAtObtained: number;
  };

  const allPfResults = battle.battle_participants.flatMap((p) =>
    p.game_sessions.provably_fair_results,
  );

  const cardIds = new Set<string>();
  for (const r of allPfResults) {
    if (r.user_inventory) {
      cardIds.add(r.user_inventory.card_id);
    }
    const meta = r.result_metadata as Record<string, unknown> | null;
    if (meta?.card_id) {
      cardIds.add(meta.card_id as string);
    }
  }

  // Fetch packs and cards in parallel — they're independent lookups.
  const [packs, cards] = await Promise.all([
    battle.pack_ids.length > 0
      ? queryMainRows<
          { id: string; name: string; image_url: string | null; price: string }[]
        >(
          `SELECT id, name, image_url, price::text
             FROM packs WHERE id = ANY($1::uuid[])`,
          battle.pack_ids,
        )
      : Promise.resolve([] as Array<{ id: string; name: string; image_url: string | null; price: unknown }>),
    cardIds.size > 0
      ? queryMainRows<
          {
            id: string;
            name: string;
            image_url: string | null;
            rarity: string | null;
            price: string;
          }[]
        >(
          `SELECT id, name, image_url, rarity::text, price::text
             FROM cards WHERE id = ANY($1::uuid[])`,
          [...cardIds],
        )
      : Promise.resolve([] as Array<{ id: string; name: string; image_url: string | null; rarity: string | null; price: unknown }>),
  ]);
  const cardMap = new Map(cards.map((c) => [c.id, c]));

  // Distribute cards by participant_id from result_metadata
  // All PF results may be on the winner's game_session, but metadata.participant_id
  // tells us who originally pulled each card
  const cardsByParticipantId = new Map<string, CardEntry[]>();
  const assignedPfResultIds = new Set<string>();

  for (const r of allPfResults) {
    const meta = r.result_metadata as Record<string, unknown> | null;
    const metaCardId = meta?.card_id as string | undefined;
    const participantId = meta?.participant_id as string | undefined;

    if (!metaCardId || !participantId) continue;

    const card = cardMap.get(metaCardId);
    const entry: CardEntry = {
      id: r.user_inventory?.id ?? r.id,
      cardName: card?.name ?? "Unknown",
      imageUrl: card?.image_url ?? null,
      rarity: card?.rarity ?? null,
      valueAtObtained: r.user_inventory
        ? toNumber(r.user_inventory.value_at_obtained)
        : toNumber(card?.price ?? 0),
    };

    const existing = cardsByParticipantId.get(participantId) ?? [];
    existing.push(entry);
    cardsByParticipantId.set(participantId, existing);
    assignedPfResultIds.add(r.id);
  }

  // Fallback: supplement any participant missing cards from their game_session inventory
  // (handles PF results with no participant_id in metadata, even if they already have some cards)
  for (const p of battle.battle_participants) {
    const existing = cardsByParticipantId.get(p.id) ?? [];
    for (const r of p.game_sessions.provably_fair_results) {
      if (assignedPfResultIds.has(r.id)) continue;
      if (!r.user_inventory) continue;
      const card = cardMap.get(r.user_inventory.card_id);
      existing.push({
        id: r.user_inventory.id,
        cardName: card?.name ?? "Unknown",
        imageUrl: card?.image_url ?? null,
        rarity: card?.rarity ?? null,
        valueAtObtained: toNumber(r.user_inventory.value_at_obtained),
      });
      assignedPfResultIds.add(r.id);
    }
    if (existing.length > 0) {
      cardsByParticipantId.set(p.id, existing);
    }
  }

  // Group participants by team
  const teamMap = new Map<number, typeof battle.battle_participants>();
  for (const p of battle.battle_participants) {
    const team = teamMap.get(p.team_number) ?? [];
    team.push(p);
    teamMap.set(p.team_number, team);
  }

  const teamsData = [...teamMap.entries()].map(([teamNumber, members]) => {
    const players = members.map((p) => {
      const gs = p.game_sessions;
      const playerCards = cardsByParticipantId.get(p.id) ?? [];
      const totalValue = playerCards.reduce((sum, c) => sum + c.valueAtObtained, 0);

      // Per-participant borrow — each joiner picks their own borrow %, so
      // it lives in that player's PF result metadata (same field solo
      // openings use). The battle-level borrow_percentage only reflects
      // the creator's setting and reads 0 when a joiner borrowed, which
      // is why the battle's single "Borrow" row could miss it.
      let borrowPercentage = 0;
      const firstPf = gs.provably_fair_results[0];
      if (firstPf) {
        const m = firstPf.result_metadata as Record<string, unknown> | null;
        const raw = m?.borrow_percentage;
        if (typeof raw === "number") borrowPercentage = raw;
        else if (typeof raw === "string") {
          const n = parseInt(raw, 10);
          if (Number.isFinite(n)) borrowPercentage = n;
        }
      }

      return {
        id: p.id,
        userId: p.user_id,
        username: p.user?.username ?? null,
        botUsername: p.bots?.username ?? null,
        teamPosition: p.team_position,
        result: gs.result,
        betAmount: toNumber(gs.bet_amount),
        cards: playerCards,
        totalValue,
        borrowPercentage,
      };
    });

    const teamTotalValue = players.reduce((sum, p) => sum + p.totalValue, 0);

    return {
      teamNumber,
      isWinner: battle.winner_team === teamNumber,
      players,
      teamTotalValue,
    };
  });

  return {
    id: battle.id,
    userId: battle.user_id,
    username: battle.user?.username ?? null,
    mode: battle.mode,
    teams: battle.teams,
    playersPerTeam: battle.players_per_team,
    status: battle.status,
    betAmount: toNumber(battle.bet_amount),
    winnerTeam: battle.winner_team,
    // Total card value paid out across the whole battle, materialized in
    // the DB the moment the outcome is determined — i.e. populated while
    // the battle is still `in_progress` / `animating`, BEFORE the
    // provably_fair_results rows (which `teamsData` derives from) exist.
    // The detail page uses this to surface the House P&L on a pending
    // battle, since the teamsData-derived total is 0 until PF rows land.
    // On completed battles it equals the teamsData sum (verified).
    totalUnpacked: battle.total_unpacked != null ? toNumber(battle.total_unpacked) : null,
    serverSeedHash: battle.server_seed_hash,
    eosBlockHash: battle.eos_block_hash,
    regionCode: battle.region_code,
    sponsorshipPercentage: battle.sponsorship_percentage,
    borrowPercentage: battle.borrow_percentage,
    // Boolean only — the actual password is never included in this
    // projection so it can't leak into the initial RSC payload of every
    // battle-detail page load. Admins fetch the plaintext on demand via
    // the revealBattlePassword server action, which audit-logs the view.
    hasPassword: battle.password !== null && battle.password.length > 0,
    createdAt: battle.created_at.toISOString(),
    packs: packs.map((p) => ({ id: p.id, name: p.name, imageUrl: p.image_url, priceUsd: toNumber(p.price) })),
    teamsData,
    participants: battle.battle_participants.map((p) => ({
      id: p.id,
      userId: p.user_id,
      username: p.user?.username ?? null,
      botUsername: p.bots?.username ?? null,
      teamNumber: p.team_number,
      teamPosition: p.team_position,
      clientSeed: p.client_seed,
    })),
    provablyFairResults: battle.provably_fair_results.map((r) => ({
      id: r.id,
      clientSeed: r.client_seed,
      serverSeedHash: r.server_seed_hash,
      serverSeed: r.server_seed,
      nonce: r.nonce,
      ticket: r.ticket,
      resultHash: r.result_hash,
      resultMetadata: r.result_metadata,
    })),
  };
}
