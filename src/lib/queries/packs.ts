import { unstable_cache } from "next/cache";
import { getDb, getDevDb, getProdDb } from "@/lib/db";
import { readDbEnv, type DbEnv } from "@/lib/db-env";
import { toNumber } from "@/lib/utils/decimal";
import type { PaginatedResult } from "@/lib/types";
import { Prisma } from "@/generated/prisma/client";
import { pack_tag } from "@/generated/prisma/enums";
import { MS_PER_DAY } from "@/lib/utils/time";

/**
 * Category filter for the /packs list.
 *
 * The values map onto the TWO structured `packs` columns that carry a
 * pack's taxonomy (verified against the schema + the create/edit forms +
 * the ~15 metric queries that key off `pack_type`):
 *
 *   • `tags pack_tag[]`  — the battle-odds enum, members
 *     `pct1 / pct5 / pct10 / fifty50` (DB @map: %1 / %5 / %10 / 50/50).
 *     The 1% / 5% / 10% filters are an exact `tags.has` match on the
 *     corresponding enum member — a real STRUCTURED predicate, not a
 *     name-substring guess.
 *   • `pack_type String` (default "official"; known values official /
 *     custom / promo / reward) — `reward` is the canonical free / daily
 *     reward-pack type used everywhere in the metrics layer
 *     (`packs.pack_type = 'reward'`). "Daily level packs" → that type.
 *
 * NOTE on "sign-up packs": there is NO distinct catalog representation
 * for an onboarding/welcome pack. Welcome-reward grants are themselves
 * `pack_type = 'reward'` (same as daily packs — see
 * insights-rewards/daily-packs.ts), and the "Signup Packs" analytics
 * metric is a *ledger* concept (`balance_reward_claim`), not a `packs`
 * row. So no `signup` option is exposed here — adding one would either
 * collide with the daily/reward filter or invent a relationship that
 * doesn't exist in the data.
 */
export type PackCategoryFilter = "pct1" | "pct5" | "pct10" | "reward";

const PACK_CATEGORY_FILTERS: readonly PackCategoryFilter[] = [
  "pct1",
  "pct5",
  "pct10",
  "reward",
] as const;

/** Whitelist + coerce a raw `?tag=` param to a known category, else undefined. */
export function parsePackCategory(
  raw: string | undefined,
): PackCategoryFilter | undefined {
  return raw && (PACK_CATEGORY_FILTERS as readonly string[]).includes(raw)
    ? (raw as PackCategoryFilter)
    : undefined;
}

/**
 * Translate a category filter into its `packs` where-clause fragment.
 *   • pct1 / pct5 / pct10 → structured `tags.has` enum predicate.
 *   • reward              → `pack_type = 'reward'` (free / daily packs).
 */
function buildPackCategoryWhere(
  category: PackCategoryFilter,
): Prisma.packsWhereInput {
  switch (category) {
    case "pct1":
      return { tags: { has: pack_tag.pct1 } };
    case "pct5":
      return { tags: { has: pack_tag.pct5 } };
    case "pct10":
      return { tags: { has: pack_tag.pct10 } };
    case "reward":
      return { pack_type: "reward" };
  }
}

export type PackListCard = {
  id: string;
  name: string;
  imageUrl: string | null;
  rarity: string | null;
};

export type PackListItem = {
  id: string;
  name: string;
  slug: string;
  imageUrl: string | null;
  priceUsd: number;
  cardsPerOpen: number;
  totalOpenings: number;
  totalRevenue: number;
  totalPayout: number;
  actualRtp: number;
  actualHouseEdge: number;
  active: boolean;
  /** First ~10 cards only — enough to render the preview strip. */
  cards: PackListCard[];
  /** Total number of cards associated with this pack. */
  totalCardCount: number;
};

/**
 * The two well-known pack pools. `pokemon` is the implicit default —
 * packs carry no first-class "type" column (the `pack_tag` enum is for
 * battle odds: %1 / %5 / %10 / 50/50, NOT card game), so a pack's type
 * is *derived* from the sets of the cards it contains:
 *
 *   • OnePiece pack  = has ≥1 card whose `set_id` is an OnePiece set
 *   • Pokemon pack   = every other pack (the default / most common case,
 *                      incl. packs with no OnePiece cards or no cards yet)
 *
 * The discriminator lives in the card→set linkage exactly like /cards,
 * which scopes its catalog by `cards.set_id → sets.name`.
 */
export type PackSetFilter = "pokemon" | "onepiece";

/**
 * Resolve the set id(s) whose name is "OnePiece" (case-insensitive,
 * matching the seed's exact "OnePiece" string and /cards' lowercase
 * name match). Returned as an array because nothing in the schema
 * guarantees a single OnePiece set — a future OP expansion could be its
 * own row. Cached cross-request (5 min) since the set catalog is tiny
 * and changes rarely; within a render unstable_cache also dedupes so a
 * page hitting both getPacks + getPacksListStats resolves it once.
 */
const cachedOnePieceSetIds = unstable_cache(
  async (): Promise<string[]> => {
    const db = await getDb();
    const sets = await db.sets.findMany({
      where: { name: { equals: "onepiece", mode: "insensitive" } },
      select: { id: true },
    });
    return sets.map((s) => s.id);
  },
  ["packs-onepiece-set-ids-v1"],
  { revalidate: 300, tags: ["sets"] },
);

/**
 * Build the `pack_cards` relation predicate that scopes the packs list /
 * stats to one pool. Returns `undefined` for the Pokemon default when no
 * OnePiece set exists at all (nothing to exclude → every pack is
 * Pokemon), keeping the query free of a redundant clause.
 *
 *   • onepiece → packs with ≥1 OnePiece card  (`pack_cards.some`)
 *   • pokemon  → packs with 0 OnePiece cards   (`pack_cards.none`)
 */
function buildPackSetWhere(
  set: PackSetFilter,
  onePieceSetIds: string[],
): Prisma.packsWhereInput["pack_cards"] | undefined {
  if (onePieceSetIds.length === 0) {
    // No OnePiece set in the catalog: the OnePiece tab is empty and the
    // Pokemon tab is the whole catalog (no exclusion needed).
    return set === "onepiece"
      ? { some: { card_id: { in: [] } } } // matches nothing
      : undefined;
  }
  const cardInOnePiece = { cards: { set_id: { in: onePieceSetIds } } };
  return set === "onepiece"
    ? { some: cardInOnePiece }
    : { none: cardInOnePiece };
}

export async function getPacks(params: {
  page?: number;
  perPage?: number;
  search?: string;
  active?: string;
  tag?: PackCategoryFilter;
  sortBy?: string;
  sortOrder?: string;
  set?: PackSetFilter;
}): Promise<PaginatedResult<PackListItem>> {
  const {
    page = 1,
    perPage = 20,
    search,
    active,
    tag,
    sortBy = "created_at",
    sortOrder = "desc",
    set = "pokemon",
  } = params;
  const db = await getDb();

  const where: Prisma.packsWhereInput = {};

  if (search) {
    where.OR = [
      { name: { contains: search, mode: "insensitive" } },
      { slug: { contains: search, mode: "insensitive" } },
    ];
  }

  if (active === "active") where.active = true;
  else if (active === "inactive") where.active = false;

  // Category filter (1% / 5% / 10% tag, or daily/reward pack type). Combines
  // with status + search + pool + sort — Object.assign merges the fragment's
  // top-level keys (`tags` or `pack_type`) onto the where without clobbering
  // the others.
  if (tag) Object.assign(where, buildPackCategoryWhere(tag));

  // Scope to the Pokemon / OnePiece pool via the card→set linkage.
  const onePieceSetIds = await cachedOnePieceSetIds();
  const packCardsWhere = buildPackSetWhere(set, onePieceSetIds);
  if (packCardsWhere) where.pack_cards = packCardsWhere;

  const orderBy: Prisma.packsOrderByWithRelationInput = {};
  // Whitelisted sortable columns — all first-class `packs` columns. `price`,
  // `actual_rtp` and `total_payout` were added so the rebuilt list table can
  // sort by the same economic signals it surfaces as columns (the old grid
  // exposed no sort at all, which was the #1 triage gap). Anything outside the
  // list falls back to created_at.
  const validSortFields = [
    "created_at",
    "name",
    "price",
    "total_revenue",
    "total_payout",
    "total_openings",
    "actual_rtp",
    "actual_house_edge",
  ];
  const field = validSortFields.includes(sortBy) ? sortBy : "created_at";
  const order = sortOrder === "asc" ? "asc" : "desc";
  (orderBy as Record<string, string>)[field] = order;

  // On the list view we only render a 10-card preview strip + total count.
  // Eagerly including every pack_card for every pack was pulling back 100s
  // of cards per pack × 20 packs per page. `take: 10` keeps the preview
  // working without the overfetch; total card counts come from a scoped
  // groupBy on just the visible pack IDs below.
  // The `pack_cards` parent rows themselves are unneeded — we only render
  // the related `cards` fields — so narrow the select to skip pack_cards
  // own columns from the wire payload.
  //
  // Explicit top-level `select` listing only the columns the list mapper
  // consumes — mirrors the `getCards` pattern. Switching off `findMany`'s
  // default "all columns" behaviour means a newly-added `packs` field that
  // hasn't reached the live game DB (which the website backend owns and can
  // be migration-lagged vs this admin repo's schema) cannot crash this query
  // on production with P2022. Same defense-in-depth `getCardDetail` /
  // `getCards` apply for the `cards.cost` / `cards.power` columns.
  const [packs, total] = await Promise.all([
    db.packs.findMany({
      where,
      orderBy,
      skip: (page - 1) * perPage,
      take: perPage,
      select: {
        id: true,
        name: true,
        slug: true,
        image_url: true,
        price: true,
        cards_per_open: true,
        total_openings: true,
        total_revenue: true,
        total_payout: true,
        actual_rtp: true,
        actual_house_edge: true,
        active: true,
        pack_cards: {
          select: {
            cards: { select: { id: true, name: true, image_url: true, rarity: true } },
          },
          orderBy: { order: "asc" },
          take: 10,
        },
      },
    }),
    db.packs.count({ where }),
  ]);

  // Total card counts per visible pack — cheap groupBy, but it serializes
  // after the main query because it needs the page's pack ids.
  const visiblePackIds = packs.map((p) => p.id);
  const cardCounts =
    visiblePackIds.length > 0
      ? await db.pack_cards.groupBy({
          by: ["pack_id"],
          where: { pack_id: { in: visiblePackIds } },
          _count: { _all: true },
        })
      : [];

  const totalCardsByPack = new Map(
    cardCounts.map((c) => [c.pack_id, c._count._all]),
  );

  return {
    data: packs.map((p) => ({
      id: p.id,
      name: p.name,
      slug: p.slug,
      imageUrl: p.image_url,
      priceUsd: toNumber(p.price),
      cardsPerOpen: p.cards_per_open,
      totalOpenings: Number(p.total_openings),
      totalRevenue: toNumber(p.total_revenue),
      totalPayout: toNumber(p.total_payout),
      actualRtp: toNumber(p.actual_rtp),
      actualHouseEdge: toNumber(p.actual_house_edge),
      active: p.active,
      cards: p.pack_cards.map((pc) => ({
        id: pc.cards.id,
        name: pc.cards.name,
        imageUrl: pc.cards.image_url,
        rarity: pc.cards.rarity,
      })),
      totalCardCount: totalCardsByPack.get(p.id) ?? p.pack_cards.length,
    })),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}

// ─── Tab-scoped KPI stats for the /packs page hero strip ───────────────
//
// Counts + lifetime totals shown in the hero KPI strip, scoped to the
// active Pokemon / OnePiece tab so the numbers match the grid below.
// Reads off the maintained `packs.total_openings` / `total_revenue` /
// `total_payout` columns (kept in sync by the backend pack-opening
// pipeline) so this is one round-trip instead of the 4 .count() /
// .aggregate() calls the page would otherwise fan out to.
//
// The Pokemon / OnePiece split is the same derived discriminator as
// getPacks: a pack is OnePiece when it has ≥1 card in an OnePiece set,
// Pokemon otherwise. Applied here as an EXISTS / NOT EXISTS subquery on
// pack_cards → cards.set_id.
//
// Cached cross-request (60s revalidate) so admins spamming the search
// box don't fan into the DB on every keystroke. Within a single render
// unstable_cache also deduplicates, mirroring users-list-stats.

export type PacksListStats = {
  /** Packs in the active pool regardless of `active`. */
  totalPacks: number;
  /** Packs in the active pool with `active = true`. */
  activePacks: number;
  /** Lifetime pack opens across the active pool. */
  totalOpenings: number;
  /** Lifetime revenue across the active pool (USD). */
  totalRevenue: number;
  /** Lifetime payout across the active pool (USD). */
  totalPayout: number;
  /**
   * Pool-level house edge as a percentage in House-POV. Positive →
   * we're up overall; negative → we've paid out more than we took in,
   * which renders rose in the KPI strip. Computed from totalRevenue and
   * totalPayout rather than averaging the per-pack actual_house_edge
   * column — the per-pack column weights every pack equally regardless
   * of volume, so a single un-played pack with weird numbers could
   * dominate the average.
   */
  houseEdgePct: number;
};

async function fetchPacksListStats(
  set: PackSetFilter,
  onePieceSetIds: string[],
): Promise<PacksListStats> {
  const db = await getDb();

  // Build the pool predicate as a correlated EXISTS / NOT EXISTS on
  // pack_cards → cards.set_id. When no OnePiece set exists the OnePiece
  // pool is empty (FALSE) and the Pokemon pool is the whole catalog
  // (TRUE) — mirrors buildPackSetWhere's empty-array branch.
  let poolPredicate: string;
  const queryParams: unknown[] = [];
  if (onePieceSetIds.length === 0) {
    poolPredicate = set === "onepiece" ? "FALSE" : "TRUE";
  } else {
    const existsClause = `EXISTS (
      SELECT 1 FROM pack_cards pc
      JOIN cards c ON c.id = pc.card_id
      WHERE pc.pack_id = packs.id AND c.set_id = ANY($1::uuid[])
    )`;
    poolPredicate = set === "onepiece" ? existsClause : `NOT ${existsClause}`;
    queryParams.push(onePieceSetIds);
  }

  // Single round-trip aggregate using FILTER for the count breakdown.
  // Postgres folds these into a single scan with FILTER predicates —
  // strictly cheaper than separate count calls.
  const rows = await db.$queryRawUnsafe<
    {
      total: string;
      active: string;
      openings: string;
      revenue: string;
      payout: string;
    }[]
  >(
    `
      SELECT
        COUNT(*)::text                                          AS total,
        COUNT(*) FILTER (WHERE active = true)::text             AS active,
        COALESCE(SUM(total_openings), 0)::text                  AS openings,
        COALESCE(SUM(total_revenue), 0)::text                   AS revenue,
        COALESCE(SUM(total_payout), 0)::text                    AS payout
      FROM packs
      WHERE ${poolPredicate}
    `,
    ...queryParams,
  );
  const r = rows[0];
  const totalRevenue = Number(r?.revenue ?? 0);
  const totalPayout = Number(r?.payout ?? 0);
  const houseEdgePct =
    totalRevenue > 0 ? ((totalRevenue - totalPayout) / totalRevenue) * 100 : 0;
  return {
    totalPacks: Number(r?.total ?? 0),
    activePacks: Number(r?.active ?? 0),
    totalOpenings: Number(r?.openings ?? 0),
    totalRevenue,
    totalPayout,
    houseEdgePct,
  };
}

export async function getPacksListStats(
  set: PackSetFilter = "pokemon",
): Promise<PacksListStats> {
  const onePieceSetIds = await cachedOnePieceSetIds();
  // `set` is mixed into keyParts per call: unstable_cache does NOT fold
  // function args into the cache key automatically, so a single static
  // key would let the Pokemon and OnePiece aggregates collide (the
  // first to land would serve both — the exact stale-cache bug fixed on
  // getCardsStats). The resolved OnePiece-set fingerprint is mixed in
  // too so adding/renaming an OnePiece set busts the slot.
  return unstable_cache(
    () => fetchPacksListStats(set, onePieceSetIds),
    ["packs-list-stats-v2", set, onePieceSetIds.join(",")],
    { revalidate: 60, tags: ["packs-list-stats"] },
  )();
}

export async function getPackDetail(id: string) {
  const db = await getDb();
  // Explicit top-level `select` listing only the columns the detail mapper
  // consumes. Mirrors `getCardDetail`'s defense-in-depth pattern (commit
  // dfe8af1): switching off `findUnique`'s default "all columns" behaviour
  // means a newly-added `packs` field that hasn't reached the live game DB
  // (which the website backend owns and can be migration-lagged vs this
  // admin repo's schema) cannot crash this query on production with P2022.
  // Narrow the select on cards/sets too — the page only renders a handful of
  // fields per card (name/image/rarity/price/setName) so pulling every
  // column from `cards` (and every column from `sets`) is wasted bytes.
  const pack = await db.packs.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      slug: true,
      description: true,
      image_url: true,
      price: true,
      cards_per_open: true,
      total_openings: true,
      total_revenue: true,
      total_payout: true,
      actual_rtp: true,
      actual_house_edge: true,
      active: true,
      pack_type: true,
      tags: true,
      difficulty: true,
      pack_cards: {
        select: {
          id: true,
          card_id: true,
          weight: true,
          color: true,
          animation: true,
          order: true,
          cards: {
            select: {
              name: true,
              image_url: true,
              price: true,
              rarity: true,
              sets: { select: { name: true } },
            },
          },
        },
        orderBy: { order: "asc" },
      },
    },
  });

  if (!pack) return null;

  const totalWeight = pack.pack_cards.reduce((sum, pc) => sum + pc.weight, 0);

  return {
    id: pack.id,
    name: pack.name,
    slug: pack.slug,
    description: pack.description,
    imageUrl: pack.image_url,
    priceUsd: toNumber(pack.price),
    cardsPerOpen: pack.cards_per_open,
    totalOpenings: Number(pack.total_openings),
    totalRevenue: toNumber(pack.total_revenue),
    totalPayout: toNumber(pack.total_payout),
    actualRtp: toNumber(pack.actual_rtp),
    actualHouseEdge: toNumber(pack.actual_house_edge),
    active: pack.active,
    packType: pack.pack_type,
    tags: pack.tags,
    difficulty: pack.difficulty,
    cards: pack.pack_cards.map((pc) => ({
      id: pc.id,
      cardId: pc.card_id,
      name: pc.cards.name,
      imageUrl: pc.cards.image_url,
      priceUsd: toNumber(pc.cards.price),
      rarity: pc.cards.rarity,
      setName: pc.cards.sets?.name ?? null,
      weight: pc.weight,
      probability: totalWeight > 0 ? ((pc.weight / totalWeight) * 100) : 0,
      color: pc.color,
      animation: pc.animation,
      order: pc.order,
    })),
  };
}

export type PackStats = {
  openings: { d1: number; d3: number; d7: number; d30: number; all: number };
  revenue: { d1: number; d3: number; d7: number; d30: number; all: number };
  payout: { d1: number; d3: number; d7: number; d30: number; all: number };
  rtp: number;
  houseEdge: number;
  daily: {
    date: string;
    soloOpenings: number;
    battleOpenings: number;
    borrowedOpenings: number;
    sponsoredOpenings: number;
    revenue: number;
    payout: number;
  }[];
  // Pie chart breakdown: solo vs battle, each with borrow% / sponsored% detail
  soloBreakdown: { label: string; count: number }[];
  battleBreakdown: { label: string; count: number }[];
};

/**
 * The two heavy scans behind getPackStats — the daily opening breakdown
 * and the borrow/sponsor pie breakdown. Both filter
 * `provably_fair_results` on `result_metadata->>'pack_id'`, an unindexed
 * JSON predicate that forces a full scan, so they're cached cross-request
 * (60s) keyed on the pack id. The pack-detail page re-renders on every
 * `?packTab=` toggle (URL-driven Cards/Games tabs); without this cache
 * each toggle would re-pay for both scans even though only the hidden tab
 * changed. Only the raw scan rows are cached — the cheap per-call
 * arithmetic (price × openings, RTP/edge normalisation) stays outside so
 * a price/total change reflects immediately. 60s revalidate mirrors
 * getPacksListStats; opening data is append-only so brief staleness only
 * delays the newest rows, and admin pack edits don't touch these counts.
 *
 * The DB env (prod / admin's dev toggle) is resolved OUTSIDE the cache
 * and mixed into the cache key — `cookies()` can't be read inside an
 * `unstable_cache` callback, and a single un-keyed slot would otherwise
 * pin every viewer to whichever env filled it first. Inside the callback
 * we pick the client straight from the resolved env (never re-reading the
 * cookie) so the prod and dev results stay in separate slots.
 */
const cachedPackStatScans = (packId: string, env: DbEnv) =>
  unstable_cache(
    async () => {
      const db = env === "dev" ? getDevDb() : getProdDb();
      // The single source of truth: provably_fair_results.result_metadata->>'pack_id'
      // tells us exactly which pack produced each card in both solo and battle openings.
      // Fetch the daily breakdown and the borrow/sponsor breakdown in parallel —
      // they're independent queries against the same base table.
      return Promise.all([
        db.$queryRawUnsafe<
          {
            date: Date;
            openings: string;
            solo: string;
            battle: string;
            borrowed: string;
            sponsored: string;
            payout: string;
          }[]
        >(`
      SELECT
        DATE(pf.created_at) AS date,
        COUNT(*)::text AS openings,
        COUNT(*) FILTER (WHERE pf.battle_id IS NULL)::text AS solo,
        COUNT(*) FILTER (WHERE pf.battle_id IS NOT NULL)::text AS battle,
        COUNT(*) FILTER (WHERE b.borrow_percentage > 0)::text AS borrowed,
        COUNT(*) FILTER (WHERE b.sponsorship_percentage > 0)::text AS sponsored,
        COALESCE(SUM(c.price::numeric), 0)::text AS payout
      FROM provably_fair_results pf
      LEFT JOIN cards c ON c.id = (pf.result_metadata->>'card_id')::uuid
      LEFT JOIN battles b ON b.id = pf.battle_id
      WHERE pf.result_metadata->>'pack_id' = $1
      GROUP BY DATE(pf.created_at)
      ORDER BY date
    `, packId),
        // Breakdown for pie charts: borrow% / sponsored% per mode.
        // For battles: borrow_percentage / sponsorship_percentage from battles table.
        // For solo: borrow% from ledger_transactions description (e.g. "90% borrowed").
        // result_metadata contains borrow_percentage for BOTH solo and battle results.
        // For battles, sponsorship_percentage comes from the battles table.
        db.$queryRawUnsafe<
          {
            is_battle: boolean;
            borrow_pct: number;
            sponsor_pct: number;
            count: string;
          }[]
        >(`
      SELECT
        (pf.battle_id IS NOT NULL) AS is_battle,
        CASE
          WHEN pf.battle_id IS NOT NULL THEN COALESCE(b.borrow_percentage, 0)
          ELSE COALESCE((pf.result_metadata->>'borrow_percentage')::int, 0)
        END AS borrow_pct,
        COALESCE(b.sponsorship_percentage, 0) AS sponsor_pct,
        COUNT(*)::text AS count
      FROM provably_fair_results pf
      LEFT JOIN battles b ON b.id = pf.battle_id
      WHERE pf.result_metadata->>'pack_id' = $1
      GROUP BY is_battle, borrow_pct, sponsor_pct
      ORDER BY count DESC
    `, packId),
      ]);
    },
    ["pack-stat-scans-v1", packId, env],
    { revalidate: 60, tags: ["pack-stats"] },
  );

export async function getPackStats(
  packId: string,
  packPrice: number,
  dbTotals: { totalPayout: number; actualRtp: number },
): Promise<PackStats> {
  // Resolve the env from the request cookie HERE (outside the cache), then
  // hand it to the cached scan helper so prod / dev get separate slots.
  const env = await readDbEnv();
  const [rows, breakdownRows] = await cachedPackStatScans(packId, env)();

  const now = new Date();
  const since1 = new Date(now.getTime() - 1 * MS_PER_DAY);
  const since3 = new Date(now.getTime() - 3 * MS_PER_DAY);
  const since7 = new Date(now.getTime() - 7 * MS_PER_DAY);
  const since30 = new Date(now.getTime() - 30 * MS_PER_DAY);

  const buckets = { d1: 0, d3: 0, d7: 0, d30: 0, all: 0 };
  const revBuckets = { ...buckets };
  const payBuckets = { ...buckets };

  const daily: PackStats["daily"] = [];

  for (const r of rows) {
    const dateStr = new Date(r.date).toISOString().slice(0, 10);
    const d = new Date(r.date);
    const totalOpenings = Number(r.openings);
    const soloOpenings = Number(r.solo);
    const battleOpenings = Number(r.battle);
    const borrowedOpenings = Number(r.borrowed);
    const sponsoredOpenings = Number(r.sponsored);
    const payout = parseFloat(r.payout);
    // Revenue = openings × pack price (each opening = one instance of this pack)
    const revenue = totalOpenings * packPrice;

    daily.push({
      date: dateStr,
      soloOpenings,
      battleOpenings,
      borrowedOpenings,
      sponsoredOpenings,
      revenue,
      payout,
    });

    buckets.all += totalOpenings;
    revBuckets.all += revenue;
    payBuckets.all += payout;

    if (d >= since30) {
      buckets.d30 += totalOpenings;
      revBuckets.d30 += revenue;
      payBuckets.d30 += payout;
    }
    if (d >= since7) {
      buckets.d7 += totalOpenings;
      revBuckets.d7 += revenue;
      payBuckets.d7 += payout;
    }
    if (d >= since3) {
      buckets.d3 += totalOpenings;
      revBuckets.d3 += revenue;
      payBuckets.d3 += payout;
    }
    if (d >= since1) {
      buckets.d1 += totalOpenings;
      revBuckets.d1 += revenue;
      payBuckets.d1 += payout;
    }
  }

  const totalRevenue = revBuckets.all;
  // Payout from our query is unreliable (unassigned high-value cards have no
  // inventory_item_id). Use the backend's pre-computed value instead.
  const totalPayout = dbTotals.totalPayout;
  payBuckets.all = totalPayout;
  // RTP from the backend's pre-computed value (stored as percentage, e.g. 85.85)
  const dbRtp = dbTotals.actualRtp;
  const rtp = dbRtp > 2 ? dbRtp / 100 : dbRtp; // normalize to 0-1
  const houseEdge = 1 - rtp;

  function buildBreakdown(isBattle: boolean) {
    const filtered = breakdownRows.filter((r) => r.is_battle === isBattle);
    const items: { label: string; count: number }[] = [];
    for (const r of filtered) {
      const count = Number(r.count);
      if (r.borrow_pct > 0) {
        items.push({ label: `Borrowed ${r.borrow_pct}%`, count });
      } else if (r.sponsor_pct > 0) {
        items.push({ label: `Sponsored ${r.sponsor_pct}%`, count });
      } else {
        items.push({ label: "Normal", count });
      }
    }
    // Merge same labels (e.g. multiple rows with borrow 90% from different sponsor combos)
    const merged = new Map<string, number>();
    for (const i of items) {
      merged.set(i.label, (merged.get(i.label) ?? 0) + i.count);
    }
    return [...merged.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count);
  }

  return {
    openings: buckets,
    revenue: revBuckets,
    payout: payBuckets,
    rtp,
    houseEdge,
    daily,
    soloBreakdown: buildBreakdown(false),
    battleBreakdown: buildBreakdown(true),
  };
}

export async function getPackGames(
  packId: string,
  page: number = 1,
  perPage: number = 20,
  filters?: {
    dateFrom?: string;
    dateTo?: string;
    search?: string;
    sortBy?: string;
    sortOrder?: string;
    type?: string; // "all" | "solo" | "battle"
  }
) {
  const db = await getDb();
  // Build WHERE clauses for the raw query
  const conditions: string[] = [`pf.result_metadata->>'pack_id' = $1`];
  const params: unknown[] = [packId];
  let paramIdx = 2;

  if (filters?.type === "solo") {
    conditions.push("pf.battle_id IS NULL");
  } else if (filters?.type === "battle") {
    conditions.push("pf.battle_id IS NOT NULL");
  }

  if (filters?.dateFrom) {
    conditions.push(`pf.created_at >= $${paramIdx}::timestamp`);
    params.push(new Date(filters.dateFrom));
    paramIdx++;
  }
  if (filters?.dateTo) {
    const to = new Date(filters.dateTo);
    to.setDate(to.getDate() + 1);
    conditions.push(`pf.created_at < $${paramIdx}::timestamp`);
    params.push(to);
    paramIdx++;
  }
  if (filters?.search) {
    conditions.push(`(u.username ILIKE $${paramIdx} OR u.email ILIKE $${paramIdx} OR u.id = $${paramIdx + 1})`);
    params.push(`%${filters.search}%`, filters.search);
    paramIdx += 2;
  }

  const whereClause = conditions.join(" AND ");
  const orderCol =
    filters?.sortBy === "payout"
      ? "card_price"
      : filters?.sortBy === "date"
        ? "pf.created_at"
        : "pf.created_at";
  const orderDir = filters?.sortOrder === "asc" ? "ASC" : "DESC";

  const [countResult, rows] = await Promise.all([
    db.$queryRawUnsafe<{ count: string }[]>(
      `SELECT COUNT(*)::text AS count
       FROM provably_fair_results pf
       LEFT JOIN "user" u ON u.id = (pf.result_metadata->>'user_id')
       WHERE ${whereClause}`,
      ...params,
    ),
    db.$queryRawUnsafe<
    {
      id: string;
      user_id: string | null;
      username: string | null;
      email: string | null;
      battle_id: string | null;
      card_id: string | null;
      card_name: string | null;
      card_image_url: string | null;
      card_rarity: string | null;
      card_price: string;
      is_borrowed: boolean;
      is_sponsored: boolean;
      created_at: Date;
    }[]
  >(
    `SELECT
       pf.id,
       (pf.result_metadata->>'user_id') AS user_id,
       u.username,
       u.email,
       pf.battle_id,
       c.id AS card_id,
       c.name AS card_name,
       c.image_url AS card_image_url,
       c.rarity AS card_rarity,
       COALESCE(c.price::text, '0') AS card_price,
       COALESCE(b.borrow_percentage > 0, false) AS is_borrowed,
       COALESCE(b.sponsorship_percentage > 0, false) AS is_sponsored,
       pf.created_at
     FROM provably_fair_results pf
     LEFT JOIN cards c ON c.id = (pf.result_metadata->>'card_id')::uuid
     LEFT JOIN "user" u ON u.id = (pf.result_metadata->>'user_id')
     LEFT JOIN battles b ON b.id = pf.battle_id
     WHERE ${whereClause}
     ORDER BY ${orderCol} ${orderDir}
     LIMIT ${perPage} OFFSET ${(page - 1) * perPage}`,
      ...params,
    ),
  ]);
  const total = Number(countResult[0]?.count ?? 0);

  return {
    data: rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      username: r.username,
      email: r.email,
      type: r.battle_id ? "battle" : "solo" as "battle" | "solo",
      isBorrowed: r.is_borrowed,
      isSponsored: r.is_sponsored,
      cardName: r.card_name,
      cardImageUrl: r.card_image_url,
      cardRarity: r.card_rarity,
      cardPrice: parseFloat(r.card_price),
      createdAt: r.created_at.toISOString(),
    })),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}
