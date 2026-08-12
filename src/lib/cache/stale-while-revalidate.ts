export type StaleCacheEntry<T> = {
  value: T;
  refreshedAtMs: number;
};

type StaleCacheAdapter<T> = {
  read: () => Promise<StaleCacheEntry<T> | null>;
  write: (entry: StaleCacheEntry<T>) => Promise<void>;
};

const globalForStaleCache = globalThis as unknown as {
  adminStaleCacheReads?: Map<string, Promise<unknown>>;
  adminStaleCacheRefreshes?: Map<string, Promise<unknown>>;
};
const reads =
  globalForStaleCache.adminStaleCacheReads ??
  (globalForStaleCache.adminStaleCacheReads = new Map());
const refreshes =
  globalForStaleCache.adminStaleCacheRefreshes ??
  (globalForStaleCache.adminStaleCacheRefreshes = new Map());

function coalesce<T>(
  flights: Map<string, Promise<unknown>>,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const existing = flights.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const promise = operation().finally(() => {
    if (flights.get(key) === promise) flights.delete(key);
  });
  flights.set(key, promise);
  return promise;
}

/**
 * Shared stale-while-revalidate coordinator, independent of the Redis SDK.
 *
 * All concurrent reads for a key share one cache lookup. A stale value is
 * returned immediately while exactly one refresh continues; only a cold miss
 * waits for the upstream computation. Failed refreshes preserve retained data.
 */
export function staleWhileRevalidate<T>(
  key: string,
  freshSeconds: number,
  adapter: StaleCacheAdapter<T>,
  compute: () => Promise<T>,
): Promise<T> {
  return coalesce(reads, key, async () => {
    let retained: StaleCacheEntry<T> | null = null;
    try {
      const cached = await adapter.read();
      if (
        cached &&
        typeof cached === "object" &&
        typeof cached.refreshedAtMs === "number" &&
        "value" in cached
      ) {
        retained = cached;
        const ageMs = Math.max(0, Date.now() - cached.refreshedAtMs);
        if (ageMs < freshSeconds * 1_000) return cached.value;
      }
    } catch {
      return compute();
    }

    let refresh = refreshes.get(key) as Promise<T> | undefined;
    if (!refresh) {
      refresh = (async () => {
        try {
          const value = await compute();
          try {
            await adapter.write({ value, refreshedAtMs: Date.now() });
          } catch {
            // The computed value remains usable even if cache storage fails.
          }
          return value;
        } catch (error) {
          if (retained) return retained.value;
          throw error;
        }
      })();
      refreshes.set(key, refresh);
      void refresh
        .catch(() => undefined)
        .finally(() => {
          if (refreshes.get(key) === refresh) refreshes.delete(key);
        });
    }

    return retained ? retained.value : refresh;
  });
}
