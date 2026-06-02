import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { safeQueryOrNull } from "@/lib/errors/safe-query";
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

  // Explicit `select` listing only the columns the grid actually renders.
  // Switching off `findMany`'s default "all columns" behaviour means a
  // newly-added schema field that hasn't reached the live DB (e.g. the
  // OnePiece `cost` / `power` columns added in commit a865aa8) cannot
  // crash this query on production. Pulling fewer columns also shrinks
  // the Server → Client payload for the 40-card-per-page grid.
  const [cards, total] = await Promise.all([
    db.cards.findMany({
      where,
      orderBy,
      skip: (page - 1) * perPage,
      take: perPage,
      select: {
        id: true,
        name: true,
        image_url: true,
        price: true,
        hp: true,
        rarity: true,
        artist: true,
        type: true,
        card_number: true,
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
  // Explicit `select` on the card columns. Everything named here is a
  // column present on EVERY card DB (original schema), so the typed
  // `findUnique` is safe on production and on older snapshots alike.
  //
  // `cost` / `power` are deliberately NOT in this select: they're the
  // OnePiece-only columns added by a later migration (commit a865aa8) and
  // may be absent on a DB that hasn't run it yet. Naming them here would
  // make Prisma emit them in the SELECT column list and crash the whole
  // detail query with P2022 on such a DB. Instead we read them in a
  // SEPARATE, defensively-wrapped raw query below (safeQueryOrNull) so a
  // missing column degrades those two attributes to "—" rather than
  // taking the page down. `price_raw` IS an original column (the pre-fee
  // catalog price the create/edit actions mirror from `price`), so it
  // stays in the typed select.
  //
  // pack_cards relation: we only need the related `packs` row per join,
  // not the join-row's own columns (weight, color, animation, etc.).
  // Switching include → select drops them from the wire.
  const [card, inventoryCountRows, statsResult] = await Promise.all([
    db.cards.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        image_url: true,
        price: true,
        price_raw: true,
        hp: true,
        rarity: true,
        artist: true,
        tcgplayer_id: true,
        type: true,
        card_number: true,
        set_id: true,
        created_at: true,
        updated_at: true,
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
    // OnePiece game-design columns. Read on their own so a DB without the
    // cost/power migration (missing-column → P2022 / 42703) degrades to
    // `null` here instead of crashing the detail page. Mirrors the
    // schema-defensive pattern in src/lib/queries/insights-streamers/
    // _schema-probe.ts. `cost`/`power` are stored as `Int?` so the row
    // values come back as numbers (or null) — cast nothing.
    safeQueryOrNull(
      () =>
        db.$queryRaw<{ cost: number | null; power: number | null }[]>`
          SELECT cost, power FROM cards WHERE id = ${id}::uuid`,
      "cards.getCardDetail.costPower",
    ),
  ]);

  if (!card) return null;

  const statsRow = statsResult.data?.[0] ?? null;

  return {
    id: card.id,
    name: card.name,
    imageUrl: card.image_url,
    priceUsd: toNumber(card.price),
    priceRawUsd: toNumber(card.price_raw),
    hp: card.hp,
    // null when the cost/power migration hasn't reached this DB (the
    // defensive read above returned null) OR when the card simply has no
    // value (Pokemon cards). The page treats both as "not applicable".
    cost: statsRow?.cost ?? null,
    power: statsRow?.power ?? null,
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
async function fetchCardsStats(setId?: string): Promise<CardsStats> {
  const db = await getDb();
  // When `setId` is provided, narrow every aggregate to that set so the
  // KPI strip + total count reflect the active per-set tab on /cards.
  // `totalSets` keeps the catalog-wide value either way — it's a meta
  // figure ("how many sets exist") that doesn't change when the operator
  // is browsing a single set.
  const where = setId ? { set_id: setId } : undefined;
  const [total, totalSets, priceAgg, rarityGroups] = await Promise.all([
    db.cards.count({ where }),
    db.sets.count(),
    db.cards.aggregate({
      where,
      _avg: { price: true },
      _max: { price: true },
    }),
    db.cards.groupBy({
      by: ["rarity"],
      where,
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
}

export async function getCardsStats(setId?: string): Promise<CardsStats> {
  // v3 cache key — `unstable_cache`'s keyParts array is the ONLY segment
  // key for cache slots; the function-arg list is NOT automatically mixed
  // into the key. v2 used a static one-string keyParts (["cards-list-stats-v2"]),
  // so calls with `setId=<pokemonUUID>` collided with the catalog-wide
  // `setId=undefined` call — whichever landed in the cache first served
  // every subsequent request. That produced the "Cards in Pokemon: 65"
  // symptom where the 65-card seed count was served for the catalog-wide
  // 50,588 query (or vice versa). Including `setId` in keyParts per call
  // gives each set its own slot. `"all"` is the sentinel for the
  // catalog-wide aggregate.
  return unstable_cache(
    () => fetchCardsStats(setId),
    ["cards-list-stats-v3", setId ?? "all"],
    { revalidate: 60, tags: ["cards-list-stats"] },
  )();
}
