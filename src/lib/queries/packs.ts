import { pgArrayParam } from "@/lib/drizzle-array-param";
import { unstable_cache } from "next/cache";
import { sql, type SQL } from "drizzle-orm";
import {
  readDrizzleForEnv,
  getReadDrizzleDb,
  getDevReadDrizzleDb,
  getProdReadDrizzleDb,
} from "@/lib/db";
import { readDbEnv, type DbEnv } from "@/lib/db-env";
import { toNumber } from "@/lib/utils/decimal";
import type { PaginatedResult } from "@/lib/types";
import { MS_PER_DAY } from "@/lib/utils/time";
import { getPackSetAssignmentsGrouped } from "@/lib/queries/pack-set-assignments";

type PackTag = "pct1" | "pct5" | "pct10" | "fifty50" | "onepiece";

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
): SQL {
  switch (category) {
    case "pct1":
      return sql`${"%1"}::pack_tag = ANY(p.tags)`;
    case "pct5":
      return sql`${"%5"}::pack_tag = ANY(p.tags)`;
    case "pct10":
      return sql`${"%10"}::pack_tag = ANY(p.tags)`;
    case "reward":
      return sql`p.pack_type = ${"reward"}`;
  }
}

type PackListCard = {
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
 * The pack "set" axis (a.k.a. pool tab on /packs): Pokemon / One Piece /
 * Rewards / Meme. This is a PACK-LEVEL label an admin assigns from the pack
 * editor — its OWN axis, fully independent of `pack_type`
 * (official / custom / reward / promo) and the `pack_tag` battle-odds
 * tags (%1 / %5 / %10 / 50-50 / onepiece). It has NOTHING to do with the card
 * `sets` table.
 *
 * The prod `packs` table has no column for it and is read-only, so the
 * assignment lives in the admin DB (`pack_set_assignments`, see
 * src/lib/queries/pack-set-assignments.ts). A pack with no assignment defaults
 * to Pokemon until an admin sets its set explicitly.
 */
export const PACK_POOLS = ["pokemon", "onepiece", "rewards", "meme"] as const;
export type PackSetFilter = (typeof PACK_POOLS)[number];

/** Coerce a raw `?set=` value to a known pool, defaulting to Pokemon. */
export function parsePackSet(value: string | undefined): PackSetFilter {
  return (PACK_POOLS as readonly string[]).includes(value ?? "")
    ? (value as PackSetFilter)
    : "pokemon";
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
  const db = await getReadDrizzleDb();
  const predicates: SQL[] = [];
  if (search) {
    predicates.push(sql`(p.name ILIKE ${`%${search}%`} OR p.slug ILIKE ${`%${search}%`})`);
  }
  if (active === "active") predicates.push(sql`p.active = true`);
  else if (active === "inactive") predicates.push(sql`p.active = false`);

  // Category filter (1% / 5% / 10% tag or daily/reward pack type).
  // Combines with status + search + pool + sort — Object.assign merges the
  // fragment's top-level keys (`tags` or `pack_type`) onto the where without
  // clobbering the others.
  //
  // Retired shard packs stay hidden from every catalog query.
  predicates.push(sql`p.pack_type <> ${"shard"}`);
  if (tag) predicates.push(buildPackCategoryWhere(tag));

  // Scope to the active pool (Pokemon / One Piece / Rewards / Meme). The set is
  // a PACK-LEVEL admin assignment (admin DB), not derived from cards: a pack
  // shows under the set it's assigned to; any pack WITHOUT an assignment
  // defaults to Pokemon.
  const assigned = await getPackSetAssignmentsGrouped();
  const assignedToThis = assigned.idsBySet[set] ?? [];
  if (set === "pokemon") {
    const poolOr: SQL[] = [];
    if (assignedToThis.length > 0) {
      poolOr.push(sql`p.id = ANY(${pgArrayParam(assignedToThis)}::uuid[])`);
    }
    poolOr.push(
      assigned.allIds.length > 0
        ? sql`NOT (p.id = ANY(${pgArrayParam(assigned.allIds)}::uuid[]))`
        : sql`true`,
    );
    predicates.push(sql`(${sql.join(poolOr, sql` OR `)})`);
  } else {
    predicates.push(
      assignedToThis.length > 0
        ? sql`p.id = ANY(${pgArrayParam(assignedToThis)}::uuid[])`
        : sql`false`,
    );
  }

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
  const orderColumns: Record<string, SQL> = {
    created_at: sql`p.created_at`,
    name: sql`p.name`,
    price: sql`p.price`,
    total_revenue: sql`p.total_revenue`,
    total_payout: sql`p.total_payout`,
    total_openings: sql`p.total_openings`,
    actual_rtp: sql`p.actual_rtp`,
    actual_house_edge: sql`p.actual_house_edge`,
  };
  const orderBy =
    order === "asc"
      ? sql`${orderColumns[field]} ASC`
      : sql`${orderColumns[field]} DESC`;
  const where = sql`WHERE ${sql.join(predicates, sql` AND `)}`;
  const safePage = Math.max(1, Math.trunc(page) || 1);
  const safePerPage = Math.min(200, Math.max(1, Math.trunc(perPage) || 20));

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
  // on production with 42703. Same defense-in-depth `getCardDetail` /
  // `getCards` apply for the `cards.cost` / `cards.power` columns.
  const [packResult, countResult] = await Promise.all([
    db.execute<{
      id: string;
      name: string;
      slug: string;
      image_url: string | null;
      price: string;
      cards_per_open: number;
      total_openings: string;
      total_revenue: string;
      total_payout: string;
      actual_rtp: string;
      actual_house_edge: string;
      active: boolean;
      cards: PackListCard[];
      total_card_count: string;
    }>(sql`
      SELECT p.id, p.name, p.slug, p.image_url, p.price::text AS price,
             p.cards_per_open, p.total_openings::text AS total_openings,
             p.total_revenue::text AS total_revenue,
             p.total_payout::text AS total_payout,
             p.actual_rtp::text AS actual_rtp,
             p.actual_house_edge::text AS actual_house_edge, p.active,
             COALESCE((
               SELECT jsonb_agg(jsonb_build_object(
                 'id', preview.id, 'name', preview.name,
                 'imageUrl', preview.image_url, 'rarity', preview.rarity
               ) ORDER BY preview.card_order)
               FROM (
                 SELECT c.id, c.name, c.image_url, c.rarity,
                        pc."order" AS card_order
                 FROM pack_cards pc
                 JOIN cards c ON c.id = pc.card_id
                 WHERE pc.pack_id = p.id
                 ORDER BY pc."order" ASC
                 LIMIT 10
               ) preview
             ), '[]'::jsonb) AS cards,
             (SELECT COUNT(*)::text FROM pack_cards pc
              WHERE pc.pack_id = p.id) AS total_card_count
      FROM packs p
      ${where}
      ORDER BY ${orderBy}
      LIMIT ${safePerPage} OFFSET ${(safePage - 1) * safePerPage}
    `),
    db.execute<{ count: string }>(sql`
      SELECT COUNT(*)::text AS count FROM packs p ${where}
    `),
  ]);
  const packs = packResult.rows;
  const total = Number(countResult.rows[0]?.count ?? 0);

  // Total card counts per visible pack — cheap groupBy, but it serializes
  // after the main query because it needs the page's pack ids.
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
      cards: p.cards,
      totalCardCount: Number(p.total_card_count),
    })),
    total,
    page: safePage,
    perPage: safePerPage,
    totalPages: Math.ceil(total / safePerPage),
  };
}

// ─── Tab-scoped KPI stats for the /packs page hero strip ───────────────
//
// Counts + lifetime totals shown in the hero KPI strip, scoped to the
// active set tab so the numbers match the grid below. Reads off the
// maintained `packs.total_openings` / `total_revenue` / `total_payout`
// columns (kept in sync by the backend pack-opening pipeline) so this is
// one round-trip instead of the 4 .count() / .aggregate() calls the page
// would otherwise fan out to.
//
// The pool split is the same PACK-LEVEL admin assignment as getPacks: a
// pack counts toward the set it's assigned to; any pack without an
// assignment defaults to Pokemon. Applied here as an id = ANY(...) filter
// on the admin-DB assignment lists (no card→set logic).
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
  env: DbEnv,
): Promise<PacksListStats> {
  const db = readDrizzleForEnv(env);

  // Build the pool predicate from the PACK-LEVEL admin assignments: a pack
  // counts toward the set it's assigned to; any pack without an assignment
  // defaults to Pokemon.
  const assigned = await getPackSetAssignmentsGrouped();
  const assignedToThis = assigned.idsBySet[set] ?? [];
  let poolPredicate: SQL;
  if (set === "pokemon") {
    const branches: SQL[] = [];
    if (assignedToThis.length > 0) {
      branches.push(sql`packs.id = ANY(${pgArrayParam(assignedToThis)}::uuid[])`);
    }
    // Unassigned packs default to Pokemon.
    branches.push(
      assigned.allIds.length > 0
        ? sql`NOT (packs.id = ANY(${pgArrayParam(assigned.allIds)}::uuid[]))`
        : sql`true`,
    );
    poolPredicate = sql`(${sql.join(branches, sql` OR `)})`;
  } else {
    poolPredicate =
      assignedToThis.length > 0
        ? sql`packs.id = ANY(${pgArrayParam(assignedToThis)}::uuid[])`
        : sql`false`;
  }

  // Single round-trip aggregate using FILTER for the count breakdown.
  // Postgres folds these into a single scan with FILTER predicates —
  // strictly cheaper than separate count calls.
  const result = await db.execute<{
    total: string;
    active: string;
    openings: string;
    revenue: string;
    payout: string;
  }>(sql`
      SELECT
        COUNT(*)::text                                          AS total,
        COUNT(*) FILTER (WHERE active = true)::text             AS active,
        COALESCE(SUM(total_openings), 0)::text                  AS openings,
        COALESCE(SUM(total_revenue), 0)::text                   AS revenue,
        COALESCE(SUM(total_payout), 0)::text                    AS payout
      FROM packs
      WHERE ${poolPredicate}
        AND pack_type <> ${"shard"}
  `);
  const r = result.rows[0];
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
  const env = await readDbEnv();
  if (env !== "prod") return fetchPacksListStats(set, env);
  // `set` is mixed into keyParts per call: unstable_cache does NOT fold
  // function args into the cache key automatically, so a single static
  // key would let the per-set aggregates collide (the first to land would
  // serve all — the exact stale-cache bug fixed on getCardsStats). Pack-set
  // assignment changes bust this slot via revalidateTag("packs-list-stats").
  return unstable_cache(
    () => fetchPacksListStats(set, "prod"),
    ["packs-list-stats-v5", set],
    { revalidate: 60, tags: ["packs-list-stats"] },
  )();
}

/**
 * Pack types IN SCOPE for the global re-price tool: `official` only (there is no
 * `custom` pack type — every cash pack is just a pack). EXCLUDED: `promo`,
 * and `reward` (free daily/welcome type, no real sticker price). The tool ALSO
 * only ever adjusts the pack `price`;
 * it never changes card odds. Hardcoded trusted literals (no user input) — safe
 * to interpolate into SQL.
 */
const REPRICE_INCLUDED_PACK_TYPES = ["official"] as const;

export type PackPoolComposition = {
  id: string;
  name: string;
  slug: string;
  packType: string;
  active: boolean;
  /**
   * DB `pack_tag` values as their mapped strings (`"%1"` / `"%5"` / `"%10"` /
   * `"50/50"` / `"onepiece"`) — the retune targets resolve the intended
   * hit-rate from these FIRST (name prefix as fallback).
   */
  tags: string[];
  /** Current sticker price (USD). */
  price: number;
  cardsPerOpen: number;
  /** SUM of card weights in the pool (denominator of expected card value). */
  totalWeight: number;
  /** SUM(weight × card price) across the pool (numerator). */
  weightedPriceSum: number;
  /**
   * SUM(weight × price²) across the pool — second raw moment numerator. Divide
   * by `totalWeight` to get E[price²]; combined with EV gives the per-draw
   * variance (E[price²] − EV²) of the card-value distribution.
   */
  weightedSqSum: number;
  /** SUM of weights for cards priced at or above the sticker price (a "win" draw). */
  winWeight: number;
  /**
   * SUM of weights for cards in the near-miss band: `0.5·price ≤ card < price`
   * (got close to breaking even but didn't).
   */
  nearMissWeight: number;
  /** MAX card price in the pool (the top obtainable card value). */
  maxValue: number;
  /**
   * Value of the single highest-weight card in the pool (ties broken by lowest
   * price) — the modal "floor" outcome a player most often draws.
   */
  floorValue: number;
};

/**
 * Per-pack card-pool composition needed to compute EV / house edge, in ONE
 * grouped read. Used by the global re-price dry-run (all in-scope packs) and by
 * the single-pack write action (`packIds: [id]`, which re-validates scope
 * itself). NOT cached — callers need fresh truth immediately before a write.
 *
 *   • No `packIds`  → scoped set: ACTIVE official packs with `price > 0`.
 *   • With `packIds`→ exactly those ids, UNFILTERED (the write action enforces
 *     scope server-side so it can report an out-of-scope id rather than silently
 *     returning nothing).
 *
 * LEFT JOINs so a pack with no cards still returns a row (weights → 0 → EV 0 →
 * the planner skips it). Decimals cast to text and re-parsed to dodge driver
 * precision quirks.
 */
export async function getPacksPoolComposition(opts?: {
  packIds?: string[];
}): Promise<PackPoolComposition[]> {
  const db = await getReadDrizzleDb();
  let whereClause: SQL;
  if (opts?.packIds && opts.packIds.length > 0) {
    whereClause = sql`p.id = ANY(${pgArrayParam(opts.packIds)}::uuid[])`;
  } else {
    whereClause = sql`p.pack_type = ANY(${pgArrayParam([...REPRICE_INCLUDED_PACK_TYPES])}::text[])
                      AND p.price > 0 AND p.active = true`;
  }

  const result = await db.execute<{
      id: string;
      name: string;
      slug: string;
      pack_type: string;
      active: boolean;
      tags: string[] | null;
      price: string;
      cards_per_open: number;
      total_weight: string;
      weighted_price_sum: string;
      weighted_sq_sum: string;
      win_weight: string;
      near_miss_weight: string;
      max_value: string | null;
      floor_value: string | null;
    }>(sql`
      SELECT
        p.id,
        p.name,
        p.slug,
        p.pack_type,
        p.active,
        p.tags::text[]                                  AS tags,
        p.price::text                                   AS price,
        p.cards_per_open,
        COALESCE(SUM(pc.weight), 0)::text               AS total_weight,
        COALESCE(SUM(pc.weight * c.price), 0)::text     AS weighted_price_sum,
        COALESCE(SUM(pc.weight * c.price * c.price), 0)::text AS weighted_sq_sum,
        COALESCE(SUM(pc.weight) FILTER (WHERE c.price >= p.price), 0)::text AS win_weight,
        COALESCE(
          SUM(pc.weight) FILTER (WHERE c.price >= 0.5 * p.price AND c.price < p.price),
          0
        )::text                                         AS near_miss_weight,
        MAX(c.price)::text                              AS max_value,
        (
          SELECT c2.price
          FROM pack_cards pc2
          JOIN cards c2 ON c2.id = pc2.card_id
          WHERE pc2.pack_id = p.id
          ORDER BY pc2.weight DESC, c2.price ASC
          LIMIT 1
        )::text                                         AS floor_value
      FROM packs p
      LEFT JOIN pack_cards pc ON pc.pack_id = p.id
      LEFT JOIN cards c ON c.id = pc.card_id
      WHERE ${whereClause}
      GROUP BY p.id, p.name, p.slug, p.pack_type, p.active, p.tags, p.price, p.cards_per_open
      ORDER BY p.name ASC
  `);
  const rows = result.rows;

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    packType: r.pack_type,
    active: r.active,
    tags: r.tags ?? [],
    price: Number(r.price),
    cardsPerOpen: Number(r.cards_per_open),
    totalWeight: Number(r.total_weight),
    weightedPriceSum: Number(r.weighted_price_sum),
    weightedSqSum: Number(r.weighted_sq_sum),
    winWeight: Number(r.win_weight),
    nearMissWeight: Number(r.near_miss_weight),
    maxValue: Number(r.max_value ?? 0),
    floorValue: Number(r.floor_value ?? 0),
  }));
}

export async function getPackDetail(id: string) {
  const db = await getReadDrizzleDb();
  // Explicit top-level `select` listing only the columns the detail mapper
  // consumes. Mirrors `getCardDetail`'s defense-in-depth pattern (commit
  // dfe8af1): switching off `findUnique`'s default "all columns" behaviour
  // means a newly-added `packs` field that hasn't reached the live game DB
  // (which the website backend owns and can be migration-lagged vs this
  // admin repo's schema) cannot crash this query on production with 42703.
  // Narrow the select on cards/sets too — the page only renders a handful of
  // fields per card (name/image/rarity/price/setName) so pulling every
  // column from `cards` (and every column from `sets`) is wasted bytes.
  type DetailCard = {
    id: string; cardId: string; name: string; imageUrl: string;
    price: string; rarity: string | null; setName: string | null;
    weight: number; color: string | null; animation: boolean; order: number;
  };
  const result = await db.execute<{
    id: string; name: string; slug: string; description: string | null;
    image_url: string | null; price: string; cards_per_open: number;
    updated_at: string;
    total_openings: string; total_revenue: string; total_payout: string;
    actual_rtp: string; actual_house_edge: string; active: boolean;
    pack_type: string; tags: PackTag[]; difficulty: number | null;
    cards: DetailCard[];
  }>(sql`
    SELECT p.id, p.name, p.slug, p.description, p.image_url,
           p.price::text AS price, p.cards_per_open,
           p.updated_at::text AS updated_at,
           p.total_openings::text AS total_openings,
           p.total_revenue::text AS total_revenue,
           p.total_payout::text AS total_payout,
           p.actual_rtp::text AS actual_rtp,
           p.actual_house_edge::text AS actual_house_edge,
           p.active, p.pack_type,
           ARRAY(SELECT CASE tag::text
             WHEN '%1' THEN 'pct1' WHEN '%5' THEN 'pct5'
             WHEN '%10' THEN 'pct10' WHEN '50/50' THEN 'fifty50'
             ELSE tag::text END FROM UNNEST(p.tags) AS tag) AS tags,
           p.difficulty,
           COALESCE(jsonb_agg(jsonb_build_object(
             'id', pc.id, 'cardId', pc.card_id, 'name', c.name,
             'imageUrl', c.image_url, 'price', c.price::text,
             'rarity', c.rarity, 'setName', s.name, 'weight', pc.weight,
             'color', pc.color, 'animation', pc.animation, 'order', pc."order"
           ) ORDER BY pc."order") FILTER (WHERE pc.id IS NOT NULL), '[]'::jsonb) AS cards
    FROM packs p
    LEFT JOIN pack_cards pc ON pc.pack_id = p.id
    LEFT JOIN cards c ON c.id = pc.card_id
    LEFT JOIN sets s ON s.id = c.set_id
    WHERE p.id = ${id}::uuid
      AND p.pack_type <> ${"shard"}
    GROUP BY p.id
  `);
  const pack = result.rows[0];
  if (!pack) return null;

  const totalWeight = pack.cards.reduce((sum, pc) => sum + pc.weight, 0);

  return {
    id: pack.id,
    updatedAt: pack.updated_at,
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
    cards: pack.cards.map((pc) => ({
      id: pc.id,
      cardId: pc.cardId,
      name: pc.name,
      imageUrl: pc.imageUrl,
      priceUsd: toNumber(pc.price),
      rarity: pc.rarity,
      setName: pc.setName,
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
 * `provably_fair_results` on `result_metadata->>'pack_id'`. That JSON
 * predicate IS index-served on prod: `idx_pf_result_metadata_pack_id_created_at`
 * (btree on `((result_metadata->>'pack_id'), created_at DESC)`) turns both
 * into a Bitmap Index Scan — never a seq-scan of the 3.3M+ row table
 * (read-only EXPLAIN verified on prod, 2026-07-01). They're still cached
 * cross-request (60s) keyed on the pack id because the pack-detail page
 * re-renders on every `?packTab=` toggle (URL-driven Cards/Games tabs);
 * without this cache each toggle would re-pay for both index scans even
 * though only the hidden tab changed. Only the raw scan rows are cached — the cheap per-call
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
      const db = env === "dev" ? getDevReadDrizzleDb() : getProdReadDrizzleDb();
      // The single source of truth: provably_fair_results.result_metadata->>'pack_id'
      // tells us exactly which pack produced each card in both solo and battle openings.
      // Fetch the daily breakdown and the borrow/sponsor breakdown in parallel —
      // they're independent queries against the same base table.
      return Promise.all([
        db.execute<{
            date: Date | string;
            openings: string;
            solo: string;
            battle: string;
            borrowed: string;
            sponsored: string;
            payout: string;
          }>(sql`
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
      WHERE pf.result_metadata->>'pack_id' = ${packId}
      GROUP BY DATE(pf.created_at)
      ORDER BY date
    `).then((result) => result.rows),
        // Breakdown for pie charts: borrow% / sponsored% per mode.
        // For battles: borrow_percentage / sponsorship_percentage from battles table.
        // For solo: borrow% from ledger_transactions description (e.g. "90% borrowed").
        // result_metadata contains borrow_percentage for BOTH solo and battle results.
        // For battles, sponsorship_percentage comes from the battles table.
        db.execute<{
            is_battle: boolean;
            borrow_pct: number;
            sponsor_pct: number;
            count: string;
          }>(sql`
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
      WHERE pf.result_metadata->>'pack_id' = ${packId}
      GROUP BY is_battle, borrow_pct, sponsor_pct
      ORDER BY COUNT(*) DESC
    `).then((result) => result.rows),
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
  const db = await getReadDrizzleDb();
  const conditions: SQL[] = [sql`pf.result_metadata->>'pack_id' = ${packId}`];

  if (filters?.type === "solo") {
    conditions.push(sql`pf.battle_id IS NULL`);
  } else if (filters?.type === "battle") {
    conditions.push(sql`pf.battle_id IS NOT NULL`);
  }

  if (filters?.dateFrom) {
    conditions.push(sql`pf.created_at >= ${new Date(filters.dateFrom)}::timestamp`);
  }
  if (filters?.dateTo) {
    const to = new Date(filters.dateTo);
    to.setDate(to.getDate() + 1);
    conditions.push(sql`pf.created_at < ${to}::timestamp`);
  }
  if (filters?.search) {
    // Substring match on the joined `user` (username/email) + exact id. The
    // leading-wildcard ILIKE is deliberately non-sargable, and that's fine here:
    // the HEAVY table (`provably_fair_results`, 3.3M+ rows) is still fully
    // index-served by the pack_id predicate above — read-only EXPLAIN on prod
    // (2026-07-01) shows a Bitmap Index Scan on
    // idx_pf_result_metadata_pack_id_created_at, then a hash join whose BUILD
    // side is a Seq Scan of `user`. That seq-scan is on a ~15k-row table (est.
    // ~4 matched rows), i.e. a negligible one-off filter — the query never
    // seq-scans provably_fair_results. Resolving the user id first via the
    // `lower()+text_pattern_ops` prefix indexes (idx_user_lower_username_prefix
    // / idx_user_lower_email_prefix) would only accelerate PREFIX matches, so
    // it would change these into prefix search and lose substring semantics.
    // The current shape is the planner's optimal choice for substring search.
    conditions.push(sql`(
      u.username ILIKE ${`%${filters.search}%`}
      OR u.email ILIKE ${`%${filters.search}%`}
      OR u.id = ${filters.search}
    )`);
  }

  const whereClause = sql.join(conditions, sql` AND `);
  const orderCol =
    filters?.sortBy === "payout"
      ? sql`COALESCE(c.price, 0)`
      : sql`pf.created_at`;
  const orderBy =
    filters?.sortOrder === "asc" ? sql`${orderCol} ASC` : sql`${orderCol} DESC`;
  const safePage = Math.max(1, Math.trunc(page) || 1);
  const safePerPage = Math.min(200, Math.max(1, Math.trunc(perPage) || 20));

  const [countResult, rowResult] = await Promise.all([
    db.execute<{ count: string }>(sql`
       SELECT COUNT(*)::text AS count
       FROM provably_fair_results pf
       LEFT JOIN "user" u ON u.id = (pf.result_metadata->>'user_id')
       WHERE ${whereClause}
    `),
    db.execute<{
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
      created_at: Date | string;
    }>(sql`
     SELECT
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
     ORDER BY ${orderBy}
     LIMIT ${safePerPage} OFFSET ${(safePage - 1) * safePerPage}
    `),
  ]);
  const rows = rowResult.rows;
  const total = Number(countResult.rows[0]?.count ?? 0);

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
      createdAt: new Date(r.created_at).toISOString(),
    })),
    total,
    page: safePage,
    perPage: safePerPage,
    totalPages: Math.ceil(total / safePerPage),
  };
}
