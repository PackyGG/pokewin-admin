/**
 * URL pagination parsing — the ONE place `?page=` / `?perPage=` become
 * numbers safe to hand to SQL OFFSET/LIMIT.
 *
 * The pattern this replaces was `Number(params.page) || 1` /
 * `Number(params.perPage) || 20`, repeated per tab. `|| fallback` only
 * catches values that coerce to NaN or 0, which leaves three real holes:
 *
 *   • `?page=-5`      → -5 is truthy → a negative offset throws (500).
 *   • `?page=1e9`     → a billion-row OFFSET → the DB scans and discards
 *                       the whole table before returning nothing.
 *   • `?perPage=1000000` → `take: 1000000` → an authenticated user can pull
 *                       the entire table into memory and serialize it into
 *                       the RSC payload. No upper bound existed anywhere.
 *
 * Fractions (`?perPage=1.5`) are also invalid at runtime. All of
 * these are reachable by anyone who can load the page, so they are handled
 * here rather than trusted per call site.
 *
 * Every value is clamped into a sane range instead of throwing: a fuzzed or
 * stale URL should render page 1, not a 500.
 */

/** Rows per page when `?perPage=` is absent or unusable. */
export const DEFAULT_PER_PAGE = 20;

/**
 * Hard ceiling on rows per request. Above this a single admin page load
 * turns into a table dump — both a DB load problem and an RSC payload
 * problem. Chosen to sit well above the largest real page-size control in
 * the UI (100) while staying far below "the whole table".
 */
export const MAX_PER_PAGE = 200;

/**
 * Coerce a query-string value to a positive integer, or `null` if it is
 * absent, non-numeric, non-finite, fractional, or < 1.
 */
function toPositiveInt(raw: string | undefined): number | null {
  if (raw == null || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (!Number.isInteger(n)) return null;
  if (n < 1) return null;
  return n;
}

/**
 * Parse `?page=`. 1-based. Anything unusable (missing, NaN, ≤ 0,
 * fractional, Infinity) becomes page 1.
 *
 * `maxPage` bounds the OFFSET a caller can reach. It defaults to a large
 * but finite value so a fuzzed `?page=1e12` cannot turn into an OFFSET the
 * planner has to walk; real pagination never gets near it.
 */
export function parsePage(raw: string | undefined, maxPage = 100_000): number {
  const n = toPositiveInt(raw);
  if (n === null) return 1;
  return Math.min(n, maxPage);
}

/**
 * Parse `?perPage=`, clamped to `[1, MAX_PER_PAGE]`. Anything unusable
 * falls back to `fallback` (itself clamped, so a bad default can't slip a
 * huge page size through).
 */
export function parsePerPage(
  raw: string | undefined,
  fallback: number = DEFAULT_PER_PAGE,
): number {
  const safeFallback = Math.min(Math.max(1, Math.trunc(fallback)), MAX_PER_PAGE);
  const n = toPositiveInt(raw);
  if (n === null) return safeFallback;
  return Math.min(n, MAX_PER_PAGE);
}

/**
 * Both at once, for the common `params`-bag call site:
 *
 *   const { page, perPage } = parsePagination(params);
 *
 * Pass `defaultPerPage` where a surface legitimately shows a different
 * page size (e.g. an image grid at 40).
 */
export function parsePagination(
  params: { page?: string; perPage?: string },
  { defaultPerPage = DEFAULT_PER_PAGE }: { defaultPerPage?: number } = {},
): { page: number; perPage: number } {
  return {
    page: parsePage(params.page),
    perPage: parsePerPage(params.perPage, defaultPerPage),
  };
}
