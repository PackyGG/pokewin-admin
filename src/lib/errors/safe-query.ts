import { logError } from "./logger";

/**
 * safeQuery — run a server-side query and degrade gracefully on
 * failure.
 *
 * The motivating problem: most admin pages issue 3–8 parallel queries
 * via `Promise.all([...])`. If ANY of them throws, the whole page
 * crashes — even if only one tile depended on the failing query and
 * the rest could still render. The `error.tsx` boundary catches it,
 * but the admin loses the entire view.
 *
 * `safeQuery` lets each tile own its own failure: a crashed query
 * yields the supplied fallback + an `error` string the caller can
 * choose to surface (TileErrorFallback, an inline badge, or silent
 * suppression). Working tiles render real data.
 *
 * Example — dashboard with three independent tiles:
 *
 *   const [{ data: kpi, error: kpiErr },
 *          { data: pnl,  error: pnlErr },
 *          { data: vault, error: vaultErr }] = await Promise.all([
 *     safeQuery(() => getKpiStats(), { ... }, "dashboard.kpi"),
 *     safeQuery(() => getDailyPnl(),  [],     "dashboard.pnl"),
 *     safeQuery(() => getVaultUsd(),  null,   "dashboard.vault"),
 *   ]);
 *   // Render: kpiErr ? <TileErrorFallback /> : <KpiStrip data={kpi} />
 *
 * The wrapper is OUTSIDE the query — no DB shape change, no semantic
 * change to the query itself. Per CLAUDE.md's "no query-shape changes"
 * rule, this is the right altitude for resilience: wrap, don't rewrite.
 *
 * `context` is a short dot-namespaced tag (matches the logger's `area`
 * convention) used as the log prefix when the query throws. Use the
 * same tag the corresponding TileErrorFallback would use so the log
 * line and the UI tile correspond.
 *
 * SECURITY: the `error` string returned in the result IS the raw
 * `err.message` from the query. Server pages that render this string
 * into the DOM must NOT echo it verbatim — only render the
 * `TileErrorFallback` (which shows a generic message) or a short
 * caller-controlled label. Never spread `error` into JSX content
 * without sanitization. (Server Components can't dangerouslySetInnerHTML
 * the string back to the client anyway, but copy-pasting the value into
 * an attribute or a JSON payload is the leak vector.)
 */
export type SafeQueryResult<T> =
  | { data: T; error: null }
  | { data: T; error: string };

export async function safeQuery<T>(
  fn: () => Promise<T>,
  fallback: T,
  context: string,
): Promise<SafeQueryResult<T>> {
  try {
    const data = await fn();
    return { data, error: null };
  } catch (err) {
    logError(context, "safeQuery caught", err);
    const message = err instanceof Error ? err.message : "Unknown query error";
    return { data: fallback, error: message };
  }
}

/**
 * Variant that returns `null` on failure instead of a fallback value —
 * convenient for tiles where the empty-state UI already handles
 * `data == null`. Equivalent to `safeQuery(fn, null as T | null,
 * ctx)` but with cleaner inference at call sites that don't have a
 * meaningful empty value.
 */
export async function safeQueryOrNull<T>(
  fn: () => Promise<T>,
  context: string,
): Promise<{ data: T | null; error: string | null }> {
  try {
    const data = await fn();
    return { data, error: null };
  } catch (err) {
    logError(context, "safeQueryOrNull caught", err);
    const message = err instanceof Error ? err.message : "Unknown query error";
    return { data: null, error: message };
  }
}
