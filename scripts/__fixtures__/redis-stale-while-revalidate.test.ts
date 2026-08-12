import assert from "node:assert/strict";
import test from "node:test";

import {
  staleWhileRevalidate,
  type StaleCacheEntry,
} from "../../src/lib/cache/stale-while-revalidate";

test("concurrent stale readers return immediately and share one refresh", async () => {
  const key = `test:swr:${Date.now()}:${Math.random()}`;
  let stored: StaleCacheEntry<string> = {
    value: "retained",
    refreshedAtMs: Date.now() - 60_000,
  };
  let resolveRefresh!: (value: string) => void;
  let computes = 0;
  let reads = 0;
  const refresh = new Promise<string>((resolve) => {
    resolveRefresh = resolve;
  });
  const adapter = {
    async read() {
      reads += 1;
      return stored;
    },
    async write(entry: StaleCacheEntry<string>) {
      stored = entry;
    },
  };
  const compute = () => {
    computes += 1;
    return refresh;
  };

  const readers = Promise.all(
    Array.from({ length: 25 }, () =>
      staleWhileRevalidate(key, 5, adapter, compute),
    ),
  );
  const result = await Promise.race([
    readers,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("stale readers waited for refresh")),
        100,
      ),
    ),
  ]);

  assert.deepEqual(result, Array(25).fill("retained"));
  assert.equal(reads, 1, "concurrent readers must share the cache lookup");
  assert.equal(computes, 1, "concurrent readers must share the refresh");

  resolveRefresh("fresh");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await staleWhileRevalidate(key, 5, adapter, compute), "fresh");
  assert.equal(computes, 1);
});

test("a cold miss waits for and shares exactly one computation", async () => {
  const key = `test:cold:${Date.now()}:${Math.random()}`;
  let computes = 0;
  let stored: StaleCacheEntry<number> | null = null;
  const adapter = {
    async read() {
      return stored;
    },
    async write(entry: StaleCacheEntry<number>) {
      stored = entry;
    },
  };
  const values = await Promise.all(
    Array.from({ length: 20 }, () =>
      staleWhileRevalidate(key, 5, adapter, async () => {
        computes += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return 42;
      }),
    ),
  );
  assert.deepEqual(values, Array(20).fill(42));
  assert.equal(computes, 1);
});
