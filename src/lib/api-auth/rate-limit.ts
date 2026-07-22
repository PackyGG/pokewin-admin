import "server-only";

import { buildCacheKey, rateLimit as redisRateLimit } from "@/lib/cache/redis";

/**
 * Per-key rate limiter for the `/api/v1/*` surface.
 *
 * The shared `rateLimit()` in `lib/cache/redis.ts` is Upstash-backed and FAILS
 * OPEN when Redis is dormant — correct for a cache accelerator, but it would
 * mean NO limiting at all on this surface, since Redis is dormant by default
 * in this app. So we layer a per-instance in-memory fixed-window limiter
 * underneath: Redis is authoritative (fleet-wide) when configured, and the
 * in-memory counter still bounds a single instance when it isn't.
 *
 * In-memory is intentionally a backstop, not a guarantee: on Vercel each warm
 * instance keeps its own counter, so the true ceiling is
 * `limit × warm instances`. That is strictly better than unlimited and is the
 * best available without Redis. Configure Upstash for an exact fleet-wide cap.
 */

const WINDOW_SECONDS = 60;

type Bucket = { count: number; resetAtMs: number };

// Bounded so a flood of distinct keys can't grow this without limit.
const MAX_TRACKED_KEYS = 5_000;
const memoryBuckets = new Map<string, Bucket>();

function memoryCheck(key: string, limit: number): {
  allowed: boolean;
  remaining: number;
  resetSeconds: number;
} {
  const now = Date.now();
  const existing = memoryBuckets.get(key);

  if (!existing || existing.resetAtMs <= now) {
    if (memoryBuckets.size >= MAX_TRACKED_KEYS) {
      // Cheap eviction: drop everything already expired, then (if still full)
      // the oldest-resetting entry. Keeps memory flat under key churn.
      for (const [k, v] of memoryBuckets) {
        if (v.resetAtMs <= now) memoryBuckets.delete(k);
      }
      if (memoryBuckets.size >= MAX_TRACKED_KEYS) {
        const oldest = [...memoryBuckets.entries()].sort(
          (a, b) => a[1].resetAtMs - b[1].resetAtMs,
        )[0];
        if (oldest) memoryBuckets.delete(oldest[0]);
      }
    }
    const resetAtMs = now + WINDOW_SECONDS * 1000;
    memoryBuckets.set(key, { count: 1, resetAtMs });
    return {
      allowed: limit >= 1,
      remaining: Math.max(0, limit - 1),
      resetSeconds: WINDOW_SECONDS,
    };
  }

  existing.count += 1;
  return {
    allowed: existing.count <= limit,
    remaining: Math.max(0, limit - existing.count),
    resetSeconds: Math.max(1, Math.ceil((existing.resetAtMs - now) / 1000)),
  };
}

export type ApiRateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number;
};

/**
 * Check + consume one request against `keyId`'s per-minute budget.
 * Denies if EITHER layer says no (Redis is fleet-wide; memory is per-instance).
 */
export async function checkApiRateLimit(
  keyId: string,
  limitPerMinute: number,
): Promise<ApiRateLimitResult> {
  const limit = Math.max(1, Math.floor(limitPerMinute));
  const cacheKey = buildCacheKey("ratelimit:api-v1", [keyId]);

  const redis = await redisRateLimit(cacheKey, limit, WINDOW_SECONDS);
  const memory = memoryCheck(keyId, limit);

  // Redis dormant → it returned allowed:true unconditionally; the in-memory
  // layer is then the only real limiter. When Redis IS live it's authoritative
  // for `remaining`, but a deny from either layer still denies.
  const allowed = redis.allowed && memory.allowed;
  const remaining = redis.dormant
    ? memory.remaining
    : Math.min(redis.remaining, memory.remaining);
  const resetSeconds = redis.dormant
    ? memory.resetSeconds
    : (redis.resetSeconds ?? WINDOW_SECONDS);

  return { allowed, limit, remaining, resetSeconds };
}
