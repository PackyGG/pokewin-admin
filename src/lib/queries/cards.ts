import { unstable_cache } from "next/cache";
import { sql, type SQL } from "drizzle-orm";
import { getDrizzleDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { safeQueryOrNull } from "@/lib/errors/safe-query";
import type { PaginatedResult } from "@/lib/types";

export type CardListItem = {
  id: string;
  name: string;
  imageUrl: string;
  priceUsd: number;
  hp: number | null;
  rarity: string | null;
  type: string;
  cardNumber: string | null;
  setName: string | null;
  /**
   * How many packs reference this card (`pack_cards` relation count). Surfaced
   * as a sortable-context column in the table view so the operator can spot
   * orphan vs in-use cards while grooming. It's an aggregated `_count` in the
   * same `findMany` (no N+1) — `artist` was dropped from the payload (the grid
   * never rendered it) to offset the extra column on the wire.
   */
  inPacks: number;
};

/**
 * Whitelisted sort fields for the cards list — shared by `getCards` and the
 * page's `parseListParams` so a hand-edited `?sortBy=` can't reach an
 * un-indexed column. `created_at` is the default (newest first).
 */
export const CARD_SORT_FIELDS = ["created_at", "name", "price"] as const;

/**
 * Translate the list filter params into SQL predicates. Pulled out of
 * `getCards` so the (cached) count helper applies the EXACT same predicate as
 * the page slice — the count and the rows can never drift apart.
 */
function buildCardsWhere(params: {
  search?: string;
  rarity?: string;
  setId?: string;
  minPrice?: string;
  maxPrice?: string;
}): SQL {
  const { search, rarity, setId, minPrice, maxPrice } = params;
  const predicates: SQL[] = [];
  if (search) predicates.push(sql`c.name ILIKE ${`%${search}%`}`);
  if (rarity) predicates.push(sql`c.rarity = ${rarity}`);

  // `setId === "unassigned"` is a sentinel for cards with `set_id IS NULL`.
  // Lets the operator narrow the catalog to the un-grouped backlog before
  // bulk-moving them into a real set.
  if (setId === "unassigned") {
    predicates.push(sql`c.set_id IS NULL`);
  } else if (setId) {
    predicates.push(sql`c.set_id = ${setId}::uuid`);
  }

  const min = minPrice ? Number(minPrice) : null;
  const max = maxPrice ? Number(maxPrice) : null;
  if (min != null && Number.isFinite(min)) predicates.push(sql`c.price >= ${min}`);
  if (max != null && Number.isFinite(max)) predicates.push(sql`c.price <= ${max}`);
  return predicates.length > 0
    ? sql`WHERE ${sql.join(predicates, sql` AND `)}`
    : sql``;
}

/**
 * Cached COUNT over the filtered predicate. The discovery flagged that the
 * list's own total count ran uncached on every page/filter/search change
 * against a ~50k-row table (only the KPI strip was cached). We cache it on a
 * stable string key built from the filter params (NOT page/perPage/sort — the
 * total is identical across those) for 60s, mirroring `getCardsStats`. The
 * catalog mutates rarely, so 60s of count lag is acceptable and the deep-page
 * navigations stop re-counting the whole predicate.
 */
async function fetchCardsListCount(
  where: SQL,
): Promise<number> {
  const db = await getDrizzleDb();
  const result = await db.execute<{ count: string }>(sql`
    SELECT COUNT(*)::text AS count FROM cards c ${where}
  `);
  return Number(result.rows[0]?.count ?? 0);
}

function getCardsListCount(
  where: SQL,
  cacheKey: string,
): Promise<number> {
  return unstable_cache(
    () => fetchCardsListCount(where),
    ["cards-list-count-v1", cacheKey],
    { revalidate: 60, tags: ["cards-list-count"] },
  )();
}

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
  const db = await getDrizzleDb();

  const where = buildCardsWhere({ search, rarity, setId, minPrice, maxPrice });

  const field = (CARD_SORT_FIELDS as readonly string[]).includes(sortBy)
    ? sortBy
    : "created_at";
  const order = sortOrder === "asc" ? "asc" : "desc";
  const orderBy =
    field === "name"
      ? order === "asc" ? sql`c.name ASC` : sql`c.name DESC`
      : field === "price"
        ? order === "asc" ? sql`c.price ASC` : sql`c.price DESC`
        : order === "asc" ? sql`c.created_at ASC` : sql`c.created_at DESC`;
  const safePage = Math.max(1, Math.trunc(page) || 1);
  const safePerPage = Math.min(200, Math.max(1, Math.trunc(perPage) || 20));

  // Stable cache key for the COUNT — only the FILTER params change the total,
  // not page/perPage/sort, so they're excluded. Empty string for an absent
  // filter keeps the key compact + collision-free across param combinations.
  const countKey = [
    search ?? "",
    rarity ?? "",
    setId ?? "",
    minPrice ?? "",
    maxPrice ?? "",
  ].join("|");

  // Explicit `select` listing only the columns the views actually render.
  // Switching off `findMany`'s default "all columns" behaviour means a
  // newly-added schema field that hasn't reached the live DB (e.g. the
  // OnePiece `cost` / `power` columns added in commit a865aa8) cannot
  // crash this query on production. Pulling fewer columns also shrinks
  // the Server → Client payload for the per-page slice. `_count.pack_cards`
  // is an aggregated subquery in the SAME findMany — it gives the table an
  // "In Packs" column without an N+1 per-row fetch.
  const [cards, total] = await Promise.all([
    db.execute<{
      id: string; name: string; image_url: string; price: string;
      hp: number | null; rarity: string | null; type: string;
      card_number: string | null; set_name: string | null; in_packs: string;
    }>(sql`
      SELECT c.id, c.name, c.image_url, c.price::text AS price, c.hp,
             c.rarity, c.type, c.card_number, s.name AS set_name,
             COUNT(pc.id)::text AS in_packs
      FROM cards c
      LEFT JOIN sets s ON s.id = c.set_id
      LEFT JOIN pack_cards pc ON pc.card_id = c.id
      ${where}
      GROUP BY c.id, s.name
      ORDER BY ${orderBy}
      LIMIT ${safePerPage} OFFSET ${(safePage - 1) * safePerPage}
    `).then((result) => result.rows),
    getCardsListCount(where, countKey),
  ]);

  return {
    data: cards.map((c) => ({
      id: c.id,
      name: c.name,
      imageUrl: c.image_url,
      priceUsd: toNumber(c.price),
      hp: c.hp,
      rarity: c.rarity,
      type: c.type,
      cardNumber: c.card_number,
      setName: c.set_name,
      inPacks: Number(c.in_packs),
    })),
    total,
    page: safePage,
    perPage: safePerPage,
    totalPages: Math.ceil(total / safePerPage),
  };
}

/**
 * Card ids matching the current filter predicate, capped at `limit`. Powers
 * the bulk toolbar's "Select all N matching" affordance — the operator can
 * groom a backlog larger than one page in a single move. The cap matches
 * `bulkMoveCardsToSet`'s own 500-id ceiling so a returned set is always
 * movable in one action. Returns ONLY ids (no row payload) so even the capped
 * 500 stays a tiny wire response. Ordered by `created_at desc` for stability.
 */
export async function getCardIdsForFilter(
  params: {
    search?: string;
    rarity?: string;
    setId?: string;
    minPrice?: string;
    maxPrice?: string;
  },
  limit: number,
): Promise<string[]> {
  const db = await getDrizzleDb();
  const where = buildCardsWhere(params);
  const safeLimit = Math.min(500, Math.max(1, Math.trunc(limit) || 1));
  const result = await db.execute<{ id: string }>(sql`
    SELECT c.id
    FROM cards c
    ${where}
    ORDER BY c.created_at DESC
    LIMIT ${safeLimit}
  `);
  return result.rows.map((r) => r.id);
}

/**
 * Lean detail read for the in-list INSPECTOR sheet — every scalar field the
 * inspector renders plus the pack-usage count, in ONE typed `findUnique`.
 *
 * Deliberately lighter than {@link getCardDetail}: it does NOT run the
 * unbounded `COUNT(*)` over `user_inventory` (the discovery flagged that as
 * uncapped) and does NOT pull the full `pack_cards` → packs join. The
 * inspector is a fast preview; the full `/cards/[id]` page (which still uses
 * `getCardDetail`) owns the heavier inventory/pack breakdown. `cost`/`power`
 * are read in a defensively-wrapped raw query so a DB without the OnePiece
 * cost/power migration degrades those two fields to `null` instead of
 * crashing (same pattern as `getCardDetail`).
 */
export type CardInspector = {
  id: string;
  name: string;
  imageUrl: string;
  priceUsd: number;
  priceRawUsd: number;
  hp: number | null;
  cost: number | null;
  power: number | null;
  rarity: string | null;
  artist: string | null;
  tcgplayerId: number | null;
  type: string;
  cardNumber: string | null;
  setId: string | null;
  setName: string | null;
  packCount: number;
  createdAt: string;
  updatedAt: string;
};

export async function getCardInspector(
  id: string,
): Promise<CardInspector | null> {
  const db = await getDrizzleDb();
  const [cardResult, statsResult] = await Promise.all([
    db.execute<{
      id: string; name: string; image_url: string; price: string; price_raw: string;
      hp: number | null; rarity: string | null; artist: string | null;
      tcgplayer_id: number | null; type: string; card_number: string | null;
      set_id: string | null; set_name: string | null; pack_count: string;
      created_at: Date; updated_at: Date;
    }>(sql`
      SELECT c.id, c.name, c.image_url, c.price::text AS price,
             c.price_raw::text AS price_raw, c.hp, c.rarity, c.artist,
             c.tcgplayer_id, c.type, c.card_number, c.set_id,
             s.name AS set_name, COUNT(pc.id)::text AS pack_count,
             c.created_at, c.updated_at
      FROM cards c
      LEFT JOIN sets s ON s.id = c.set_id
      LEFT JOIN pack_cards pc ON pc.card_id = c.id
      WHERE c.id = ${id}::uuid
      GROUP BY c.id, s.name
    `),
    safeQueryOrNull(
      async () => {
        const result = await db.execute<{ cost: number | null; power: number | null }>(sql`
          SELECT cost, power FROM cards WHERE id = ${id}::uuid
        `);
        return result.rows;
      },
      "cards.getCardInspector.costPower",
    ),
  ]);

  const card = cardResult.rows[0];
  if (!card) return null;

  const statsRow = statsResult.data?.[0] ?? null;

  return {
    id: card.id,
    name: card.name,
    imageUrl: card.image_url,
    priceUsd: toNumber(card.price),
    priceRawUsd: toNumber(card.price_raw),
    hp: card.hp,
    cost: statsRow?.cost ?? null,
    power: statsRow?.power ?? null,
    rarity: card.rarity,
    artist: card.artist,
    tcgplayerId: card.tcgplayer_id,
    type: card.type,
    cardNumber: card.card_number,
    setId: card.set_id,
    setName: card.set_name,
    packCount: Number(card.pack_count),
    createdAt: card.created_at.toISOString(),
    updatedAt: card.updated_at.toISOString(),
  };
}

/**
 * Cached `COUNT(*)` over `user_inventory` for one card — the detail page's
 * "In Inventory" KPI. Previously this ran uncached on every `/cards/[id]`
 * load against the large game `user_inventory` table; the value is identical
 * across page/scroll, so we cache it per card-id for 60s (mirrors
 * `getCardsListCount` / `getCardsStats`). Same COUNT, just memoised — the
 * surfaced number is unchanged, only fresher reads degrade to ≤60s lag.
 */
async function fetchCardInventoryCount(id: string): Promise<number> {
  const db = await getDrizzleDb();
  const result = await db.execute<{ count: string }>(sql`
    SELECT COUNT(*)::text AS count
    FROM user_inventory
    WHERE card_id = ${id}::uuid
  `);
  return Number(result.rows[0]?.count ?? 0);
}

function getCardInventoryCount(id: string): Promise<number> {
  return unstable_cache(
    () => fetchCardInventoryCount(id),
    ["card-inventory-count-v1", id],
    { revalidate: 60, tags: ["card-inventory-count"] },
  )();
}

export async function getCardDetail(id: string) {
  const db = await getDrizzleDb();
  // Explicit `select` on the card columns. Everything named here is a
  // column present on EVERY card DB (original schema), so the typed
  // `findUnique` is safe on production and on older snapshots alike.
  //
  // `cost` / `power` are deliberately NOT in this select: they're the
  // OnePiece-only columns added by a later migration (commit a865aa8) and
  // may be absent on a DB that hasn't run it yet. Naming them here would
  // add them to the SELECT column list and crash the whole
  // detail query with 42703 on such a DB. Instead we read them in a
  // SEPARATE, defensively-wrapped raw query below (safeQueryOrNull) so a
  // missing column degrades those two attributes to "—" rather than
  // taking the page down. `price_raw` IS an original column (the pre-fee
  // catalog price the create/edit actions mirror from `price`), so it
  // stays in the typed select.
  //
  // pack_cards relation: we only need the related `packs` row per join,
  // not the join-row's own columns (weight, color, animation, etc.).
  // Switching include → select drops them from the wire.
  const [cardResult, inventoryCount, statsResult] = await Promise.all([
    db.execute<{
      id: string; name: string; image_url: string; price: string; price_raw: string;
      hp: number | null; rarity: string | null; artist: string | null;
      tcgplayer_id: number | null; type: string; card_number: string | null;
      set_id: string | null; set_name: string | null; created_at: Date;
      updated_at: Date;
      packs: Array<{ id: string; name: string; imageUrl: string | null }>;
    }>(sql`
      SELECT c.id, c.name, c.image_url, c.price::text AS price,
             c.price_raw::text AS price_raw, c.hp, c.rarity, c.artist,
             c.tcgplayer_id, c.type, c.card_number, c.set_id,
             s.name AS set_name, c.created_at, c.updated_at,
             COALESCE(
               jsonb_agg(
                 jsonb_build_object(
                   'id', p.id,
                   'name', p.name,
                   'imageUrl', p.image_url
                 )
                 ORDER BY p.name
               ) FILTER (WHERE p.id IS NOT NULL),
               '[]'::jsonb
             ) AS packs
      FROM cards c
      LEFT JOIN sets s ON s.id = c.set_id
      LEFT JOIN pack_cards pc ON pc.card_id = c.id
      LEFT JOIN packs p ON p.id = pc.pack_id
      WHERE c.id = ${id}::uuid
      GROUP BY c.id, s.name
    `),
    getCardInventoryCount(id),
    // OnePiece game-design columns. Read on their own so a DB without the
    // cost/power migration (missing-column → 42703) degrades to
    // `null` here instead of crashing the detail page. Mirrors the
    // schema-defensive pattern in src/lib/queries/insights-streamers/
    // _schema-probe.ts. `cost`/`power` are stored as `Int?` so the row
    // values come back as numbers (or null) — cast nothing.
    safeQueryOrNull(
      async () => {
        const result = await db.execute<{ cost: number | null; power: number | null }>(sql`
          SELECT cost, power FROM cards WHERE id = ${id}::uuid
        `);
        return result.rows;
      },
      "cards.getCardDetail.costPower",
    ),
  ]);

  const card = cardResult.rows[0];
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
    setName: card.set_name,
    inventoryCount,
    packs: card.packs,
    createdAt: card.created_at.toISOString(),
    updatedAt: card.updated_at.toISOString(),
  };
}

export async function getSets() {
  const db = await getDrizzleDb();
  const result = await db.execute<{ id: string; name: string }>(sql`
    SELECT id, name FROM sets ORDER BY name ASC
  `);
  return result.rows;
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
  const db = await getDrizzleDb();
  const result = await db.execute<{
    id: string;
    name: string;
    series: string;
    language: string;
    release_date: Date | null;
  }>(sql`
    SELECT id, name, series, language, release_date
    FROM sets ORDER BY series ASC, name ASC
  `);
  return result.rows.map((s) => ({
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
  const db = await getDrizzleDb();
  const result = await db.execute<{ series: string }>(sql`
    SELECT DISTINCT series FROM sets
    WHERE BTRIM(series) <> ''
    ORDER BY series ASC
  `);
  return result.rows.map((r) => r.series);
}

/**
 * Everything the bulk-move dialog needs (the enriched set list + the distinct
 * series options for the create-new-set sub-form), fetched together. Lives
 * behind {@link loadMoveDialogData} (a server action called only when the
 * dialog OPENS) so the discovery's "hidden-component over-fetch" — these two
 * queries used to run on EVERY list render even though the dialog is closed by
 * default — is eliminated. The two queries are independent → run in parallel.
 */
export type MoveDialogData = {
  sets: SetForMoveDialog[];
  series: string[];
};

export async function getMoveDialogData(): Promise<MoveDialogData> {
  const [sets, series] = await Promise.all([
    getSetsForMoveDialog(),
    getDistinctSeries(),
  ]);
  return { sets, series };
}

/**
 * Distinct rarity values for the filter dropdown. SCOPED to the active set
 * (the discovery flagged that the unscoped version made an admin on the
 * Pokemon tab scan every OnePiece rarity too) and CACHED — a `groupBy` over a
 * ~50k-row table on every keystroke/pagination was wasteful. `groupBy` lets
 * Postgres hash-aggregate instead of the full row-scan-then-distinct
 * `findMany` would do. `"all"` is the catalog-wide sentinel for the cache key.
 */
async function fetchRarities(setId?: string): Promise<(string | null)[]> {
  const db = await getDrizzleDb();
  const where =
    setId && setId !== "unassigned"
      ? sql`WHERE set_id = ${setId}::uuid`
      : setId === "unassigned"
        ? sql`WHERE set_id IS NULL`
        : sql``;
  const result = await db.execute<{ rarity: string | null }>(sql`
    SELECT DISTINCT rarity FROM cards ${where} ORDER BY rarity ASC
  `);
  return result.rows.map((r) => r.rarity);
}

export async function getRarities(setId?: string): Promise<(string | null)[]> {
  return unstable_cache(
    () => fetchRarities(setId),
    ["cards-rarities-v1", setId ?? "all"],
    { revalidate: 60, tags: ["cards-rarities"] },
  )();
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
  const db = await getDrizzleDb();
  // When `setId` is provided, narrow every aggregate to that set so the
  // KPI strip + total count reflect the active per-set tab on /cards.
  // `totalSets` keeps the catalog-wide value either way — it's a meta
  // figure ("how many sets exist") that doesn't change when the operator
  // is browsing a single set.
  //
  // `"unassigned"` is the sentinel for the un-grouped backlog (`set_id IS
  // NULL`) — the SAME sentinel `buildCardsWhere` / `fetchRarities` honour.
  // It MUST NOT reach the query as a literal `set_id = "unassigned"`: the
  // `set_id` column is a uuid, so invalid values fail and the whole KPI
  // strip degrades to a permanent error tile on `/cards?set=unassigned`.
  // Map it to `{ set_id: null }` so the aggregates scope to the backlog.
  const where =
    setId === "unassigned"
      ? sql`WHERE set_id IS NULL`
      : setId
        ? sql`WHERE set_id = ${setId}::uuid`
        : sql``;
  const [summaryResult, rarityResult] = await Promise.all([
    db.execute<{
      total: string;
      total_sets: string;
      avg_price: string | null;
      max_price: string | null;
    }>(sql`
      SELECT
        COUNT(*)::text AS total,
        (SELECT COUNT(*)::text FROM sets) AS total_sets,
        AVG(price)::text AS avg_price,
        MAX(price)::text AS max_price
      FROM cards ${where}
    `),
    db.execute<{ rarity: string | null; count: string }>(sql`
      SELECT rarity, COUNT(*)::text AS count
      FROM cards ${where}
      GROUP BY rarity
    `),
  ]);
  const summary = summaryResult.rows[0];

  const byRarity = rarityResult.rows
    .map((g) => ({
      rarity: g.rarity ?? "Unknown",
      count: Number(g.count),
    }))
    .sort((a, b) => b.count - a.count);

  return {
    total: Number(summary?.total ?? 0),
    totalSets: Number(summary?.total_sets ?? 0),
    avgPriceUsd: toNumber(summary?.avg_price),
    maxPriceUsd: toNumber(summary?.max_price),
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
