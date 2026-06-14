"use server";

import { getDb } from "@/lib/db";
import { requirePageAccess } from "@/lib/dal";
import { toNumber } from "@/lib/utils/decimal";

export type SearchItem = {
  id: string;
  type: "pack" | "card";
  name: string;
  imageUrl: string | null;
  priceUsd: number;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pack/card search for reward prize pickers (formerly under /rewards/raffles). */
export async function searchItems(
  query: string,
  type: "pack" | "card",
  filters?: { minPrice?: number; maxPrice?: number },
): Promise<SearchItem[]> {
  const db = await getDb();
  await requirePageAccess("/rewards");
  const isUuid = UUID_RE.test(query);

  const priceFilter: Record<string, unknown> = {};
  if (filters?.minPrice != null) priceFilter.gte = filters.minPrice;
  if (filters?.maxPrice != null) priceFilter.lte = filters.maxPrice;
  const hasPriceFilter = Object.keys(priceFilter).length > 0;

  if (type === "pack") {
    const or: Record<string, unknown>[] = [];
    if (query) {
      or.push({ name: { contains: query, mode: "insensitive" } });
      or.push({ slug: { contains: query, mode: "insensitive" } });
      if (isUuid) or.push({ id: query });
    }
    const where: Record<string, unknown> = {};
    if (or.length > 0) where.OR = or;
    if (hasPriceFilter) where.price = priceFilter;

    const packs = await db.packs.findMany({
      where: Object.keys(where).length > 0 ? where : undefined,
      select: { id: true, name: true, image_url: true, price: true },
      orderBy: { name: "asc" },
      take: 20,
    });
    return packs.map((p) => ({
      id: p.id,
      type: "pack",
      name: p.name,
      imageUrl: p.image_url,
      priceUsd: toNumber(p.price),
    }));
  }

  const or: Record<string, unknown>[] = [];
  if (query) {
    or.push({ name: { contains: query, mode: "insensitive" } });
    if (isUuid) or.push({ id: query });
  }
  const where: Record<string, unknown> = {};
  if (or.length > 0) where.OR = or;
  if (hasPriceFilter) where.price = priceFilter;

  const cards = await db.cards.findMany({
    where: Object.keys(where).length > 0 ? where : undefined,
    select: { id: true, name: true, image_url: true, price: true },
    orderBy: { name: "asc" },
    take: 20,
  });
  return cards.map((c) => ({
    id: c.id,
    type: "card",
    name: c.name,
    imageUrl: c.image_url,
    priceUsd: toNumber(c.price),
  }));
}
