type TransientReadRetryOptions = {
  context: string;
  maxAttempts?: number;
  delayMs?: number;
};

const TRANSIENT_POSTGRES_READ_ERROR =
  /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|57P01|57P02|57P03|57P05|08(?:000|001|003|004|006|007|P01)|53300)\b|connection (?:terminated|timeout|closed|reset)|terminating connection|server closed the connection|too many clients|database system is (?:starting up|shutting down)/i;

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
 * retaining the connection failed. SQL/schema/permission errors are never
 * retried, and callers must not use this helper for mutations.
 */
export async function withTransientPostgresReadRetry<T>(
  operation: () => Promise<T>,
  options: TransientReadRetryOptions,
): Promise<T> {
  const maxAttempts = Math.max(1, Math.trunc(options.maxAttempts ?? 2));
  const delayMs = Math.max(0, Math.trunc(options.delayMs ?? 150));

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (
        attempt >= maxAttempts ||
        !isTransientPostgresReadError(error)
      ) {
        throw error;
      }

      console.warn(
        `[${options.context}] transient PostgreSQL read connection failure; retrying`,
        { attempt, maxAttempts },
      );
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
}
