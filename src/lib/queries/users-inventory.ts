import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { Prisma } from "@/generated/prisma/client";

export async function getUserInventory(
  userId: string,
  page: number = 1,
  perPage: number = 20,
  filters?: {
    rarity?: string;
    status?: string;
    search?: string;
    sort?: string;
    priceMin?: number;
    priceMax?: number;
  }
) {
  const db = await getDb();
  const where: Prisma.user_inventoryWhereInput = { user_id: userId };

  if (filters?.status === "owned") {
    where.sold_at = { equals: null };
    where.exchanged_at = { equals: null };
  } else if (filters?.status === "sold") {
    where.sold_at = { not: null };
  } else if (filters?.status === "exchanged") {
    where.exchanged_at = { not: null };
  } else if (filters?.status === "disposed") {
    // Items that have left the user's owned inventory either via sale or
    // exchange. Used for the combined "Sold & Exchanged" admin section.
    where.OR = [{ sold_at: { not: null } }, { exchanged_at: { not: null } }];
  }

  if (filters?.priceMin != null) {
    where.value_at_obtained = { ...(where.value_at_obtained as object ?? {}), gte: filters.priceMin };
  }
  if (filters?.priceMax != null) {
    where.value_at_obtained = { ...(where.value_at_obtained as object ?? {}), lte: filters.priceMax };
  }

  // For rarity / search filtering, we need to find matching card IDs first
  let cardIdFilter: string[] | null = null;
  if (filters?.rarity || filters?.search) {
    const cardWhere: Prisma.cardsWhereInput = {};
    if (filters.rarity) cardWhere.rarity = { equals: filters.rarity, mode: "insensitive" };
    if (filters.search) cardWhere.name = { contains: filters.search, mode: "insensitive" };
    const matchingCards = await db.cards.findMany({
      where: cardWhere,
      select: { id: true },
    });
    cardIdFilter = matchingCards.map((c) => c.id);
    where.card_id = { in: cardIdFilter };
  }

  // Sort
  let orderBy: Prisma.user_inventoryOrderByWithRelationInput = { created_at: "desc" };
  if (filters?.sort === "price_asc") orderBy = { value_at_obtained: "asc" };
  else if (filters?.sort === "price_desc") orderBy = { value_at_obtained: "desc" };
  else if (filters?.sort === "oldest") orderBy = { created_at: "asc" };

  const [items, total] = await Promise.all([
    db.user_inventory.findMany({
      where,
      orderBy,
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    db.user_inventory.count({ where }),
  ]);

  // Fetch card details for the items
  const cardIds = [...new Set(items.map((i) => i.card_id))];
  const cards = cardIds.length > 0
    ? await db.cards.findMany({
        where: { id: { in: cardIds } },
        select: { id: true, name: true, image_url: true, rarity: true },
      })
    : [];
  const cardMap = new Map(cards.map((c) => [c.id, c]));

  return {
    data: items.map((item) => {
      const card = cardMap.get(item.card_id);
      return {
        id: item.id,
        cardName: card?.name ?? "Unknown Card",
        imageUrl: card?.image_url ?? null,
        rarity: card?.rarity ?? null,
        value: toNumber(item.value_at_obtained),
        sourceType: item.source_type,
        obtainedAt: item.obtained_at.toISOString(),
        soldAt: item.sold_at?.toISOString() ?? null,
        exchangedAt: item.exchanged_at?.toISOString() ?? null,
      };
    }),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}
