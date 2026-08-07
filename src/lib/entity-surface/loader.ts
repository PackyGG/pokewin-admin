import { unstable_cache } from "next/cache";
import { safeQuery, type SafeQueryResult } from "@/lib/errors/safe-query";

/**
 * ──────────────────────────────────────────────────────────────────────────
 *  Entity-surface loader helpers  (pokewin-admin · src/lib/entity-surface)
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Server-side helpers for the shared `/packs` + `/cards` rebuild. They encode
 * the data-loading rules from CLAUDE.md so every list/detail surface follows
 * the same shape instead of re-deriving it:
 *
 *   1. ACTIVE-VIEW-ONLY: load the PRIMARY data for the visible view first; the
 *      SECONDARY data (charts, hidden tabs, dialog option lists) loads behind
 *      its own boundary and never blocks first paint. {@link loadPrimary} /
 *      {@link loadSecondary} make that split explicit and keep each piece's
 *      failure isolated via `safeQuery`.
 *   2. CACHE WHERE SAFE: {@link cachedList} wraps a read-only aggregate/list in
 *      `unstable_cache` keyed on its parsed params, so paginating/searching
 *      doesn't recompute a stable KPI strip. NEVER cache anything that depends
 *      on the caller's identity/permissions.
 *   3. BOUND THE WAIT: every wrapper takes a `timeoutMs` so a pathological scan
 *      degrades to a fallback tile instead of hanging the segment.
 *
 * These are thin, additive composition helpers — they do NOT change any query
 * shape. Existing queries (`getPacks`, `getCards`, …) are passed in as the
 * `fn`; the helper only governs caching, timeout and failure isolation.
 *
 * Server-only (imports `next/cache`). Import from Server Components / server
 * query modules, never from a Client Component.
 */

/** Default timeout for a primary list query — generous, since the list is the
 * thing the operator is waiting on, but still bounded so it can't hang. */
export const PRIMARY_QUERY_TIMEOUT_MS = 12_000;

/** Shorter timeout for secondary/deferred data (charts, option lists). If a
 * below-the-fold scan is slow we'd rather show its fallback than make the
 * operator wait. */
export const SECONDARY_QUERY_TIMEOUT_MS = 10_000;

/**
 * Run the PRIMARY query for the active view. Resolves to a {@link SafeQueryResult}
 * so the caller renders real data or an inline error/empty — the page never
 * crashes on a single query failure. Bounded by `timeoutMs`.
 *
 *   const { data, error } = await loadPrimary(
 *     () => getPacks(params), { data: [], total: 0, page: 1, perPage, totalPages: 0 },
 *     "packs.list",
 *   );
 */
export function loadPrimary<T>(
  fn: () => Promise<T>,
  fallback: T,
  context: string,
  timeoutMs: number = PRIMARY_QUERY_TIMEOUT_MS,
): Promise<SafeQueryResult<T>> {
  return safeQuery(fn, fallback, context, timeoutMs);
}

/**
 * Run a SECONDARY / deferred query (a below-the-fold chart, a hidden tab's
 * feed, a dialog's option list). Same isolation as {@link loadPrimary} but with
 * the shorter secondary timeout by default. Call this INSIDE the lazy Suspense
 * boundary for the deferred region — never alongside the primary fetch.
 */
export function loadSecondary<T>(
  fn: () => Promise<T>,
  fallback: T,
  context: string,
  timeoutMs: number = SECONDARY_QUERY_TIMEOUT_MS,
): Promise<SafeQueryResult<T>> {
  return safeQuery(fn, fallback, context, timeoutMs);
}

/**
 * Wrap a read-only, identity-independent query in `unstable_cache` keyed on a
 * stable parts array. Use for KPI strips / aggregates that stay stable across
 * pagination + search refinements (mirrors `getPacksListStats` /
 * `getCardsStats`). Returns a zero-arg function you then feed to
 * {@link loadPrimary}/{@link loadSecondary} for timeout + failure isolation.
 *
 *   const stats = await loadPrimary(
 *     cachedList(() => getPacksListStats(set), ["packs.kpi", set], 60),
 *     EMPTY_STATS, "packs.kpi",
 *   );
 *
 * SECURITY: only cache queries whose result does not depend on the current
 * admin's permissions or any per-request secret. The cache is shared across
 * all callers — a permission-scoped result would leak across admins.
 */
export function cachedList<T>(
  fn: () => Promise<T>,
  keyParts: readonly string[],
  revalidateSeconds = 60,
): () => Promise<T> {
  // `unstable_cache` requires a serializable key. We pass the parts as both the
  // function-identity keyParts AND fold them into the tag list so two different
  // param sets never collide on the same cache entry.
  return unstable_cache(fn, [...keyParts], {
    revalidate: revalidateSeconds,
    tags: [...keyParts],
  });
}

// ─── URL search-param parsing ───────────────────────────────────────────────

/**
 * Normalize a Next.js `searchParams` record into the typed list-query params
 * every operational list surface shares. Centralizes the `Number(x) || default`
 * + sort-whitelist + perPage-clamp logic each `page.tsx` repeats.
 *
 * - `page` is at least 1.
 * - `perPage` falls back to `defaultPerPage` and is clamped to `allowedPerPage`
 *   so a hand-edited `?perPage=99999` can't ship an unbounded payload.
 * - `sortBy` is validated against `allowedSortFields`; an unknown value falls
 *   back to `defaultSortBy` (defence in depth — the queries already whitelist,
 *   but parsing here keeps the URL honest and the boundary key stable).
 */
export type ListQueryParams = {
  page: number;
  perPage: number;
  search?: string;
  sortBy?: string;
  sortOrder: "asc" | "desc";
};

export function parseListParams(
  params: Record<string, string | undefined>,
  {
    defaultPerPage = 20,
    allowedPerPage = [10, 20, 50, 100, 200],
    allowedSortFields,
    defaultSortBy,
    defaultSortOrder = "desc",
  }: {
    defaultPerPage?: number;
    allowedPerPage?: readonly number[];
    allowedSortFields?: readonly string[];
    defaultSortBy?: string;
    defaultSortOrder?: "asc" | "desc";
  } = {},
): ListQueryParams {
  const page = Math.max(1, Number(params.page) || 1);

  const rawPerPage = Number(params.perPage) || defaultPerPage;
  const perPage = allowedPerPage.includes(rawPerPage)
    ? rawPerPage
    : defaultPerPage;

  const search = params.search?.trim() || undefined;

  let sortBy = defaultSortBy;
  if (params.sortBy) {
    if (!allowedSortFields || allowedSortFields.includes(params.sortBy)) {
      sortBy = params.sortBy;
    }
  }

  const sortOrder: "asc" | "desc" =
    params.sortOrder === "asc"
      ? "asc"
      : params.sortOrder === "desc"
        ? "desc"
        : defaultSortOrder;

  return { page, perPage, search, sortBy, sortOrder };
}

/**
 * Build a stable Suspense boundary key from the params that should re-trigger
 * the loading fallback when they change (the lazy-tab / period-swap pattern the
 * Insights pages use). Order is preserved; `undefined`/`null` render as empty.
 *
 *   key={boundaryKey([set, page, perPage, search, sortBy, sortOrder])}
 */
export function boundaryKey(
  parts: ReadonlyArray<string | number | boolean | null | undefined>,
): string {
  return parts.map((p) => (p == null ? "" : String(p))).join("|");
}
