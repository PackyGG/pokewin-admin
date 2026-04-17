import { db } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import type { PaginatedResult } from "@/lib/types";
import { Prisma } from "@/generated/prisma/client";

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
};

export async function getBattles(params: {
  page?: number;
  perPage?: number;
  status?: string;
  mode?: string;
  search?: string;
}): Promise<PaginatedResult<BattleListItem>> {
  const { page = 1, perPage = 20, status, mode, search } = params;

  const where: Prisma.battlesWhereInput = {};

  if (status && status !== "all") {
    where.status = status as Prisma.Enumbattle_statusFieldUpdateOperationsInput["set"];
  }

  if (mode && mode !== "all") {
    where.mode = mode as Prisma.Enumbattle_modeFieldUpdateOperationsInput["set"];
  }

  if (search) {
    where.OR = [
      { id: search },
      { user: { username: { contains: search, mode: "insensitive" } } },
    ];
  }

  const [battles, total] = await Promise.all([
    db.battles.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
      include: {
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
      },
    }),
    db.battles.count({ where }),
  ]);

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

  return {
    data: battles.map((b) => {
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

      // Global payout (all cards) for house edge
      const totalCardValue = allPfResults.reduce((s, pf) => s + pfValue(pf), 0);
      const houseEdge = totalWagered > 0 ? ((totalWagered - totalCardValue) / totalWagered) * 100 : null;

      // Creator's payout: winner takes all cards, loser gets nothing
      const creatorTeam = b.battle_participants.find((p) => p.user_id === b.user_id)?.team_number;
      const creatorWon = creatorTeam != null && creatorTeam === b.winner_team;
      const creatorPayout = creatorWon ? totalCardValue : 0;

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
      };
    }),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}

export async function getBattleDetail(id: string) {
  const battle = await db.battles.findUnique({
    where: { id },
    include: {
      user: { select: { username: true } },
      battle_participants: {
        include: {
          user: { select: { username: true } },
          bots: { select: { username: true } },
          game_sessions: {
            include: {
              provably_fair_results: {
                include: {
                  user_inventory: true,
                },
                orderBy: { nonce: "asc" },
              },
            },
          },
        },
        orderBy: [{ team_number: "asc" }, { team_position: "asc" }],
      },
      provably_fair_results: {
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
