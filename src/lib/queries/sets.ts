import { unstable_cache } from "next/cache";
import { sql, type SQL } from "drizzle-orm";
import { readDrizzleForEnv } from "@/lib/db";
import { readDbEnv, type DbEnv } from "@/lib/db-env";
import type { PaginatedResult } from "@/lib/types";

/**
 * Cache tag for the Sets catalog reads (list + stats + series). The
 * mutations in `sets/actions.ts` (create / update / seed / force-absorb /
 * delete) call `revalidateTag(SETS_CACHE_TAG)` after writing so a
 * just-changed set / card-count is never served stale — `revalidatePath`
 * alone does NOT evict `unstable_cache` entries. Exported so the actions
 * import the exact same string (no drift between writer and reader).
 */
export const SETS_CACHE_TAG = "sets-catalog";

export type SetListItem = {
  id: string;
  name: string;
  series: string;
  imageUrl: string;
  language: string;
  tcgplayerId: number;
  releaseDate: string | null;
  cardCount: number;
  createdAt: string;
};

type GetSetsListParams = {
  page?: number;
  perPage?: number;
  search?: string;
  series?: string;
  sortBy?: string;
  sortOrder?: string;
};

// `env` is threaded in (resolved in the request scope by the public entry
// point) so the cache callback never resolves the request-scoped client, which reads the
// request cookie via `cookies()`, illegal inside `unstable_cache` — and so
// a dev-DB-toggled admin's cache entries never collide with prod. Mirrors
// `computeWithdrawals` in withdrawals.ts.
async function computeSetsList(
  env: DbEnv,
  params: GetSetsListParams,
): Promise<PaginatedResult<SetListItem>> {
  const {
    page = 1,
    perPage = 20,
    search,
    series,
    sortBy = "created_at",
    sortOrder = "desc",
  } = params;
  const db = readDrizzleForEnv(env);
  const predicates: SQL[] = [];
  if (search) predicates.push(sql`s.name ILIKE ${`%${search}%`}`);
  if (series) predicates.push(sql`s.series = ${series}`);
  const whereSql =
    predicates.length > 0
      ? sql`WHERE ${sql.join(predicates, sql` AND `)}`
      : sql``;
  const validSortFields = ["created_at", "name", "release_date"];
  const field = validSortFields.includes(sortBy) ? sortBy : "created_at";
  const order = sortOrder === "asc" ? "asc" : "desc";
  const orderBy =
    field === "name"
      ? order === "asc"
        ? sql`s.name ASC`
        : sql`s.name DESC`
      : field === "release_date"
        ? order === "asc"
          ? sql`s.release_date ASC NULLS LAST`
          : sql`s.release_date DESC NULLS LAST`
        : order === "asc"
          ? sql`s.created_at ASC`
          : sql`s.created_at DESC`;
  const safePage = Math.max(1, Math.trunc(page) || 1);
  const safePerPage = Math.min(200, Math.max(1, Math.trunc(perPage) || 20));
  const offset = (safePage - 1) * safePerPage;

  const [setsResult, totalResult] = await Promise.all([
    db.execute<{
      id: string;
      name: string;
      series: string;
      image_url: string;
      language: string;
      tcgplayer_id: number;
      release_date: Date | string | null;
      created_at: Date | string;
      card_count: string;
    }>(sql`
      SELECT
        s.id, s.name, s.series, s.image_url, s.language, s.tcgplayer_id,
        s.release_date, s.created_at, COUNT(c.id)::text AS card_count
      FROM sets s
      LEFT JOIN cards c ON c.set_id = s.id
      ${whereSql}
      GROUP BY s.id
      ORDER BY ${orderBy}
      LIMIT ${safePerPage} OFFSET ${offset}
    `),
    db.execute<{ total: string }>(sql`
      SELECT COUNT(*)::text AS total
      FROM sets s
      ${whereSql}
    `),
  ]);
  const total = Number(totalResult.rows[0]?.total ?? 0);

  return {
    data: setsResult.rows.map((s) => ({
      id: s.id,
      name: s.name,
      series: s.series,
      imageUrl: s.image_url,
      language: s.language,
      tcgplayerId: s.tcgplayer_id,
      releaseDate: s.release_date ? new Date(s.release_date).toISOString() : null,
      cardCount: Number(s.card_count),
      createdAt: new Date(s.created_at).toISOString(),
    })),
    total,
    page: safePage,
    perPage: safePerPage,
    totalPages: Math.ceil(total / safePerPage),
  };
}

/**
 * Cross-request cache for the Sets list. Wraps {@link computeSetsList} in a
 * 60s `unstable_cache` keyed on `(env, params)` so re-opening / paging /
 * repeating a filter is an instant cache hit that touches NO DB connection
 * (the per-row `_count cards` correlated count is the slow leg this caches).
 * The returned `SetListItem[]` is already plain JSON (Dates pre-serialized
 * to ISO strings) so it survives the cache's JSON round-trip cleanly.
 * Tagged so the mutations can evict it. Mirrors `cachedWithdrawals`.
 */
const cachedSetsList = unstable_cache(computeSetsList, ["sets-list-v1"], {
  revalidate: 60,
  tags: [SETS_CACHE_TAG],
});

/**
 * Public entry point. Resolves the request's DB env (the cookie read
 * happens HERE, in the request scope) then delegates to the cached fn.
 */
export async function getSetsList(
  params: GetSetsListParams,
): Promise<PaginatedResult<SetListItem>> {
  const env = await readDbEnv();
  return cachedSetsList(env, params);
}

async function computeSeriesList(env: DbEnv): Promise<string[]> {
  const db = readDrizzleForEnv(env);
  const result = await db.execute<{ series: string }>(sql`
    SELECT DISTINCT series FROM sets ORDER BY series ASC
  `);
  return result.rows.map((r) => r.series);
}

const cachedSeriesList = unstable_cache(computeSeriesList, ["sets-series-v1"], {
  revalidate: 300,
  tags: [SETS_CACHE_TAG],
});

/** Distinct series values for the toolbar filter. */
export async function getSeriesList(): Promise<string[]> {
  const env = await readDbEnv();
  return cachedSeriesList(env);
}

export type SetsStats = {
  total: number;
  totalSeries: number;
  totalCards: number;
};

async function computeSetsStats(env: DbEnv): Promise<SetsStats> {
  const db = readDrizzleForEnv(env);
  const result = await db.execute<{
    total: string;
    total_series: string;
    total_cards: string;
  }>(sql`
    SELECT
      (SELECT COUNT(*) FROM sets)::text AS total,
      (SELECT COUNT(DISTINCT series) FROM sets)::text AS total_series,
      (SELECT COUNT(*) FROM cards)::text AS total_cards
  `);
  const row = result.rows[0];

  return {
    total: Number(row?.total ?? 0),
    totalSeries: Number(row?.total_series ?? 0),
    totalCards: Number(row?.total_cards ?? 0),
  };
}

const cachedSetsStats = unstable_cache(computeSetsStats, ["sets-stats-v1"], {
  revalidate: 300,
  tags: [SETS_CACHE_TAG],
});

export async function getSetsStats(): Promise<SetsStats> {
  const env = await readDbEnv();
  return cachedSetsStats(env);
}
