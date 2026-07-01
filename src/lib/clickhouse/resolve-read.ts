import "server-only";

import { logError } from "@/lib/errors/logger";
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
 *   • "clickhouse" → ClickHouse is the PRIMARY read path. `opts.ch()` runs
 *                    first; `opts.pg()` runs ONLY as a graceful-degradation
 *                    fallback if the ClickHouse leg throws or times out (see
 *                    "CH-failure graceful degradation" below). On a healthy CH
 *                    read, `opts.pg()` is NEVER called.
 *   • "comparison" → SERVES Postgres unchanged, then fires `opts.compare(pg)`
 *                    fire-and-forget to log drift (byte-identical to the
 *                    Phase 2B comparison wiring — the served value is the PG
 *                    value).
 *   • "off"        → SERVES Postgres unchanged; no ClickHouse work at all.
 *
 * ─── CH-failure graceful degradation (2026-07-01, incident fix) ──────────────
 *
 * PRIOR BEHAVIOR: in "clickhouse" mode a CH throw/timeout propagated straight
 * out of this resolver. Because ClickHouse-mode surfaces are the SOLE read of
 * many Server Components, a single transient CH outage/lag threw in every
 * clickhouse-mode segment at once → the route-level error boundaries (e.g.
 * `src/app/(admin)/rewards/error.tsx`, digest 3332686773) rendered the crash
 * dashboard-wide. It recovered on "Try again" once CH was healthy, which is why
 * it was intermittent and "all over".
 *
 * FIX: when CH is the SOLE serve path and it fails, we DO fall back to the real
 * Postgres implementation (`opts.pg()`) — the cent-exact source of truth the
 * cutover already treats as the parity baseline. This is graceful degradation
 * to the authoritative source, NOT the forbidden "silent workaround": it is
 * logged (see below) and it returns REAL correct data instead of crashing the
 * route. The per-surface instant-rollback lever is unchanged — the owner can
 * still force a surface back to Postgres with no deploy via Edge Config
 * (`admin-read-source:<surface>` = "off"/"comparison") or the env override.
 *
 * The trade-off (a CH failure re-runs the heavy PG aggregate for that surface,
 * the load the cutover offloads) is deliberately accepted: a slower-but-correct
 * render beats a dashboard-wide crash. When CH recovers, reads serve from CH
 * again automatically.
 *
 * CQRS BOUNDARY: this module lives under `src/lib/clickhouse/**`, so it must
 * stay Postgres-free — it imports only `getAdminReadMode` (already in the CH
 * graph) + the dependency-free `logError` helper, and takes the Postgres leg as
 * an opaque thunk supplied by the caller (a Postgres-side module). It never
 * imports `@/lib/db` / prisma / `pg`.
 *
 * The drift logger is intentionally the SAME `compareX(...)` the surface
 * already wired in Phase 2B (it gates itself on `comparison` mode, fetches its
 * own blacklist, runs the CH twin, and `logComparison`s the drift). Reusing it
 * keeps comparison-mode behavior byte-identical and avoids a second CH read.
 */
export type ResolveAdminReadOpts<T> = {
  /**
   * The canonical Postgres read. Runs in "comparison"/"off", AND as the
   * graceful-degradation fallback in "clickhouse" mode when the CH leg fails.
   */
  pg: () => Promise<T>;
  /** The ClickHouse twin. Runs in "clickhouse" mode; a throw/timeout degrades to `pg()`. */
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
    // PRIMARY path: the ClickHouse twin serves. On a CH throw/timeout we
    // gracefully degrade to the real Postgres implementation instead of letting
    // the failure crash the route's error boundary dashboard-wide. The CH
    // helper (`readonly-query.ts`) already bounds its own runtime with a
    // server-side kill + client-side AbortSignal timeout, so a CH timeout
    // surfaces here as a throw and takes this same fallback path.
    try {
      return await opts.ch();
    } catch (chErr) {
      // Make the degradation VISIBLE, not silent: one greppable structured
      // line, same redaction rules as every other query failure (name/message/
      // digest only — no SQL/params/rows).
      logError(
        `admin-read.${surfaceKey}`,
        "clickhouse read failed — degrading to Postgres source of truth",
        chErr,
      );
      // Fall back to the authoritative Postgres read. If PG ALSO fails, that
      // throw propagates to the caller's safeQuery/cache/error boundary exactly
      // as an "off"-mode PG failure would — no worse than pre-cutover behavior.
      return opts.pg();
    }
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
