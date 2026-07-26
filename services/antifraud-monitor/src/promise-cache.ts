export function createPromiseCache<Key, Value>(
  load: (key: Key) => Promise<Value>,
  ttlMs: number,
  now: () => number = Date.now,
): (key: Key) => Promise<Value> {
  const entries = new Map<
    Key,
    { expiresAt: number; value: Promise<Value> }
  >();

  return (key: Key) => {
    const currentTime = now();
    const cached = entries.get(key);
    if (cached && cached.expiresAt > currentTime) return cached.value;

    const value = load(key);
    entries.set(key, { expiresAt: currentTime + ttlMs, value });
    void value.catch(() => {
      if (entries.get(key)?.value === value) entries.delete(key);
    });
    return value;
  };
}
