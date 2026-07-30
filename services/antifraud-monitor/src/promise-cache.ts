export type PromiseCacheOptions = {
  /**
   * Opt-in stale-on-error: when a refresh rejects and a previous load for the
   * same key succeeded, serve that last-good value for this many ms (cached,
   * so the failure does not trigger an upstream call storm) before the next
   * real refresh attempt. Callers that do not set this keep the original
   * behavior: rejections evict the entry and propagate to every waiter.
   */
  staleOnErrorMs?: number;
};

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
    entries.set(key, { expiresAt: currentTime + ttlMs, value });
    void value.catch(() => {
      if (entries.get(key)?.value === value) entries.delete(key);
    });
    return value;
  };
}
