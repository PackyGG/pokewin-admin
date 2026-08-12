import { AsyncLocalStorage } from "node:async_hooks";
import { registerQueryAbortRunner } from "./query-deadline-bridge";

/**
 * Request-local cancellation for database work hidden below query helpers.
 *
 * Call sites generally cannot pass an AbortSignal through Drizzle and pg, but
 * admission control still needs to know when the UI has stopped waiting. Async
 * context carries that signal down to the MAIN read semaphore without changing
 * every query signature.
 */
const globalForQueryDeadline = globalThis as unknown as {
  queryDeadlineStorage?: AsyncLocalStorage<AbortSignal>;
};

const queryDeadlineStorage =
  globalForQueryDeadline.queryDeadlineStorage ??
  new AsyncLocalStorage<AbortSignal>();
globalForQueryDeadline.queryDeadlineStorage = queryDeadlineStorage;

export function currentQueryAbortSignal(): AbortSignal | undefined {
  return queryDeadlineStorage.getStore();
}

export function withQueryAbortSignal<T>(
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  return queryDeadlineStorage.run(signal, operation);
}

registerQueryAbortRunner(withQueryAbortSignal);
