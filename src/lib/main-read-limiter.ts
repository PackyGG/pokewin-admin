/**
 * Process-wide admission control for MAIN mirror reads.
 *
 * ─── The problem this solves ──────────────────────────────────────────────
 *
 * The mirror pool is deliberately bounded (see `src/lib/db.ts`) because
 * the production mirror role only has 30 sessions and shares them with the
 * Antifraud service. Individual call sites bound their own fan-out with
 * `runWithConcurrency(..., 2)`, but those gates compose MULTIPLICATIVELY: a
 * page runs 2 sections concurrently, each section awaits a `Promise.all` of 5
 * queries, and each of those calls a helper that itself fans out. One
 * `/dashboard` render can therefore demand tens of simultaneous reads from a
 * two-slot pool.
 *
 * node-postgres queues the excess internally and applies
 * `connectionTimeoutMillis` (10s) to the QUEUE WAIT, not just to the TCP
 * connect. Meanwhile `statement_timeout` is 30s, so a single slow query can
 * legitimately hold a slot three times longer than a queued reader is willing
 * to wait. The queued read then rejects with
 * `timeout exceeded when trying to connect` — which is not a
 * `QueryTimeoutError`, so `safeQuery` classifies it as a hard `error` and the
 * tile renders "Couldn't load this section". Because it is a queue race it
 * lands on a different tile each reload, which is exactly how it was reported.
 *
 * ─── The fix ─────────────────────────────────────────────────────────────
 *
 * Make readers wait in JavaScript instead of in the pool's queue. A semaphore
 * sized to the pool admits at most `max` readers at a time, so pool queue depth
 * stays at ~0 and `connectionTimeoutMillis` goes back to meaning what it says:
 * a genuine failure to establish a connection, not "the pool was busy".
 *
 * Waiting here follows the caller's deadline. `safeQuery`/`withTimeout` remove
 * a waiter when the UI has already degraded, so stale reads cannot pile up and
 * execute after a refresh. Once admitted, `statement_timeout` bounds the query
 * server-side.
 *
 * This does NOT reduce total concurrency below what the pool could serve; it
 * moves the queue somewhere that fails gracefully. It is not a substitute for
 * fixing genuinely slow queries.
 */

import { currentQueryAbortSignal } from "./query-deadline";

type Waiter = {
  resolve: () => void;
  reject: (reason: unknown) => void;
  enqueuedAtMs: number;
  signal?: AbortSignal;
  onAbort?: () => void;
};

class Semaphore {
  private active = 0;
  private readonly waiters: Waiter[] = [];
  private acquired = 0;
  private cancelled = 0;
  private waitedMs = 0;
  private peakQueue = 0;

  constructor(private readonly permits: number) {}

  /** Current number of readers waiting for a slot (telemetry). */
  get queued(): number {
    return this.waiters.length;
  }

  /** Current number of readers holding a slot (telemetry). */
  get inFlight(): number {
    return this.active;
  }

  get capacity(): number {
    return this.permits;
  }

  get telemetry(): {
    acquired: number;
    cancelled: number;
    waitedMs: number;
    peakQueue: number;
  } {
    return {
      acquired: this.acquired,
      cancelled: this.cancelled,
      waitedMs: this.waitedMs,
      peakQueue: this.peakQueue,
    };
  }

  private async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw signal.reason;
    if (this.active < this.permits) {
      this.active += 1;
      this.acquired += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        signal,
        enqueuedAtMs: Date.now(),
      };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) this.waiters.splice(index, 1);
          this.cancelled += 1;
          this.waitedMs += Date.now() - waiter.enqueuedAtMs;
          reject(signal.reason);
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
      this.peakQueue = Math.max(this.peakQueue, this.waiters.length);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (!next) {
      this.active -= 1;
      return;
    }
    // Resolve on a microtask so a synchronous throw in one caller cannot
    // unwind through an unrelated waiter's continuation. Keep `active`
    // unchanged while handing the permit directly to the next waiter; this
    // prevents a new arrival from stealing the free slot before the microtask.
    if (next.signal && next.onAbort) {
      next.signal.removeEventListener("abort", next.onAbort);
    }
    queueMicrotask(() => {
      if (next.signal?.aborted) {
        this.cancelled += 1;
        this.waitedMs += Date.now() - next.enqueuedAtMs;
        next.reject(next.signal.reason);
        // The handoff target expired during the microtask gap. Pass the same
        // permit onward (or decrement `active`) instead of stranding capacity.
        this.release();
      } else {
        this.acquired += 1;
        this.waitedMs += Date.now() - next.enqueuedAtMs;
        next.resolve();
      }
    });
  }

  async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.lease(signal);
    try {
      return await operation();
    } finally {
      // MUST be in `finally`: a rejected read that never released its permit
      // would permanently shrink the limiter and eventually deadlock every
      // MAIN read in the isolate.
      release();
    }
  }

  async lease(signal?: AbortSignal): Promise<() => void> {
    await this.acquire(signal);
    let returned = false;
    return () => {
      if (returned) return;
      returned = true;
      this.release();
    };
  }
}

/**
 * One limiter per (environment, pool) pair, cached on `globalThis` so every
 * module instance in a serverless isolate shares the same admission control.
 * A per-module limiter would defeat the entire purpose.
 */
const globalForLimiter = globalThis as unknown as {
  mainReadLimiters?: Map<string, Semaphore>;
};

const limiters: Map<string, Semaphore> =
  globalForLimiter.mainReadLimiters ?? new Map<string, Semaphore>();
globalForLimiter.mainReadLimiters = limiters;

function limiterFor(key: string, permits: number): Semaphore {
  const existing = limiters.get(key);
  if (existing) {
    if (existing.capacity !== permits) {
      throw new Error(
        `MAIN read limiter ${key} already has capacity ${existing.capacity}, not ${permits}`,
      );
    }
    return existing;
  }
  const created = new Semaphore(permits);
  limiters.set(key, created);
  return created;
}

/**
 * Acquire a checkout-sized lease from the MAIN mirror admission limiter.
 *
 * Pool wrappers need the permit to outlive acquisition and remain held until
 * `client.release()`. Returning an idempotent release function avoids the old
 * "promise that deliberately never settles" handshake and, critically, lets
 * a deadline rejection propagate to `pool.connect()` instead of becoming an
 * unhandled rejection behind an unresolved admission promise.
 */
export function acquireDatabaseSlot(
  key: string,
  permits: number,
  signal: AbortSignal | undefined = currentQueryAbortSignal(),
): Promise<() => void> {
  return limiterFor(key, permits).lease(signal);
}

export const acquireMainReadSlot = acquireDatabaseSlot;

/**
 * Run a MAIN mirror read under process-wide admission control.
 *
 * `permits` must match the pool's `max` so the limiter admits exactly as many
 * readers as the pool can serve without queueing. When the surrounding query
 * deadline expires while queued, its waiter is removed and `operation` is
 * never started.
 */
export async function withMainReadSlot<T>(
  key: string,
  permits: number,
  operation: () => Promise<T>,
): Promise<T> {
  return limiterFor(key, permits).run(operation, currentQueryAbortSignal());
}

type DatabaseLimiterMetrics = {
  inFlight: number;
  queued: number;
  capacity: number;
  acquired: number;
  cancelled: number;
  waitedMs: number;
  peakQueue: number;
};

/** Safe, non-sensitive snapshot for health/telemetry surfaces. */
export function databaseLimiterSnapshot(): Record<
  string,
  DatabaseLimiterMetrics
> {
  const snapshot: Record<string, DatabaseLimiterMetrics> = {};
  for (const [key, semaphore] of limiters) {
    snapshot[key] = {
      inFlight: semaphore.inFlight,
      queued: semaphore.queued,
      capacity: semaphore.capacity,
      ...semaphore.telemetry,
    };
  }
  return snapshot;
}

export const mainReadLimiterSnapshot = databaseLimiterSnapshot;
