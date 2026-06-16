import { unstable_cache } from "next/cache";
import { getDevDb, getProdDb } from "@/lib/db";
import { readDbEnv, type DbEnv } from "@/lib/db-env";
import type { PaginatedResult } from "@/lib/types";
import { Prisma } from "@/generated/prisma/client";

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
// point) so the cache callback never calls `getDb()` — which reads the
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
  const db = env === "dev" ? getDevDb() : getProdDb();

  const where: Prisma.setsWhereInput = {};

  if (search) {
    where.name = { contains: search, mode: "insensitive" };
  }

  if (series) {
    where.series = series;
  }

  const orderBy: Prisma.setsOrderByWithRelationInput = {};
  const validSortFields = ["created_at", "name", "release_date"];
  const field = validSortFields.includes(sortBy) ? sortBy : "created_at";
  const order = sortOrder === "asc" ? "asc" : "desc";
  (orderBy as Record<string, string>)[field] = order;

  const [sets, total] = await Promise.all([
    db.sets.findMany({
      where,
      orderBy,
      skip: (page - 1) * perPage,
      take: perPage,
      include: {
        _count: { select: { cards: true } },
      },
    }),
    db.sets.count({ where }),
  ]);

  return {
    data: sets.map((s) => ({
      id: s.id,
      name: s.name,
      series: s.series,
      imageUrl: s.image_url,
      language: s.language,
      tcgplayerId: s.tcgplayer_id,
      releaseDate: s.release_date?.toISOString() ?? null,
      cardCount: s._count.cards,
      createdAt: s.created_at.toISOString(),
    })),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
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
  const db = env === "dev" ? getDevDb() : getProdDb();
  const result = await db.sets.groupBy({
    by: ["series"],
    orderBy: { series: "asc" },
  });
  return result.map((r) => r.series);
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
  const db = env === "dev" ? getDevDb() : getProdDb();
  const [total, seriesGroups, totalCards] = await Promise.all([
    db.sets.count(),
    db.sets.groupBy({ by: ["series"] }),
    db.cards.count(),
  ]);

  return {
    total,
    totalSeries: seriesGroups.length,
    totalCards,
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
