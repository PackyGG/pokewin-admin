"use server";

import {
  and,
  asc,
  eq,
  gte,
  ilike,
  lte,
  or,
  type SQL,
} from "drizzle-orm";

import { getDrizzleDb } from "@/lib/db";
import { cards, packs } from "@/lib/db-schema/main/schema";
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
  const db = await getDrizzleDb();
  await requirePageAccess("/rewards");
  const isUuid = UUID_RE.test(query);

  if (type === "pack") {
    const conditions: SQL[] = [];
    if (query) {
      const search = [
        ilike(packs.name, `%${query}%`),
        ilike(packs.slug, `%${query}%`),
      ];
      if (isUuid) search.push(eq(packs.id, query));
      conditions.push(or(...search)!);
    }
    if (filters?.minPrice != null)
      conditions.push(gte(packs.price, String(filters.minPrice)));
    if (filters?.maxPrice != null)
      conditions.push(lte(packs.price, String(filters.maxPrice)));

    const packRows = await db
      .select({
        id: packs.id,
        name: packs.name,
        image_url: packs.image_url,
        price: packs.price,
      })
      .from(packs)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(asc(packs.name))
      .limit(20);
    return packRows.map((p) => ({
      id: p.id,
      type: "pack",
      name: p.name,
      imageUrl: p.image_url,
      priceUsd: toNumber(p.price),
    }));
  }

  const conditions: SQL[] = [];
  if (query) {
    const search = [ilike(cards.name, `%${query}%`)];
    if (isUuid) search.push(eq(cards.id, query));
    conditions.push(or(...search)!);
  }
  if (filters?.minPrice != null)
    conditions.push(gte(cards.price, String(filters.minPrice)));
  if (filters?.maxPrice != null)
    conditions.push(lte(cards.price, String(filters.maxPrice)));

  const cardRows = await db
    .select({
      id: cards.id,
      name: cards.name,
      image_url: cards.image_url,
      price: cards.price,
    })
    .from(cards)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(cards.name))
    .limit(20);
  return cardRows.map((c) => ({
    id: c.id,
    type: "card",
    name: c.name,
    imageUrl: c.image_url,
    priceUsd: toNumber(c.price),
  }));
}
