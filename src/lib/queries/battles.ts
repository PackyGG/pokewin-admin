import { unstable_cache } from "next/cache";
import { getDb, dbForEnv } from "@/lib/db";
import { readDbEnv } from "@/lib/db-env";
import { safeQuery } from "@/lib/errors/safe-query";
import { toNumber } from "@/lib/utils/decimal";
import type { PaginatedResult } from "@/lib/types";
import { Prisma } from "@/generated/prisma/client";
import { battle_status, battle_mode } from "@/generated/prisma/enums";

// Allowlists from the generated Prisma enums — validate user-supplied
// filter values before they hit the query rather than blind-casting.
const BATTLE_STATUSES = new Set<string>(Object.values(battle_status));
const BATTLE_MODES = new Set<string>(Object.values(battle_mode));

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
  const db = await getDb();

  const where: Prisma.battlesWhereInput = {};

  if (status && status !== "all" && BATTLE_STATUSES.has(status)) {
    where.status = status as battle_status;
  }

  if (mode && mode !== "all" && BATTLE_MODES.has(mode)) {
    where.mode = mode as battle_mode;
  }

  if (search) {
    where.OR = [
      { id: search },
      { user: { username: { contains: search, mode: "insensitive" } } },
    ];
  }

  // Time-window filter — applied additively so it composes cleanly with
  // the status/mode/search filters above. 24h is the only supported
  // window for now; expand here if we ever need 7d/30d.
  if (since === "24h") {
    where.created_at = { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) };
  }

  // "Biggest hit" only makes sense for battles that finished — pending
  // / cancelled rows have no payout. The dedicated SQL path below
  // (sortBy === "hit") forces status = 'completed' directly in the
  // CTE, so we don't need to touch `where.status` for that case.
  // Non-hit sorts respect the user's status tab as-is.

  // Prisma orderBy — only meaningful for recent / bet. The hit sort
  // is handled separately below via a SQL CTE that computes the
  // multiplier server-side, so the `orderBy` here is a no-op for it.
  const orderBy: Prisma.battlesOrderByWithRelationInput =
    sortBy === "bet" ? { bet_amount: "desc" } : { created_at: "desc" };

  // Pagination strategy diverges by sort mode:
  //   - recent / bet → standard DB-side skip/take, count() for total
  //   - hit → two-stage: SQL CTE picks the top `BIGGEST_HIT_CAP`
  //     battle IDs by computed multiplier, then Prisma findMany
  //     loads full data for those IDs. We re-order to match the SQL
  //     result, project, then slice for the page. `total` is clamped
  //     to the cap so the pagination UI doesn't offer pages we
  //     can't render.

  // SHARED include block — both paths read the same shape so the
  // projection logic below doesn't have to branch.
  const battleInclude = {
    user: { select: { username: true } },
    battle_participants: {
      select: {
        id: true,
        user_id: true,
        team_number: true,
        game_sessions: {
          select: {
            provably_fair_results: {
              select: {
                result_metadata: true,
                user_inventory: {
                  select: { value_at_obtained: true },
                },
              },
            },
          },
        },
      },
    },
  } as const;

  let battles: Awaited<ReturnType<typeof fetchBattles>>;
  let total: number;

  async function fetchBattles() {
    return db.battles.findMany({
      where,
      orderBy,
      skip: (page - 1) * perPage,
      take: perPage,
      include: battleInclude,
    });
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
        const cdb = dbForEnv(env);
        const modeClause =
          m && m !== "all"
            ? Prisma.sql`AND b.mode::text = ${m}`
            : Prisma.empty;
        // 24h keeps its tight floor; every other mode (lifetime/all) is
        // capped at the 365d house convention (CLAUDE.md "Performance &
        // Daten-Laden") so this 5-way-join CTE always has a lower bound
        // instead of scanning the full battle history. No-op on current
        // data (< 90d old); bounds pathological future scans.
        const sinceClause =
          s === "24h"
            ? Prisma.sql`AND b.created_at >= NOW() - INTERVAL '24 hours'`
            : Prisma.sql`AND b.created_at >= NOW() - INTERVAL '365 days'`;
        const rows = await cdb.$queryRaw<{ id: string }[]>`
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
              ${sinceClause}
            GROUP BY b.id, b.bet_amount
          )
          SELECT id::text AS id
          FROM battle_multipliers
          WHERE total_card_value > 0
          ORDER BY (total_card_value / bet_amount) DESC NULLS LAST
          LIMIT ${BIGGEST_HIT_CAP}
        `;
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
    const found = topIds.length === 0
      ? []
      : await db.battles.findMany({
          where: search
            ? {
                AND: [
                  { id: { in: topIds } },
                  {
                    OR: [
                      { id: search },
                      { user: { username: { contains: search, mode: "insensitive" } } },
                    ],
                  },
                ],
              }
            : { id: { in: topIds } },
          include: battleInclude,
        });
    const byId = new Map(found.map((b) => [b.id, b]));
    battles = topIds
      .map((id) => byId.get(id))
      .filter((b): b is NonNullable<typeof b> => b != null);
    total = battles.length;
  } else {
    [battles, total] = await Promise.all([
      fetchBattles(),
      db.battles.count({ where }),
    ]);
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
    const cards = await db.cards.findMany({
      where: { id: { in: [...allCardIds] } },
      select: { id: true, price: true },
    });
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
      totalPayout: b.status === "completed" ? creatorPayout : null,
      houseEdge: b.status === "completed" ? houseEdge : null,
      borrowPercentage: borrowPct,
      sponsorshipPercentage: b.sponsorship_percentage ?? 0,
      borrowedAmountUsd,
      // Total pot = sum of all cards regardless of who won. Only set
      // for completed battles (no payout exists for waiting/cancelled).
      totalPotUsd: b.status === "completed" ? totalCardValue : null,
      hitMultiplier: b.status === "completed" ? hitMultiplier : null,
    };
  });

  // For the biggest-hit sort the SQL CTE already returned the top
  // BIGGEST_HIT_CAP battles by multiplier and `battles` is in that
  // order; here we just slice the requested page. We don't re-sort
  // in JS — the JS-side multiplier should match the SQL one (same
  // COALESCE rule), and small drift from sold cards is acceptable.
  if (sortBy === "hit") {
    const sliceStart = (page - 1) * perPage;
    return {
      data: projected.slice(sliceStart, sliceStart + perPage),
      total,
      page,
      perPage,
      totalPages: Math.ceil(total / perPage),
    };
  }

  return {
    data: projected,
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}

export async function getBattleDetail(id: string) {
  const db = await getDb();
  // Narrow `user_inventory` and `game_sessions` to only the columns the
  // page actually consumes — `user_inventory` is a wide table (mints,
  // metadata, listing data, etc.) that we only need 3 fields off of.
  const battle = await db.battles.findUnique({
    where: { id },
    include: {
      user: { select: { username: true } },
      battle_participants: {
        select: {
          id: true,
          user_id: true,
          team_number: true,
          team_position: true,
          client_seed: true,
          user: { select: { username: true } },
          bots: { select: { username: true } },
          game_sessions: {
            select: {
              result: true,
              bet_amount: true,
              provably_fair_results: {
                select: {
                  id: true,
                  result_metadata: true,
                  user_inventory: {
                    select: {
                      id: true,
                      card_id: true,
                      value_at_obtained: true,
                    },
                  },
                },
                orderBy: { nonce: "asc" },
              },
            },
          },
        },
        orderBy: [{ team_number: "asc" }, { team_position: "asc" }],
      },
      provably_fair_results: {
        select: {
          id: true,
          client_seed: true,
          server_seed_hash: true,
          server_seed: true,
          nonce: true,
          ticket: true,
          result_hash: true,
          result_metadata: true,
        },
        orderBy: { created_at: "asc" },
      },
    },
  });

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
      ? db.packs.findMany({
          where: { id: { in: battle.pack_ids } },
          select: { id: true, name: true, image_url: true, price: true },
        })
      : Promise.resolve([] as Array<{ id: string; name: string; image_url: string | null; price: unknown }>),
    cardIds.size > 0
      ? db.cards.findMany({
          where: { id: { in: [...cardIds] } },
          select: { id: true, name: true, image_url: true, rarity: true, price: true },
        })
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
