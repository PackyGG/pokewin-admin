import "server-only";

/**
 * Shared helpers for the creator-hub backend admin-API walks.
 *
 * `pagedWalk` is the one canonical first-page-then-parallel pager that the
 * deal-history / approved-board / roster walks used to hand-roll five times
 * over. Callers keep their own caps, page sizes and `unstable_cache`
 * wrappers — sharing the RAW pager is safe; only nesting the CACHED
 * wrappers inside each other is forbidden.
 *
 * `mapPool` is the bounded-concurrency map the tips/sponsors fan-out
 * pioneered — use it for every per-creator backend fan-out so a large
 * roster can't stampede the backend admin API with unbounded parallelism.
 */

/** One page of a paged backend listing, normalized for `pagedWalk`. */
export type PagedWalkPage<TRow> = { rows: TRow[]; total: number };

/**
 * Walk a paged backend listing: fetch the first page, then the remaining
 * pages in parallel, up to `cap` rows total.
 */
export async function pagedWalk<TRow>(
  fetchPage: (offset: number, limit: number) => Promise<PagedWalkPage<TRow>>,
  cap: number,
  pageSize: number,
): Promise<TRow[]> {
  const firstPage = await fetchPage(0, pageSize);
  const all: TRow[] = [...firstPage.rows];
  const pagesNeeded = Math.min(
    Math.ceil(cap / pageSize),
    Math.ceil(firstPage.total / pageSize),
  );
  const rest: Promise<PagedWalkPage<TRow>>[] = [];
  for (let p = 1; p < pagesNeeded; p++) {
    rest.push(fetchPage(p * pageSize, pageSize));
  }
  for (const page of await Promise.all(rest)) all.push(...page.rows);
  return all;
}

/** Map `items` through `fn` with at most `concurrency` in flight at once. */
export async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await fn(items[i]!);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );
  return out;
}
