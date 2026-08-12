/**
 * Client-safe bridge for the server-only query deadline context.
 *
 * `safe-query` is also used around server actions from a small number of
 * Client Components, so it cannot import `node:async_hooks` directly. The
 * MAIN database layer registers its AsyncLocalStorage runner here when it is
 * loaded on the server. In a browser (or for a query that does not touch
 * MAIN), the operation simply runs without a database-admission signal.
 */
type QueryAbortRunner = (
  signal: AbortSignal,
  operation: () => Promise<unknown>,
) => Promise<unknown>;

const QUERY_ABORT_RUNNER = Symbol.for("pokewin.queryAbortRunner");

type QueryDeadlineGlobals = typeof globalThis & {
  [QUERY_ABORT_RUNNER]?: QueryAbortRunner;
};

export function registerQueryAbortRunner(runner: QueryAbortRunner): void {
  (globalThis as QueryDeadlineGlobals)[QUERY_ABORT_RUNNER] = runner;
}

export function withRegisteredQueryAbortSignal<T>(
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  const runner = (globalThis as QueryDeadlineGlobals)[QUERY_ABORT_RUNNER];
  if (!runner) return operation();
  return runner(signal, operation) as Promise<T>;
}
