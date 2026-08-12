import "server-only";

import { Redis } from "@upstash/redis";
import { singleFlight } from "./single-flight";
import { staleWhileRevalidate } from "./stale-while-revalidate";

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

/** Redis is an accelerator; it must never consume a page's database budget. */
const REDIS_OPERATION_TIMEOUT_MS = 1_000;

const REDIS_BREAKER_FAILURE_THRESHOLD = 2;
const REDIS_BREAKER_BASE_COOLDOWN_MS = 5_000;
const REDIS_BREAKER_MAX_COOLDOWN_MS = 60_000;

type RedisCircuitState = {
  consecutiveFailures: number;
  openUntilMs: number;
  probeInFlight: boolean;
  calls: number;
  failures: number;
  shortCircuits: number;
  timeouts: number;
};

const globalForRedisCircuit = globalThis as unknown as {
  adminRedisCircuit?: RedisCircuitState;
};
const redisCircuit: RedisCircuitState =
  globalForRedisCircuit.adminRedisCircuit ??
  (globalForRedisCircuit.adminRedisCircuit = {
    consecutiveFailures: 0,
    openUntilMs: 0,
    probeInFlight: false,
    calls: 0,
    failures: 0,
    shortCircuits: 0,
    timeouts: 0,
  });

class RedisCircuitOpenError extends Error {
  constructor() {
    super("Redis cache circuit is open");
    this.name = "RedisCircuitOpenError";
  }
}

class RedisOperationTimeoutError extends Error {
  constructor(operation: string) {
    super(`Redis cache ${operation} timed out`);
    this.name = "RedisOperationTimeoutError";
  }
}

async function withRedisDeadline<T>(
  operationName: string,
  operation: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  if (redisCircuit.openUntilMs > now || redisCircuit.probeInFlight) {
    redisCircuit.shortCircuits += 1;
    throw new RedisCircuitOpenError();
  }

  const isProbe =
    redisCircuit.consecutiveFailures >= REDIS_BREAKER_FAILURE_THRESHOLD;
  if (isProbe) redisCircuit.probeInFlight = true;
  redisCircuit.calls += 1;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new RedisOperationTimeoutError(operationName)),
      REDIS_OPERATION_TIMEOUT_MS,
    );
    timer.unref?.();
  });
  try {
    const result = await Promise.race([operation(), timeout]);
    redisCircuit.consecutiveFailures = 0;
    redisCircuit.openUntilMs = 0;
    return result;
  } catch (error) {
    redisCircuit.failures += 1;
    redisCircuit.consecutiveFailures += 1;
    if (error instanceof RedisOperationTimeoutError) redisCircuit.timeouts += 1;
    if (redisCircuit.consecutiveFailures >= REDIS_BREAKER_FAILURE_THRESHOLD) {
      const exponent = Math.min(
        4,
        redisCircuit.consecutiveFailures - REDIS_BREAKER_FAILURE_THRESHOLD,
      );
      redisCircuit.openUntilMs =
        Date.now() +
        Math.min(
          REDIS_BREAKER_MAX_COOLDOWN_MS,
          REDIS_BREAKER_BASE_COOLDOWN_MS * 2 ** exponent,
        );
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (isProbe) redisCircuit.probeInFlight = false;
  }
}

/** Non-sensitive process-local cache health for diagnostics. */
export function redisCacheSnapshot(): {
  state: "closed" | "open" | "half-open";
  consecutiveFailures: number;
  cooldownRemainingMs: number;
  calls: number;
  failures: number;
  shortCircuits: number;
  timeouts: number;
} {
  const cooldownRemainingMs = Math.max(
    0,
    redisCircuit.openUntilMs - Date.now(),
  );
  return {
    state:
      cooldownRemainingMs > 0
        ? "open"
        : redisCircuit.probeInFlight
          ? "half-open"
          : "closed",
    consecutiveFailures: redisCircuit.consecutiveFailures,
    cooldownRemainingMs,
    calls: redisCircuit.calls,
    failures: redisCircuit.failures,
    shortCircuits: redisCircuit.shortCircuits,
    timeouts: redisCircuit.timeouts,
  };
}

/**
 * Lazy singleton accessor. Reads the Upstash REST env on first call:
 *   • both URL + token present → construct and cache a `Redis` client.
 *   • either missing           → cache `null` (dormant) so callers degrade.
 *
 * Never throws at module load and never throws here — a malformed env that
 * makes the constructor throw is treated as "no client" (dormant).
 */
export function getRedis(): Redis | null {
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
export function isCacheEnabled(): boolean {
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
    hash = ((hash << 5) + hash + s.charCodeAt(i)) >>> 0;
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
 * Concurrent misses for one key are single-flighted per warm instance. This
 * collapses both duplicate Upstash GETs and duplicate upstream/database fills
 * without pinning a fulfilled or rejected result in process memory.
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

  return singleFlight(`redis:get-or-set:${key}`, async () => {
    // Best-effort read. Any Redis error here is swallowed so we degrade to
    // computing fresh — a cache GET failure must never surface to the caller.
    try {
      const hit = await withRedisDeadline("GET", () => r.get<T>(key));
      if (hit !== null && hit !== undefined) return hit;
    } catch {
      // Fall through to compute fresh below.
    }

    // Compute fresh. NOTE: `fn()` errors are NOT caught here — they belong to
    // the caller and must propagate so existing call-site degrade logic runs.
    const fresh = await fn();

    // Best-effort write. A failed SET must not affect the returned value.
    try {
      await withRedisDeadline("SET", () =>
        r.set(key, fresh, { ex: ttlSeconds }),
      );
    } catch {
      // Ignore — the fresh value is already computed and returned below.
    }

    return fresh;
  });
}

/**
 * Read-through cache with a last-known-good fallback.
 *
 * Values remain fresh for `freshSeconds` and are retained for
 * `staleSeconds`. Once soft-expired, one caller refreshes the value in the
 * background and every reader immediately receives the retained snapshot. If
 * the upstream read fails, the retained value is preserved instead of turning
 * a brief backend/database incident into an empty page.
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

  return staleWhileRevalidate(
    `redis:stale-read:${key}`,
    freshSeconds,
    {
      read: () =>
        withRedisDeadline("GET", () =>
          r.get<{ value: T; refreshedAtMs: number }>(key),
        ),
      write: (entry) =>
        withRedisDeadline("SET", () =>
          r.set(key, entry, { ex: staleSeconds }).then(() => undefined),
        ),
    },
    fn,
  );
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
 * Atomic fixed-window rate limiter (one Upstash Lua round trip).
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
    // One atomic server-side operation replaces INCR + conditional EXPIRE +
    // TTL (two or three REST round trips). Atomicity also closes the crash gap
    // where INCR succeeded but EXPIRE never ran, leaving a permanent counter.
    const [count, ttl] = await withRedisDeadline("RATE_LIMIT", () =>
      r.eval<[string], [number, number]>(
        "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return {n,redis.call('TTL',KEYS[1])}",
        [key],
        [String(windowSeconds)],
      ),
    );
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
export async function cacheInvalidate(key: string): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    await withRedisDeadline("DEL", () => r.del(key));
  } catch {
    // Ignore — invalidation is best-effort.
  }
}
