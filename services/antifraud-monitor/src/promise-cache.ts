export type PromiseCacheOptions = {
  /**
   * Opt-in stale-on-error: when a refresh rejects and a previous load for the
   * same key succeeded, serve that last-good value for this many ms (cached,
   * so the failure does not trigger an upstream call storm) before the next
   * real refresh attempt. Callers that do not set this keep the original
   * behavior: rejections evict the entry and propagate to every waiter.
   */
  staleOnErrorMs?: number;
  /** Override the retained-key cap. See `DEFAULT_MAX_ENTRIES`. */
  maxEntries?: number;
};

/**
 * An expired entry is only replaced when the SAME key is requested again, so
 * without a cap a cache whose key is derived from request input retains one
 * payload per distinct key for the process lifetime — the overview cache folds
 * the caller-supplied excluded-user header into its key. Eviction is invisible
 * to callers: an evicted key simply reloads on its next request.
 */
const DEFAULT_MAX_ENTRIES = 256;

export function createPromiseCache<Key, Value>(
  load: (key: Key) => Promise<Value>,
  ttlMs: number,
  now: () => number = Date.now,
  options?: PromiseCacheOptions,
): (key: Key) => Promise<Value> {
  const entries = new Map<
    Key,
    { expiresAt: number; value: Promise<Value> }
  >();
  const lastGood = new Map<Key, Value>();
  const staleOnErrorMs = options?.staleOnErrorMs;
  const maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;

  // Both Maps iterate in insertion order, so dropping from the front after the
  // expiry sweep evicts the least recently created key first.
  function evictDown(map: Map<Key, unknown>, alsoDrop?: Map<Key, Value>): void {
    while (map.size >= maxEntries) {
      const oldest = map.keys().next();
      if (oldest.done === true) break;
      map.delete(oldest.value);
      alsoDrop?.delete(oldest.value);
    }
  }

  return (key: Key) => {
    const currentTime = now();
    const cached = entries.get(key);
    if (cached && cached.expiresAt > currentTime) return cached.value;

    const attempt = load(key);
    const value =
      staleOnErrorMs === undefined
        ? attempt
        : attempt.then(
          (result) => {
            lastGood.set(key, result);
            return result;
          },
          (error: unknown) => {
            if (!lastGood.has(key)) throw error;
            const stale = lastGood.get(key) as Value;
            // Park the stale value in the cache for the short error window so
            // concurrent callers reuse it instead of re-hitting the upstream.
            if (entries.get(key)?.value === value) {
              entries.set(key, {
                expiresAt: now() + staleOnErrorMs,
                value: Promise.resolve(stale),
              });
            }
            return stale;
          },
        );
    if (entries.size >= maxEntries) {
      for (const [existingKey, entry] of entries) {
        if (entry.expiresAt <= currentTime) {
          entries.delete(existingKey);
          lastGood.delete(existingKey);
        }
      }
      evictDown(entries, lastGood);
    }
    // `lastGood` survives a rejection that evicted its entry, so it is bounded
    // on its own rather than only alongside `entries`.
    if (lastGood.size >= maxEntries) evictDown(lastGood);
    entries.set(key, { expiresAt: currentTime + ttlMs, value });
    void value.catch(() => {
      if (entries.get(key)?.value === value) entries.delete(key);
    });
    return value;
  };
}
