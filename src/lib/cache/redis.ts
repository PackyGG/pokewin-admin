import "server-only";

import { Redis } from "@upstash/redis";

/**
 * Upstash-backed shared cache primitive — DORMANT BY DEFAULT.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * GRACEFUL-DEGRADE CONTRACT (the whole point of this module)
 * ─────────────────────────────────────────────────────────────────────────
 * This layer is a pure, optional read-through accelerator in front of slow /
 * rate-limited work (today: the creator-backend roster + session fan-outs
 * that return HTTP 429 under concurrent admin load — see
 * `creator-backend-cache.ts`).
 *
 * It MUST be impossible for this module to change behavior or throw to a
 * caller when it is dormant or when Redis misbehaves:
 *
 *   • NO env configured (no KV_REST_API_URL/_TOKEN or UPSTASH_REDIS_REST_URL/_TOKEN)
 *     → `getRedis()` returns `null` and `cacheGetOrSet` calls the wrapped
 *       function directly. The caller sees EXACTLY today's behavior: same
 *       data, same order, same pagination, same numbers.
 *   • ANY Redis error (network, auth, serialization, timeout, parse) on get
 *     OR set → swallowed; the code falls through to compute fresh via the
 *     wrapped function. A cache miss/error can NEVER bubble to a caller and
 *     can NEVER alter the result.
 *
 * Because of that contract this module never throws at import time and never
 * throws from any exported function on account of Redis.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SAFETY: this NEVER talks to the prod Redis
 * ─────────────────────────────────────────────────────────────────────────
 * Upstash is a SEPARATE, dedicated instance reached over its REST API. This
 * module only ever constructs a client from the dedicated Upstash REST creds
 * (KV_REST_API_URL/_TOKEN as injected by the Vercel Upstash integration, or
 * UPSTASH_REDIS_REST_URL/_TOKEN). It does NOT read the app's `REDIS_URL` /
 * `KV_URL` (TCP) / prod Redis connection and performs only cache GET/SET/DEL
 * against the dedicated Upstash instance — never any prod-Redis or prod-DB write. The prod game DB
 * and prod Redis remain strictly off-limits / read-only; nothing here touches
 * them.
 */

// Lazily-resolved singleton. `undefined` = not yet resolved; `null` = resolved
// to "no client" (env absent) and cached so we don't re-check every call.
let resolvedClient: Redis | null | undefined;

/**
 * Lazy singleton accessor. Reads the Upstash REST env on first call:
 *   • both URL + token present → construct and cache a `Redis` client.
 *   • either missing           → cache `null` (dormant) so callers degrade.
 *
 * Never throws at module load and never throws here — a malformed env that
 * makes the constructor throw is treated as "no client" (dormant).
 */
function getRedis(): Redis | null {
  if (resolvedClient !== undefined) return resolvedClient;

  // The Vercel "Upstash for Redis" Marketplace integration injects the
  // Vercel-KV REST names (KV_REST_API_URL / KV_REST_API_TOKEN); a native
  // Upstash setup uses UPSTASH_REDIS_REST_URL / _TOKEN. Accept either — KV
  // names first, since that's what our Vercel integration provisions. We
  // deliberately do NOT read REDIS_URL / KV_URL: those are TCP endpoints, while
  // the @upstash/redis SDK speaks the dedicated REST API via url + token only.
  const url = (
    process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL
  )?.trim();
  const token = (
    process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN
  )?.trim();

  if (!url || !token) {
    resolvedClient = null;
    return resolvedClient;
  }

  try {
    resolvedClient = new Redis({ url, token });
  } catch {
    // A bad URL/token shape must not break callers — stay dormant.
    resolvedClient = null;
  }
  return resolvedClient;
}

/** True only when a usable Upstash client is configured. */
function isCacheEnabled(): boolean {
  return getRedis() !== null;
}

/**
 * djb2 string hash → unsigned base-36. Used to keep cache keys short when a
 * key part is long (e.g. a sorted blacklist join). Not cryptographic — only a
 * compact, stable digest for key namespacing.
 */
export function hashString(s: string): string {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    // hash * 33 + charCode, kept in 32-bit unsigned range via `>>> 0`.
    hash = (((hash << 5) + hash) + s.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

/**
 * Build a namespaced cache key as `adm:family:part:part:...`.
 * All admin-cache keys share the `adm:` prefix so the dedicated Upstash
 * instance can be scoped/flushed by prefix if ever needed. Hash long parts
 * with {@link hashString} before passing them in to keep keys bounded.
 */
export function buildCacheKey(
  family: string,
  parts: Array<string | number>,
): string {
  return ["adm", family, ...parts.map((p) => String(p))].join(":");
}

/**
 * Read-through cache: return the cached value for `key`, else compute it via
 * `fn`, best-effort store it with a `ttlSeconds` TTL, and return the fresh
 * value.
 *
 * GRACEFUL DEGRADE (hard guarantees):
 *   • No client (dormant)        → returns `await fn()` directly, no Redis I/O.
 *   • Redis GET throws           → swallowed; falls through to compute `fn()`.
 *   • Cache miss (null/undefined)→ compute `fn()`, then best-effort SET.
 *   • Redis SET throws           → swallowed; the fresh value is still returned.
 *
 * The function ALWAYS resolves to the `fn()` result on every Redis failure and
 * MUST NOT reject because of Redis. The only way this rejects is if `fn()`
 * itself rejects — that error is the caller's own (e.g. a backend
 * `BackendApiError`) and is intentionally propagated so existing
 * degrade-on-backend-error logic at the call site keeps working unchanged.
 *
 * SINGLE-FLIGHT NOTE: this is a plain get-or-set with no in-flight
 * de-duplication, so a burst of concurrent misses for the same key can each
 * compute `fn()` once (a brief thundering-herd) before the value is cached.
 * That is acceptable for v1 — the wrapped work already tolerates concurrency
 * (its own bounded fan-out + 429 retry), and TTLs are short. A future version
 * could add a promise map or a short SET-NX lock if herd pressure shows up.
 */
export async function cacheGetOrSet<T>(
  key: string,
  ttlSeconds: number,
  fn: () => Promise<T>,
): Promise<T> {
  const r = getRedis();
  if (!r) {
    // Dormant: pure pass-through, identical to not having this layer at all.
    return fn();
  }

  // Best-effort read. Any Redis error here is swallowed so we degrade to
  // computing fresh — a cache GET failure must never surface to the caller.
  try {
    const hit = await r.get<T>(key);
    if (hit !== null && hit !== undefined) return hit;
  } catch {
    // Fall through to compute fresh below.
  }

  // Compute fresh. NOTE: `fn()` errors are NOT caught here — they belong to
  // the caller and must propagate so existing call-site degrade logic runs.
  const fresh = await fn();

  // Best-effort write. A failed SET must not affect the returned value.
  try {
    await r.set(key, fresh, { ex: ttlSeconds });
  } catch {
    // Ignore — the fresh value is already computed and returned below.
  }

  return fresh;
}

type StaleCacheEntry<T> = {
  value: T;
  refreshedAtMs: number;
};

const staleRefreshes = new Map<string, Promise<unknown>>();

/**
 * Read-through cache with a last-known-good fallback.
 *
 * Values remain fresh for `freshSeconds` and are retained for
 * `staleSeconds`. Once soft-expired, one caller refreshes the value. If the
 * upstream read fails, the retained value is returned instead of turning a
 * brief backend/database incident into an empty page.
 */
export async function cacheGetOrSetStale<T>(
  key: string,
  freshSeconds: number,
  staleSeconds: number,
  fn: () => Promise<T>,
): Promise<T> {
  if (staleSeconds <= freshSeconds) {
    throw new Error("staleSeconds must be greater than freshSeconds");
  }

  const r = getRedis();
  if (!r) return fn();

  let retained: StaleCacheEntry<T> | null = null;
  try {
    const cached = await r.get<StaleCacheEntry<T>>(key);
    if (
      cached &&
      typeof cached === "object" &&
      typeof cached.refreshedAtMs === "number" &&
      "value" in cached
    ) {
      retained = cached;
      if (Date.now() - cached.refreshedAtMs < freshSeconds * 1000) {
        return cached.value;
      }
    }
  } catch {
    return fn();
  }

  const existing = staleRefreshes.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const refresh = (async () => {
    try {
      const value = await fn();
      const entry: StaleCacheEntry<T> = {
        value,
        refreshedAtMs: Date.now(),
      };
      try {
        await r.set(key, entry, { ex: staleSeconds });
      } catch {
        // The fresh upstream result is still valid.
      }
      return value;
    } catch (error) {
      if (retained) {
        console.warn(
          `[cache] serving retained value after refresh failure key=${key}`,
          error,
        );
        return retained.value;
      }
      throw error;
    }
  })();

  staleRefreshes.set(key, refresh);
  try {
    return await refresh;
  } finally {
    staleRefreshes.delete(key);
  }
}

export type RateLimitResult = {
  /** Whether the call is permitted under the limit. */
  allowed: boolean;
  /** Configured ceiling for the window. */
  limit: number;
  /** Remaining calls in the current window (>= 0). */
  remaining: number;
  /** Seconds until the window resets, or null when unknown/dormant. */
  resetSeconds: number | null;
  /** True when no Redis is configured, so no limiting was applied. */
  dormant: boolean;
};

/**
 * Fixed-window rate limiter (Upstash INCR + EXPIRE).
 *
 * GRACEFUL DEGRADE (same contract as the rest of this module): when Redis is
 * dormant OR any Redis call throws, this FAILS OPEN — it returns `allowed:true`
 * so behavior is identical to not having a limiter (local dev / unconfigured
 * never blocks). It is therefore safe to gate a handler with this without
 * risking a false 429 outage if Upstash is down.
 *
 *   const rl = await rateLimit(buildCacheKey("ratelimit:export", [adminId]), 5, 60);
 *   if (!rl.allowed) return new Response("Too many requests", { status: 429 });
 *
 * @param key            namespaced limiter key (use buildCacheKey)
 * @param limit          max calls allowed per window
 * @param windowSeconds  window length in seconds
 */
export async function rateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const r = getRedis();
  if (!r) {
    return {
      allowed: true,
      limit,
      remaining: limit,
      resetSeconds: null,
      dormant: true,
    };
  }

  try {
    const count = await r.incr(key);
    // First hit in this window: start the TTL. (If EXPIRE races/fails the key
    // simply persists; a stuck counter would only over-restrict, but the
    // catch below fails open on any throw.)
    if (count === 1) {
      await r.expire(key, windowSeconds);
    }
    const ttl = await r.ttl(key);
    return {
      allowed: count <= limit,
      limit,
      remaining: Math.max(0, limit - count),
      resetSeconds: ttl >= 0 ? ttl : windowSeconds,
      dormant: false,
    };
  } catch {
    // Fail open — a limiter outage must never take down the gated handler.
    return {
      allowed: true,
      limit,
      remaining: limit,
      resetSeconds: null,
      dormant: false,
    };
  }
}

/**
 * Best-effort delete of a single cache key. No-op when dormant; any Redis
 * error is swallowed. Safe to call from mutation paths that want to bust a
 * cached entry without risking a throw.
 */
async function cacheInvalidate(key: string): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    await r.del(key);
  } catch {
    // Ignore — invalidation is best-effort.
  }
}
