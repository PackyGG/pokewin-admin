import "server-only";

import type { ExportCell, ExportSection } from "@/lib/utils/export-csv";
import { logError } from "@/lib/errors/logger";

/**
 * Per-section resilience for the Insights export gatherers.
 *
 * ─── The bug this fixes ───────────────────────────────────────────
 *
 * Every page gatherer fans its section queries out through a single
 * `await Promise.all([...])` and then builds each `ExportSection` from
 * the destructured results. `Promise.all` rejects as soon as ANY one
 * query rejects — so a single failing sub-query (a transient DB error,
 * a ledger type / table the connected DB doesn't have yet, …) makes the
 * whole gatherer throw. The export route has already flushed the UTF-8
 * BOM by the time it awaits the gather, so a thrown gather leaves the
 * client with a BOM-only file — a "fully empty CSV". The PAGES survive
 * the same failure because each wraps its query in `safeQuery`; the
 * export had no equivalent isolation.
 *
 * ─── The fix ──────────────────────────────────────────────────────
 *
 * Two layers, used together:
 *
 *   1. The gatherer awaits its queries via {@link settle} (a thin
 *      `Promise.allSettled` wrapper) instead of `Promise.all`, so one
 *      rejected query never rejects the whole batch.
 *
 *   2. Each `sections.push({...})` becomes a {@link buildSection} call.
 *      The row data is produced inside a thunk; if that thunk throws —
 *      whether because its query rejected (the value is absent) or the
 *      shape was unexpected — the section is still emitted with its
 *      name + column headers and ZERO rows, and the failure is logged.
 *      This matches `sectionsToCsv`'s contract that an empty section
 *      still writes its marker + header so the consumer sees the
 *      section existed but had no data.
 *
 * Net effect: one failing query blanks only its own section(s); every
 * other section is fully populated, and the export is never empty. This
 * hardens the export both on a stale local DB (missing enums/tables) and
 * on production (any single transient query failure).
 *
 * Read-only; server-only (logs via the server logger). Auth is enforced
 * by the route handler that invokes the gatherers.
 */

/**
 * `Promise.allSettled`, typed to preserve each element's value type. Use
 * in place of `Promise.all` at the top of a gatherer so one rejected
 * query doesn't reject the whole batch. Pair each result with
 * {@link unwrap} (or read `.value` after a status check) to get the
 * fulfilled value, or surface the rejection lazily inside a
 * {@link buildSection} thunk.
 */
export function settle<T extends readonly unknown[]>(
  promises: readonly [...{ [K in keyof T]: Promise<T[K]> }],
): Promise<{ [K in keyof T]: PromiseSettledResult<T[K]> }> {
  return Promise.allSettled(promises) as Promise<{
    [K in keyof T]: PromiseSettledResult<T[K]>;
  }>;
}

/**
 * Unwrap a settled result to its fulfilled value, or THROW the rejection
 * reason. Call this inside a {@link buildSection} thunk: the throw is
 * caught there and turned into an empty section, so unwrapping a failed
 * query degrades that one section instead of crashing the gatherer.
 */
export function unwrap<T>(result: PromiseSettledResult<T>): T {
  if (result.status === "fulfilled") return result.value;
  throw result.reason;
}

/**
 * Build one `ExportSection`, isolating its row construction. If `rows()`
 * throws (its query rejected, or the shape was unexpected), the section
 * is emitted with its `name` + `columns` and an empty row set, and the
 * error is logged under `[error:<area>]`. Never throws.
 *
 * `area` is the dot-namespaced log tag (e.g. `"insights.export.ggr"`),
 * matching the project's logger convention.
 */
export function buildSection(
  area: string,
  name: string,
  columns: string[],
  rows: () => ExportCell[][],
): ExportSection {
  try {
    return { name, columns, rows: rows() };
  } catch (err) {
    logError(area, `export section "${name}" failed — emitting empty`, err);
    return { name, columns, rows: [] };
  }
}
