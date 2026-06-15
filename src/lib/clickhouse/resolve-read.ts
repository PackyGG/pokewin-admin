import "server-only";

import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";

/**
 * The serve-path resolver for the CQRS admin-read rollout — the Phase 2F
 * cutover counterpart to the Phase 2B comparison hooks.
 *
 * A surface hands this BOTH legs as thunks (so the heavy work is deferred and
 * the loser is never run) plus an optional fire-and-forget drift logger, and
 * the resolved `getAdminReadMode(surfaceKey)` decides which leg actually
 * SERVES:
 *
 *   • "clickhouse" → ClickHouse is the SOLE read path. ONLY `opts.ch()` runs;
 *                    `opts.pg()` is NEVER called. On a ClickHouse failure this
 *                    THROWS so the caller's own cache / error boundary
 *                    (`unstable_cache` / `safeQuery` / a route error boundary)
 *                    degrades the surface — it MUST NOT silently fall back to
 *                    the heavy Postgres aggregate, which would re-overload prod
 *                    (the exact load the cutover offloads).
 *   • "comparison" → SERVES Postgres unchanged, then fires `opts.compare(pg)`
 *                    fire-and-forget to log drift (byte-identical to the
 *                    Phase 2B comparison wiring — the served value is the PG
 *                    value).
 *   • "off"        → SERVES Postgres unchanged; no ClickHouse work at all.
 *
 * CQRS BOUNDARY: this module lives under `src/lib/clickhouse/**`, so it must
 * stay Postgres-free — it imports only `getAdminReadMode` (already in the CH
 * graph) and takes the Postgres leg as an opaque thunk supplied by the caller
 * (a Postgres-side module). It never imports `@/lib/db` / prisma / `pg`.
 *
 * The drift logger is intentionally the SAME `compareX(...)` the surface
 * already wired in Phase 2B (it gates itself on `comparison` mode, fetches its
 * own blacklist, runs the CH twin, and `logComparison`s the drift). Reusing it
 * keeps comparison-mode behavior byte-identical and avoids a second CH read.
 */
export type ResolveAdminReadOpts<T> = {
  /** The canonical Postgres read. Runs in "comparison"/"off"; NEVER in "clickhouse". */
  pg: () => Promise<T>;
  /** The ClickHouse twin. Runs ONLY in "clickhouse"; throws propagate to the caller. */
  ch: () => Promise<T>;
  /**
   * Optional comparison-mode drift logger, called fire-and-forget with the
   * SERVED Postgres value (never awaited, never affects what is returned).
   * Pass the surface's existing `compareX(pgValues)` here.
   */
  compare?: (pg: T) => void;
};

export async function resolveAdminRead<T>(
  surfaceKey: string,
  opts: ResolveAdminReadOpts<T>,
): Promise<T> {
  const mode = await getAdminReadMode(surfaceKey);

  if (mode === "clickhouse") {
    // SOLE path: only the ClickHouse twin runs. A throw here is intentional —
    // the caller's cache/error boundary degrades the surface. We never call
    // opts.pg() as a fallback (no heavy-Postgres re-run on CH failure).
    return opts.ch();
  }

  // "comparison" and "off": serve Postgres, byte-identical to pre-cutover.
  const pg = await opts.pg();
  if (mode === "comparison" && opts.compare) {
    try {
      // Fire-and-forget: the served PG value is already locked in above.
      opts.compare(pg);
    } catch {
      // Drift logging must never affect the served payload.
    }
  }
  return pg;
}
