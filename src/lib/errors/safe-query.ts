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
 *
 * TIMEOUT: a plain `try/catch` only catches a query that THROWS — it does
 * NOT catch one that is merely SLOW. A genuinely slow query (e.g. an
 * unbounded lifetime scan) blocks the awaiting segment until Postgres
 * returns or the platform kills the whole request, so it never degrades
 * to a fallback tile. Pass `timeoutMs` to either wrapper to bound the
 * wait: once it elapses the wrapper resolves to the same fallback shape a
 * throw would (with a `[timeout]`-prefixed error string), and the tile
 * degrades instead of hanging the segment. The underlying DB statement
 * is NOT cancelled (Postgres keeps running it to completion on its own
 * connection) — the timeout only stops US waiting on it; the next cache
 * fill picks up the warmed result. Use {@link withTimeout} directly when
 * you want the race without the surrounding `safeQuery` catch.
 */
/**
 * Discriminates WHY a wrapped query degraded:
 *   • "timeout" — the `timeoutMs` race fired (the query was merely SLOW;
 *     it may still complete on its own connection and warm a cache).
 *   • "error"   — the query THREW (a hard failure: bad SQL, missing
 *     table/enum label, connection error, …).
 *
 * Band UIs use this to render truthful copy: "taking too long — refresh
 * to retry" for a timeout vs "failed to load" for a hard error. Before
 * this existed, hard 22P02 failures were misattributed on-screen as
 * "metrics taking too long".
 */
export type SafeQueryFailureKind = "timeout" | "error";

// `kind` is OPTIONAL on the type (purely additive — fixtures/tests that
// hand-construct results stay valid) but ALWAYS set by `safeQuery` /
// `safeQueryOrNull`, so live call sites can rely on it.
export type SafeQueryResult<T> =
  | { data: T; error: null; kind?: null }
  | { data: T; error: string; kind?: SafeQueryFailureKind };

/**
 * Default statement-timeout (ms) for the heaviest reward-insights queries
 * (rakeback ROI lifetime forward scan; deposit-bonus Impact's 7-query
 * batch). Long enough that a healthy query on prod-sized data finishes
 * well inside it, short enough that a pathological scan degrades to the
 * fallback tile instead of hanging the segment until the platform kills
 * the request. Callers pass this as the `timeoutMs` arg to {@link safeQuery}
 * / {@link safeQueryOrNull}.
 */
export const REWARD_QUERY_TIMEOUT_MS = 15_000;

/** Sentinel a timed-out race rejects with so we can label it distinctly. */
class QueryTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Query exceeded ${timeoutMs}ms statement timeout`);
    this.name = "QueryTimeoutError";
  }
}

export function isQueryTimeoutError(err: unknown): err is QueryTimeoutError {
  return err instanceof QueryTimeoutError;
}

/**
 * Race a promise-returning query against a wall-clock timeout. Resolves
 * with the query's value if it settles first; rejects with a
 * {@link QueryTimeoutError} if `timeoutMs` elapses first.
 *
 * The timer is always cleared (success OR failure) so a fast query never
 * leaves a dangling `setTimeout` holding the event loop. NOTE this does
 * not abort the query itself — it only stops the caller awaiting it.
 */
export async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new QueryTimeoutError(timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function safeQuery<T>(
  fn: () => Promise<T>,
  fallback: T,
  context: string,
  timeoutMs?: number,
): Promise<SafeQueryResult<T>> {
  try {
    const data =
      timeoutMs != null ? await withTimeout(fn, timeoutMs) : await fn();
    return { data, error: null, kind: null };
  } catch (err) {
    if (isQueryTimeoutError(err)) {
      logError(context, "safeQuery timed out", err);
      return { data: fallback, error: err.message, kind: "timeout" };
    }
    logError(context, "safeQuery caught", err);
    const message = err instanceof Error ? err.message : "Unknown query error";
    return { data: fallback, error: message, kind: "error" };
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
  timeoutMs?: number,
): Promise<{
  data: T | null;
  error: string | null;
  kind?: SafeQueryFailureKind | null;
}> {
  try {
    const data =
      timeoutMs != null ? await withTimeout(fn, timeoutMs) : await fn();
    return { data, error: null, kind: null };
  } catch (err) {
    if (isQueryTimeoutError(err)) {
      logError(context, "safeQueryOrNull timed out", err);
      return { data: null, error: err.message, kind: "timeout" };
    }
    logError(context, "safeQueryOrNull caught", err);
    const message = err instanceof Error ? err.message : "Unknown query error";
    return { data: null, error: message, kind: "error" };
  }
}
