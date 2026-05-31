import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import type { PaginatedResult } from "@/lib/types";
import { Prisma } from "@/generated/prisma/client";

export type CardListItem = {
  id: string;
  name: string;
  imageUrl: string;
  priceUsd: number;
  hp: number | null;
  rarity: string | null;
  artist: string | null;
  type: string;
  cardNumber: string | null;
  setName: string | null;
};

export async function getCards(params: {
  page?: number;
  perPage?: number;
  search?: string;
  rarity?: string;
  setId?: string;
  minPrice?: string;
  maxPrice?: string;
  sortBy?: string;
  sortOrder?: string;
}): Promise<PaginatedResult<CardListItem>> {
  const {
    page = 1,
    perPage = 20,
    search,
    rarity,
    setId,
    minPrice,
    maxPrice,
    sortBy = "created_at",
    sortOrder = "desc",
  } = params;
  const db = await getDb();

  const where: Prisma.cardsWhereInput = {};

  if (search) {
    where.name = { contains: search, mode: "insensitive" };
  }

  if (rarity) {
    where.rarity = rarity;
  }

  // `setId === "unassigned"` is a sentinel for cards with `set_id IS NULL`.
  // Lets the operator narrow the catalog to the un-grouped backlog before
  // bulk-moving them into a real set.
  if (setId === "unassigned") {
    where.set_id = null;
  } else if (setId) {
    where.set_id = setId;
  }

  if (minPrice || maxPrice) {
    where.price = {};
    if (minPrice) where.price.gte = parseFloat(minPrice);
    if (maxPrice) where.price.lte = parseFloat(maxPrice);
  }

  const orderBy: Prisma.cardsOrderByWithRelationInput = {};
  const validSortFields = ["created_at", "name", "price"];
  const field = validSortFields.includes(sortBy) ? sortBy : "created_at";
  const order = sortOrder === "asc" ? "asc" : "desc";
  (orderBy as Record<string, string>)[field] = order;

  const [cards, total] = await Promise.all([
    db.cards.findMany({
      where,
      orderBy,
      skip: (page - 1) * perPage,
      take: perPage,
      include: {
        sets: { select: { name: true } },
      },
    }),
    db.cards.count({ where }),
  ]);

  return {
    data: cards.map((c) => ({
      id: c.id,
      name: c.name,
      imageUrl: c.image_url,
      priceUsd: toNumber(c.price),
      hp: c.hp,
      rarity: c.rarity,
      artist: c.artist,
      type: c.type,
      cardNumber: c.card_number,
      setName: c.sets?.name ?? null,
    })),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}

export async function getCardDetail(id: string) {
  const db = await getDb();
  // pack_cards relation: we only need the related `packs` row per join, not
  // the join-row's own columns (weight, color, animation, etc). Switching
  // include->select drops them from the wire.
  const [card, inventoryCountRows] = await Promise.all([
    db.cards.findUnique({
      where: { id },
      include: {
        sets: { select: { id: true, name: true } },
        pack_cards: {
          select: {
            packs: { select: { id: true, name: true, image_url: true } },
          },
        },
      },
    }),
    db.$queryRawUnsafe<{ count: string }[]>(
      `SELECT COUNT(*)::text AS count FROM user_inventory WHERE card_id = $1`,
      id
    ),
  ]);

  if (!card) return null;

  return {
    id: card.id,
    name: card.name,
    imageUrl: card.image_url,
    priceUsd: toNumber(card.price),
    hp: card.hp,
    rarity: card.rarity,
    artist: card.artist,
    tcgplayerId: card.tcgplayer_id,
    type: card.type,
    cardNumber: card.card_number,
    setId: card.set_id,
    setName: card.sets?.name ?? null,
    inventoryCount: Number(inventoryCountRows[0]?.count ?? 0),
    packs: card.pack_cards.map((pc: { packs: { id: string; name: string; image_url: string | null } }) => ({
      id: pc.packs.id,
      name: pc.packs.name,
      imageUrl: pc.packs.image_url,
    })),
    createdAt: card.created_at.toISOString(),
    updatedAt: card.updated_at.toISOString(),
  };
}

export async function getSets() {
  const db = await getDb();
  const sets = await db.sets.findMany({
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });
  return sets;
}

export type SetForMoveDialog = {
  id: string;
  name: string;
  series: string;
  language: string;
  releaseDate: string | null;
};

/**
 * Same set list but enriched with the metadata the bulk-move dialog needs
 * to render rows (series chip, language, release date). Kept separate from
 * `getSets()` so the existing thin call sites (filter dropdowns, card
 * create-form) don't pay for the extra columns.
 */
export async function getSetsForMoveDialog(): Promise<SetForMoveDialog[]> {
  const db = await getDb();
  const sets = await db.sets.findMany({
    orderBy: [{ series: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      series: true,
      language: true,
      release_date: true,
    },
  });
  return sets.map((s) => ({
    id: s.id,
    name: s.name,
    series: s.series,
    language: s.language,
    releaseDate: s.release_date?.toISOString() ?? null,
  }));
}

/**
 * Distinct series values across all sets — drives the "Series" dropdown
 * inside the create-new-set sub-form on the bulk-move dialog. Sorted so
 * the dropdown reads alphabetically.
 */
export async function getDistinctSeries(): Promise<string[]> {
  const db = await getDb();
  const result = await db.sets.groupBy({
    by: ["series"],
    orderBy: { series: "asc" },
  });
  return result.map((r) => r.series).filter((s) => s.trim().length > 0);
}

export async function getRarities() {
  const db = await getDb();
  // groupBy on `rarity` lets Postgres do an index-only / hash-aggregate
  // pass instead of the full row-scan-then-distinct that findMany does.
  const result = await db.cards.groupBy({
    by: ["rarity"],
    orderBy: { rarity: "asc" },
  });
  return result.map((r) => r.rarity);
}

export type CardsStats = {
  total: number;
  totalSets: number;
  avgPriceUsd: number;
  maxPriceUsd: number;
  byRarity: { rarity: string; count: number }[];
};

/**
 * Catalog-wide aggregates for the Cards list page hero strip. Runs the
 * counts/aggregates in parallel and keeps the return shape tiny so the
 * Server Component can pass it to the Client grid without bloating the
 * RSC payload.
 *
 * Wrapped in `unstable_cache` (60s revalidate) so admins spamming the
 * search box / pagination don't fan four aggregate queries into the DB on
 * every keystroke. Mirrors getUsersListStats() on /users. The catalog
 * mutates rarely (manual card creation / set edits); 60s of lag in the
 * KPI strip is fine. Within a single request unstable_cache also
 * deduplicates so a Suspense fan-out only runs the query once.
 */
const cachedCardsStats = unstable_cache(
  async (): Promise<CardsStats> => {
    const db = await getDb();
    const [total, totalSets, priceAgg, rarityGroups] = await Promise.all([
      db.cards.count(),
      db.sets.count(),
      db.cards.aggregate({
        _avg: { price: true },
        _max: { price: true },
      }),
      db.cards.groupBy({
        by: ["rarity"],
        _count: { _all: true },
      }),
    ]);

    const byRarity = rarityGroups
      .map((g) => ({
        rarity: g.rarity ?? "Unknown",
        count: g._count._all,
      }))
      .sort((a, b) => b.count - a.count);

    return {
      total,
      totalSets,
      avgPriceUsd: toNumber(priceAgg._avg.price),
      maxPriceUsd: toNumber(priceAgg._max.price),
      byRarity,
    };
  },
  ["cards-list-stats-v1"],
  { revalidate: 60, tags: ["cards-list-stats"] },
);

export async function getCardsStats(): Promise<CardsStats> {
  return cachedCardsStats();
}
