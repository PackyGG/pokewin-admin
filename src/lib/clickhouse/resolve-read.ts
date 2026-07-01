import "server-only";

import { logError } from "@/lib/errors/logger";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";

/**
 * ─── Per-process ClickHouse circuit breaker (2026-07-01, incident fix) ───────
 *
 * WHY: the graceful-degradation fallback below is correct but not free. During a
 * real ClickHouse OUTAGE (CH down / unreachable / lagging past its abort), EVERY
 * `clickhouse`-mode request first pays the full CH per-query timeout
 * (`DEFAULT_CH_TIMEOUT_MS`, now 8s) before falling back to Postgres. Under load,
 * a whole wave of admin requests each burns that 8s on a doomed CH attempt and
 * only THEN piles onto the (max:3) Postgres pool — the exact thundering-herd the
 * broader incident fix targets.
 *
 * WHAT: a lightweight, per-PROCESS breaker (module-level state, pinned on
 * globalThis so it survives dev HMR / module re-eval within one process). It is
 * GLOBAL, not per-surface: when CH is unhealthy it is unhealthy for everyone, so
 * a shared failure signal trips faster and recovers together. While the breaker
 * is OPEN, `clickhouse`-mode reads SKIP the CH attempt entirely and serve
 * Postgres directly (the cron/warm-kept cache-warm path) — no 8s CH wait per
 * request.
 *
 * WHY IT IS SAFE (worst case == "CH temporarily off"):
 *   • The breaker ONLY ever changes what happens in `clickhouse` mode, and ONLY
 *     ever decides "attempt CH" vs "skip CH → serve Postgres". Skipping CH is
 *     byte-identical to the existing CH-failure degradation path (serve the
 *     authoritative Postgres read). So the WORST the breaker can do is behave as
 *     if that surface were flipped to "off" for a short cooldown — real, correct
 *     data, just from Postgres. It can never serve wrong/stale/empty data and
 *     never throws on its own.
 *   • It NEVER touches "off"/"comparison" modes — those paths are untouched.
 *   • Happy path is UNCHANGED: when CH is healthy the breaker stays CLOSED, so
 *     `shouldSkipClickHouse()` returns false and the control flow is identical to
 *     the pre-breaker code (attempt CH, serve it).
 *   • Bias toward CLOSED (attempt CH) on any doubt: the breaker only opens after
 *     `BREAKER_FAILURE_THRESHOLD` CONSECUTIVE failures, opens for a SHORT
 *     cooldown, and after the cooldown lets requests attempt CH again (a single
 *     success closes it). A one-off CH blip never trips it.
 *   • Postgres-free: this file lives under `src/lib/clickhouse/**`, so the
 *     breaker imports nothing new — it uses only `Date.now()` and a plain
 *     counter. It NEVER imports `@/lib/db` / prisma / `pg`.
 */

/** Consecutive CH failures required to OPEN the breaker (bias toward attempting CH). */
const BREAKER_FAILURE_THRESHOLD = 3;
/** How long the breaker stays OPEN (skips CH) once tripped, in ms. */
const BREAKER_COOLDOWN_MS = 25_000;

type ChBreakerState = {
  /** Consecutive CH failures since the last success. */
  consecutiveFailures: number;
  /** Epoch ms until which the breaker is OPEN (skip CH). 0 = closed. */
  openUntil: number;
};

// Pin the breaker state on globalThis so it is a single per-process instance
// that survives dev HMR / module re-evaluation (a fresh module copy would reset
// an in-module `let`, defeating the breaker across recompiles).
const BREAKER_KEY = "__adminChCircuitBreaker__" as const;
type BreakerGlobal = typeof globalThis & {
  [BREAKER_KEY]?: ChBreakerState;
};

function breaker(): ChBreakerState {
  const g = globalThis as BreakerGlobal;
  if (!g[BREAKER_KEY]) {
    g[BREAKER_KEY] = { consecutiveFailures: 0, openUntil: 0 };
  }
  return g[BREAKER_KEY];
}

/**
 * True when the breaker is OPEN — i.e. CH has failed `BREAKER_FAILURE_THRESHOLD`
 * times in a row recently AND we are still inside the cooldown window. When
 * true, callers skip the CH attempt and serve Postgres directly. Errs toward
 * CLOSED: outside the cooldown (or below threshold) this returns false so CH is
 * attempted again.
 */
function shouldSkipClickHouse(): boolean {
  const b = breaker();
  return b.openUntil > Date.now();
}

/** Record a successful CH read — resets the counter and CLOSES the breaker. */
function recordClickHouseSuccess(): void {
  const b = breaker();
  b.consecutiveFailures = 0;
  b.openUntil = 0;
}

/**
 * Record a failed CH read — increments the consecutive-failure counter and, once
 * it reaches the threshold, OPENS the breaker for the cooldown window. Returns
 * whether this failure just tripped the breaker (for a single greppable log).
 */
function recordClickHouseFailure(): boolean {
  const b = breaker();
  b.consecutiveFailures += 1;
  if (b.consecutiveFailures >= BREAKER_FAILURE_THRESHOLD) {
    const wasClosed = b.openUntil <= Date.now();
    b.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
    return wasClosed;
  }
  return false;
}

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
    // CIRCUIT BREAKER: if CH has been failing consecutively and we're inside the
    // cooldown window, skip the CH attempt entirely and serve Postgres directly
    // — do NOT pay the CH per-query timeout on every request during an outage.
    // This is byte-identical in outcome to the CH-failure degradation below
    // (serve the authoritative Postgres read), just without first burning the
    // CH wall-clock. Errs toward attempting CH: outside the cooldown this is
    // false, so CH is retried and a single success re-closes the breaker.
    if (shouldSkipClickHouse()) {
      return opts.pg();
    }

    // PRIMARY path: the ClickHouse twin serves. On a CH throw/timeout we
    // gracefully degrade to the real Postgres implementation instead of letting
    // the failure crash the route's error boundary dashboard-wide. The CH
    // helper (`readonly-query.ts`) already bounds its own runtime with a
    // server-side kill + client-side AbortSignal timeout, so a CH timeout
    // surfaces here as a throw and takes this same fallback path.
    try {
      const value = await opts.ch();
      // A healthy CH read resets the failure counter + closes the breaker.
      recordClickHouseSuccess();
      return value;
    } catch (chErr) {
      // Feed the breaker: past the consecutive-failure threshold this OPENs it
      // so subsequent requests short-circuit to Postgres for the cooldown.
      const justTripped = recordClickHouseFailure();
      // Make the degradation VISIBLE, not silent: one greppable structured
      // line, same redaction rules as every other query failure (name/message/
      // digest only — no SQL/params/rows).
      logError(
        `admin-read.${surfaceKey}`,
        justTripped
          ? "clickhouse read failed — circuit breaker OPEN, skipping ClickHouse for cooldown; degrading to Postgres source of truth"
          : "clickhouse read failed — degrading to Postgres source of truth",
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
