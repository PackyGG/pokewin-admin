import "server-only";

/**
 * In-process SINGLE-FLIGHT (request-coalescing) for shared cold reads.
 *
 * ─── The problem this closes ────────────────────────────────────────
 *
 * `unstable_cache` (Next.js data cache) is a CROSS-REQUEST cache, but it does
 * NOT single-flight concurrent COLD misses on one server instance. When a
 * shared heavy aggregate's cache entry expires (or was never filled) and N
 * concurrent admin requests arrive on the same warm instance, all N observe a
 * miss and all N recompute the SAME heavy Postgres aggregate at once — each
 * grabbing one of the tiny `max: 3` pool connections (see `src/lib/db.ts`).
 * That is the cache-miss stampede: a burst of identical cold callers can
 * exhaust the shared prod pool ("too many clients already") even though the
 * work only needed to run ONCE.
 *
 * React `cache()` does NOT help here either — it only dedupes WITHIN a single
 * request/render, not across the concurrent requests that make up a stampede.
 *
 * ─── What this adds (and does NOT add) ──────────────────────────────
 *
 * `singleFlight` is a PER-INSTANCE concurrency guard. While a promise for a
 * given `key` is in flight, every additional caller for that same key gets the
 * SAME promise back instead of starting its own `fn()`. When the promise
 * settles the key is deleted, so:
 *   • the next call after settle recomputes (this is NOT a cache — it holds
 *     nothing after the in-flight work finishes), and
 *   • a REJECTION is never pinned: the failed promise is removed in `.finally`,
 *     so the next caller retries cleanly rather than being handed a stale
 *     rejected promise.
 *
 * Cross-request/cross-render caching of the RESULT stays the job of
 * `unstable_cache`. Single-flight is layered strictly UNDER `unstable_cache`
 * (per-instance) and OVER the DB:
 *
 *   request ─► unstable_cache (cross-instance, holds the value for revalidate s)
 *            └► singleFlight   (per-instance, collapses concurrent cold misses)
 *               └► Postgres    (runs at most once per instance per miss)
 *
 * Together the three layers mean a cold SHARED aggregate runs at most once per
 * instance per miss: the FIRST cold caller fills `unstable_cache`, every
 * concurrent cold caller on that instance awaits the SAME single-flight
 * promise, and once filled all further callers are served by `unstable_cache`
 * with no DB hit at all.
 *
 * ─── Correct usage ──────────────────────────────────────────────────
 *
 * Wrap single-flight AROUND the `unstable_cache` call (so a burst of misses
 * shares ONE fill), NOT inside the cached callback:
 *
 *   export async function getThing(period: string): Promise<Thing> {
 *     // env/scope resolution that must run per-request stays OUTSIDE.
 *     return singleFlight(`getThing:${period}`, () => cachedThing(period));
 *   }
 *
 * The key MUST include everything that distinguishes one computation from
 * another (the function name + its window/period/env args) so different windows
 * never collapse into one another's result.
 *
 * This module is dependency-free, holds no secrets, and never caches values —
 * it only tracks in-flight promises.
 */

/**
 * Module-level in-flight map, stashed on `globalThis` so it survives dev HMR
 * reloads (the same pattern `src/lib/db.ts` / `src/lib/clickhouse/client.ts`
 * use for their singletons). In production this is a plain module singleton.
 *
 * Value type is `Promise<unknown>` because the map is heterogeneous across
 * callers; each `singleFlight<T>` call re-asserts its own `T` on the way out.
 */
const globalForSingleFlight = globalThis as unknown as {
  __singleFlightInFlight?: Map<string, Promise<unknown>>;
};

const inFlight: Map<string, Promise<unknown>> =
  globalForSingleFlight.__singleFlightInFlight ??
  (globalForSingleFlight.__singleFlightInFlight = new Map<
    string,
    Promise<unknown>
  >());

/**
 * Coalesce concurrent callers keyed by `key`.
 *
 * If a promise for `key` is already in flight, the SAME promise is returned —
 * `fn` is NOT invoked again. Otherwise `fn()` is started, its promise is stored
 * under `key`, and the key is DELETED once the promise settles (fulfilled OR
 * rejected) so failures are never pinned and the next call recomputes.
 *
 * This coalesces concurrent work WITHOUT caching the result — cross-request
 * result caching remains the job of `unstable_cache`, which this sits under.
 *
 * @param key Stable string identifying the computation. MUST include the
 *   function name + every distinguishing argument (period/env/window) so
 *   distinct computations do not collide.
 * @param fn  The (async) work to run at most once per in-flight window.
 */
export function singleFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  // Start the work, pin its promise, and unpin on settle (either outcome) so a
  // rejection is not cached and the next caller retries. `.finally` runs after
  // the promise settles but does not alter the resolved value / rejection that
  // callers await.
  const promise = fn().finally(() => {
    // Only delete if THIS promise is still the one stored — defensive against a
    // fast recompute having already replaced it (cannot happen while we hold
    // the key for the whole in-flight window, but keeps the map self-healing).
    if (inFlight.get(key) === promise) {
      inFlight.delete(key);
    }
  });

  inFlight.set(key, promise);
  return promise;
}

/**
 * Convenience wrapper: returns a function whose concurrent calls are
 * single-flighted under a key built from `keyPrefix` + JSON of the call args.
 *
 * The wrapped function's signature and return type are preserved. Args must be
 * JSON-serializable for the key to be stable and distinguishing — pass only
 * primitives / plain serializable values (the same constraint `unstable_cache`
 * keys carry).
 *
 *   const getThing = dedupe("getThing", (period: string) => cachedThing(period));
 *   await getThing("30d"); // concurrent identical calls share one computation
 *
 * @param keyPrefix Stable prefix identifying the wrapped function.
 * @param fn        The async function to coalesce per unique argument tuple.
 */
export function dedupe<A extends unknown[], T>(
  keyPrefix: string,
  fn: (...args: A) => Promise<T>,
): (...args: A) => Promise<T> {
  return (...args: A): Promise<T> =>
    singleFlight(`${keyPrefix}:${JSON.stringify(args)}`, () => fn(...args));
}
