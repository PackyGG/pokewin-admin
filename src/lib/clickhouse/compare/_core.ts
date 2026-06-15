import "server-only";

/**
 * Shared drift primitives for the CQRS comparison-mode rollout.
 *
 * These are the engine-agnostic building blocks every per-surface compare
 * module reuses: a drift record type, the drift computation (money fields pass
 * within half a cent; counts must be exact), the structured drift logger, and a
 * timing wrapper for the ClickHouse leg. They never throw, so wiring them into a
 * render path is safe (fire-and-forget).
 */

export type FieldDrift = {
  field: string;
  pg: number;
  ch: number;
  absDrift: number;
  pctDrift: number | null;
  /** Money fields pass within half a cent; counts must be exact. */
  ok: boolean;
};

export function computeDrift(
  pg: Record<string, number>,
  ch: Record<string, number>,
  moneyFields: readonly string[] = [],
): FieldDrift[] {
  return Object.keys(pg).map((field) => {
    const p = pg[field] ?? 0;
    const c = ch[field] ?? 0;
    const absDrift = Math.abs(p - c);
    const pctDrift = p !== 0 ? (absDrift / Math.abs(p)) * 100 : c === 0 ? 0 : null;
    const ok = moneyFields.includes(field) ? absDrift < 0.005 : absDrift === 0;
    return { field, pg: p, ch: c, absDrift, pctDrift, ok };
  });
}

export function logComparison(
  label: string,
  drift: FieldDrift[],
  durationMs?: number,
): void {
  const summary = drift
    .map((d) => `${d.field}: pg=${d.pg} ch=${d.ch} Δ=${d.absDrift.toFixed(4)}`)
    .join(" | ");
  // `duration_ms` shares the failure-line convention so timing is greppable
  // across every observability surface; present on BOTH the OK and DRIFT
  // branches.
  const timing = durationMs != null ? ` duration_ms=${durationMs}` : "";
  const failing = drift.filter((d) => !d.ok);
  if (failing.length === 0) {
    console.log(`[ch-compare] ${label} OK${timing} — ${summary}`);
  } else {
    console.warn(
      `[ch-compare] ${label} DRIFT ${failing.length}/${drift.length}${timing} — ${summary}`,
    );
  }
}

/**
 * Time the ClickHouse leg of a comparison so `logComparison` can carry a
 * `duration_ms`. Returns the awaited result plus the elapsed wall-clock ms.
 */
export async function timeCh<T>(fn: () => Promise<T>): Promise<{ result: T; durationMs: number }> {
  const startedAt = Date.now();
  const result = await fn();
  return { result, durationMs: Date.now() - startedAt };
}
