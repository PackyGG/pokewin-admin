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
  const parent = queryDeadlineStorage.getStore();
  // Safe-query wrappers can be nested (a page budget around a helper that owns
  // a narrower leg budget). Replacing the outer signal lets the inner timeout
  // accidentally outlive its caller. Compose them so whichever deadline fires
  // first removes queued database work and tears down active read-only work.
  const effectiveSignal = parent ? AbortSignal.any([parent, signal]) : signal;
  return queryDeadlineStorage.run(effectiveSignal, operation);
}

registerQueryAbortRunner(withQueryAbortSignal);
