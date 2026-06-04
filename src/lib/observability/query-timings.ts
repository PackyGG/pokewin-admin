/**
 * In-process query timing sampler.
 *
 * A lightweight ring buffer (1024 entries) that records how long specific
 * DB queries took to execute. Used by /system/stats to surface slowest
 * recent queries + latency percentiles without requiring an external APM.
 *
 * ⚠️ Lifetime = single Node process.
 * On Vercel serverless this is per-function-instance state, NOT shared
 * across regions, replicas, or cold starts. The UI surfaces this as
 * "sampled in the current function instance" so operators read the
 * numbers with the right context.
 *
 * Usage (opt-in per call site):
 *
 *   import { withTiming } from "@/lib/observability/query-timings";
 *
 *   const users = await withTiming("users.findMany", () =>
 *     db.user.findMany({ ... })
 *   );
 *
 * Only wrap heavy aggregates — blanket-instrumenting every query adds
 * overhead and floods the buffer with trivial entries. Treat each
 * `query` label as a stable identifier so slowest/percentile stats
 * are meaningful across runs.
 */

export type QueryTimingEntry = {
  /** Stable identifier (e.g. "dashboard.getStats", "analytics.ggr"). */
  query: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** When the query finished. ISO string so it serializes cleanly to the client. */
  at: string;
};

const RING_SIZE = 1024;

// Persist across Next.js dev HMR reloads the same way the Prisma clients do,
// so stats accumulate instead of resetting on every file change.
const globalForTimings = globalThis as unknown as {
  __queryTimingBuffer:
    | { buffer: (QueryTimingEntry | undefined)[]; head: number; count: number }
    | undefined;
};

function getState() {
  if (!globalForTimings.__queryTimingBuffer) {
    globalForTimings.__queryTimingBuffer = {
      buffer: new Array<QueryTimingEntry | undefined>(RING_SIZE),
      head: 0,
      count: 0,
    };
  }
  return globalForTimings.__queryTimingBuffer;
}

/** Record a single query timing. Safe to call from any server context. */
export function recordQueryTime(query: string, durationMs: number): void {
  const state = getState();
  state.buffer[state.head] = {
    query,
    durationMs,
    at: new Date().toISOString(),
  };
  state.head = (state.head + 1) % RING_SIZE;
  if (state.count < RING_SIZE) state.count += 1;
}

/**
 * Wrap a promise-returning function with timing instrumentation.
 *
 * Records the duration regardless of whether the inner function throws,
 * so we don't silently miss slow failed queries. Re-throws the original
 * error untouched.
 */
export async function withTiming<T>(
  query: string,
  fn: () => Promise<T>,
): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    const durationMs = performance.now() - start;
    recordQueryTime(query, durationMs);
  }
}

/**
 * Like {@link withTiming}, but RETURNS the wall-clock duration alongside the
 * result so the caller can surface it in the UI (e.g. a dashboard box's
 * bottom-right "142 ms" load-time readout) — not just record it to the ring
 * buffer.
 *
 * The duration is still recorded to the same ring buffer (so /system/stats
 * picks it up), AND measured even when the inner function throws. On a throw
 * the error is re-thrown untouched; callers that wrap the fetch in `safeQuery`
 * to degrade gracefully should time the `safeQuery` call itself (so the
 * measured ms includes the timeout-race / catch path the admin actually
 * waited on) — see the dashboard page for the canonical pattern.
 *
 * `durationMs` is a plain number, so it's safe to pass across the
 * Server → Client boundary as a prop (no function props per CLAUDE.md / Next 15).
 */
export async function withTimingResult<T>(
  query: string,
  fn: () => Promise<T>,
): Promise<{ data: T; durationMs: number }> {
  const start = performance.now();
  try {
    const data = await fn();
    return { data, durationMs: performance.now() - start };
  } finally {
    const durationMs = performance.now() - start;
    recordQueryTime(query, durationMs);
  }
}

/** Snapshot of all entries currently in the ring, oldest-first. */
function snapshot(): QueryTimingEntry[] {
  const { buffer, head, count } = getState();
  const out: QueryTimingEntry[] = [];
  if (count === 0) return out;
  // Oldest entry sits at (head - count + RING_SIZE) % RING_SIZE.
  // Walking forward `count` steps gives chronological order.
  const start = (head - count + RING_SIZE) % RING_SIZE;
  for (let i = 0; i < count; i++) {
    const entry = buffer[(start + i) % RING_SIZE];
    if (entry) out.push(entry);
  }
  return out;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  // Nearest-rank method — simple and stable for small samples.
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[idx];
}

export type QueryTimingSlowest = {
  query: string;
  durationMs: number;
  at: string;
};

export type QueryTimingAggregate = {
  query: string;
  count: number;
  meanMs: number;
  p95Ms: number;
  maxMs: number;
};

export type QueryTimingStats = {
  sampleCount: number;
  ringSize: number;
  oldestAt: string | null;
  newestAt: string | null;
  percentiles: { p50: number; p95: number; p99: number };
  slowest: QueryTimingSlowest[];
  perQuery: QueryTimingAggregate[];
};

/**
 * Summarize the current ring into slowest-N + overall percentiles + per-query
 * aggregates. Pure read — does not mutate the buffer.
 */
export function getQueryTimingStats(
  options: { slowestLimit?: number } = {},
): QueryTimingStats {
  const { slowestLimit = 10 } = options;
  const entries = snapshot();

  if (entries.length === 0) {
    return {
      sampleCount: 0,
      ringSize: RING_SIZE,
      oldestAt: null,
      newestAt: null,
      percentiles: { p50: 0, p95: 0, p99: 0 },
      slowest: [],
      perQuery: [],
    };
  }

  // Overall percentiles.
  const sortedAll = entries.map((e) => e.durationMs).sort((a, b) => a - b);
  const percentiles = {
    p50: percentile(sortedAll, 50),
    p95: percentile(sortedAll, 95),
    p99: percentile(sortedAll, 99),
  };

  // Slowest-N across the whole sample.
  const slowest = [...entries]
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, slowestLimit)
    .map((e) => ({ query: e.query, durationMs: e.durationMs, at: e.at }));

  // Per-query aggregates.
  const byQuery = new Map<string, number[]>();
  for (const e of entries) {
    const arr = byQuery.get(e.query);
    if (arr) arr.push(e.durationMs);
    else byQuery.set(e.query, [e.durationMs]);
  }
  const perQuery: QueryTimingAggregate[] = [];
  for (const [query, durations] of byQuery) {
    const sorted = [...durations].sort((a, b) => a - b);
    const sum = sorted.reduce((s, v) => s + v, 0);
    perQuery.push({
      query,
      count: sorted.length,
      meanMs: sum / sorted.length,
      p95Ms: percentile(sorted, 95),
      maxMs: sorted[sorted.length - 1],
    });
  }
  perQuery.sort((a, b) => b.meanMs - a.meanMs);

  return {
    sampleCount: entries.length,
    ringSize: RING_SIZE,
    oldestAt: entries[0].at,
    newestAt: entries[entries.length - 1].at,
    percentiles,
    slowest,
    perQuery,
  };
}
