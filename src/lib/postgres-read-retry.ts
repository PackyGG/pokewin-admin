import { logWarn } from "@/lib/errors/logger";

type TransientReadRetryOptions = {
  context: string;
  maxAttempts?: number;
  delayMs?: number;
  signal?: AbortSignal;
};

const TRANSIENT_POSTGRES_READ_ERROR =
  /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|57P01|57P02|57P03|57P05|08(?:000|001|003|004|006|007|P01))\b|connection (?:terminated|timeout|closed|reset)|terminating connection|server closed the connection|database system is (?:starting up|shutting down)/i;

function errorChainText(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current = error;

  for (let depth = 0; depth < 5 && current != null; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);

    if (typeof current === "string") {
      parts.push(current);
      break;
    }
    if (typeof current !== "object") break;

    try {
      const message = Reflect.get(current, "message");
      if (typeof message === "string") parts.push(message);
    } catch {
      // A hostile/custom error getter must not break failure handling.
    }
    try {
      const code = Reflect.get(current, "code");
      if (typeof code === "string") parts.push(code);
    } catch {
      // Same defensive boundary as message above.
    }
    try {
      current = Reflect.get(current, "cause");
    } catch {
      break;
    }
  }

  return parts.join(" ");
}

export function isTransientPostgresReadError(error: unknown): boolean {
  return TRANSIENT_POSTGRES_READ_ERROR.test(errorChainText(error));
}

/**
 * Retry a confirmed read-only PostgreSQL operation once when establishing or
 * retaining the connection failed. SQL/schema/permission errors and capacity
 * failures (53300 / too many clients) are never retried: a second connection
 * attempt during role exhaustion amplifies the outage instead of healing it.
 * Callers must not use this helper for mutations.
 */
export async function withTransientPostgresReadRetry<T>(
  operation: () => Promise<T>,
  options: TransientReadRetryOptions,
): Promise<T> {
  const maxAttempts = Math.max(1, Math.trunc(options.maxAttempts ?? 2));
  const delayMs = Math.max(0, Math.trunc(options.delayMs ?? 150));

  for (let attempt = 1; ; attempt += 1) {
    options.signal?.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      if (attempt >= maxAttempts || !isTransientPostgresReadError(error)) {
        throw error;
      }

      logWarn(
        options.context,
        `transient PostgreSQL read connection failure; retrying attempt=${attempt} max_attempts=${maxAttempts}`,
      );
      if (delayMs > 0) {
        await new Promise<void>((resolve, reject) => {
          const finish = () => {
            options.signal?.removeEventListener("abort", onAbort);
            resolve();
          };
          const timer = setTimeout(finish, delayMs);
          const onAbort = () => {
            clearTimeout(timer);
            options.signal?.removeEventListener("abort", onAbort);
            reject(options.signal?.reason ?? new Error("Read retry aborted"));
          };
          options.signal?.addEventListener("abort", onAbort, { once: true });
          if (options.signal?.aborted) onAbort();
        });
      }
    }
  }
}
