import { getDb } from "@/lib/db";
import type { PaginatedResult } from "@/lib/types";
import { toNumber } from "@/lib/utils/decimal";

type RafflePrize = { type: "pack" | "card"; id: string; quantity?: number };
export type EnrichedPrize = RafflePrize & {
  name: string | null;
  imageUrl: string | null;
  priceUsd: number | null;
};

export type RaffleListItem = {
  id: string;
  name: string;
  status: string;
  totalEntries: number;
  participantCount: number;
  winnerUsername: string | null;
  startsAt: string;
  endsAt: string;
  createdAt: string;
};

export type RaffleEntryItem = {
  id: string;
  userId: string;
  username: string | null;
  pointsSpent: number;
  createdAt: string;
};

export async function getRaffles(params: {
  page?: number;
  perPage?: number;
  status?: string;
  search?: string;
}): Promise<PaginatedResult<RaffleListItem>> {
  const db = await getDb();
  const { page = 1, perPage = 20, status, search } = params;

  const where: Record<string, unknown> = {};
  if (status && status !== "all") {
    where.status = status;
  }
  if (search) {
    where.name = { contains: search, mode: "insensitive" };
  }

  // List view doesn't need the heavy JSON columns (description, prizes,
  // metadata) — those are only loaded on the detail page. Skipping them
  // keeps the wire payload small even when raffles have large prize
  // configurations.
  const [raffles, total] = await Promise.all([
    db.raffles.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
      select: {
        id: true,
        name: true,
        status: true,
        total_entries: true,
        participant_count: true,
        starts_at: true,
        ends_at: true,
        created_at: true,
        user: { select: { username: true } },
      },
    }),
    db.raffles.count({ where }),
  ]);

  return {
    data: raffles.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      totalEntries: r.total_entries,
      participantCount: r.participant_count,
      winnerUsername: r.user?.username ?? null,
      startsAt: r.starts_at.toISOString(),
      endsAt: r.ends_at.toISOString(),
      createdAt: r.created_at.toISOString(),
    })),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}

export async function getRaffleDetail(id: string, params?: { page?: number; perPage?: number }) {
  const db = await getDb();
  const entriesPage = params?.page ?? 1;
  const entriesPerPage = params?.perPage ?? 20;

  const raffle = await db.raffles.findUnique({
    where: { id },
    include: {
      user: { select: { username: true } },
    },
  });

  if (!raffle) return null;

  // Enrich prizes with pack/card details
  const rawPrizes = (raffle.prizes as RafflePrize[] | null) ?? [];
  const packIds = rawPrizes.filter((p) => p.type === "pack").map((p) => p.id);
  const cardIds = rawPrizes.filter((p) => p.type === "card").map((p) => p.id);

  // Packs, cards, entries and entries-count are all independent — run together.
  const [packs, cards, entries, entriesTotal] = await Promise.all([
    packIds.length > 0
      ? db.packs.findMany({ where: { id: { in: packIds } }, select: { id: true, name: true, image_url: true, price: true } })
      : Promise.resolve([] as Array<{ id: string; name: string; image_url: string | null; price: unknown }>),
    cardIds.length > 0
      ? db.cards.findMany({ where: { id: { in: cardIds } }, select: { id: true, name: true, image_url: true, price: true } })
      : Promise.resolve([] as Array<{ id: string; name: string; image_url: string | null; price: unknown }>),
    db.raffle_entries.findMany({
      where: { raffle_id: id },
      include: {
        user: { select: { username: true } },
      },
      orderBy: { created_at: "desc" },
      skip: (entriesPage - 1) * entriesPerPage,
      take: entriesPerPage,
    }),
    db.raffle_entries.count({ where: { raffle_id: id } }),
  ]);

  const packMap = new Map(packs.map((p) => [p.id, p]));
  const cardMap = new Map(cards.map((c) => [c.id, c]));

  const enrichedPrizes: EnrichedPrize[] = rawPrizes.map((prize) => {
    const item = prize.type === "pack" ? packMap.get(prize.id) : cardMap.get(prize.id);
    return {
      ...prize,
      name: item?.name ?? null,
      imageUrl: item?.image_url ?? null,
      priceUsd: item?.price != null ? toNumber(item.price) : null,
    };
  });

  return {
    id: raffle.id,
    name: raffle.name,
    description: raffle.description,
    status: raffle.status,
    totalEntries: raffle.total_entries,
    participantCount: raffle.participant_count,
    winnerUsername: raffle.user?.username ?? null,
    winnerUserId: raffle.winner_user_id,
    prizes: enrichedPrizes,
    minPointsPerEntry: raffle.min_points_per_entry,
    maxPointsPerEntry: raffle.max_points_per_entry,
    startsAt: raffle.starts_at.toISOString(),
    endsAt: raffle.ends_at.toISOString(),
    completedAt: raffle.completed_at?.toISOString() ?? null,
    createdAt: raffle.created_at.toISOString(),
    entries: {
      data: entries.map((e) => ({
        id: e.id,
        userId: e.user_id,
        username: e.user?.username ?? null,
        pointsSpent: e.points_spent,
        createdAt: e.created_at.toISOString(),
      })),
      total: entriesTotal,
      page: entriesPage,
      perPage: entriesPerPage,
      totalPages: Math.ceil(entriesTotal / entriesPerPage),
    },
  };
}
