import * as Sentry from "@sentry/nextjs";

/**
 * Tiny dependency-free server-side logger.
 *
 * Vercel Functions / Edge Logs ingest `console.error` verbatim, so the
 * wire format here is intentionally just a single prefixed string per
 * call — easy to grep (`[error:<area>]`), easy to redact (no JSON keys
 * that look like sensitive fields), no dependency on a tracing library.
 *
 * Usage (always server-side; never call from a "use client" file):
 *
 *   import { logError, logWarn } from "@/lib/errors/logger";
 *
 *   try {
 *     await heavyQuery();
 *   } catch (err) {
 *     logError("dashboard.stats", "getDashboardStats failed", err);
 *     throw err; // or return a fallback, depending on caller
 *   }
 *
 *   logWarn("auth.session", "session cookie missing — falling back");
 *
 * The `area` is a short dot-namespaced tag (`<feature>.<sub>`) — pick
 * the one that makes the most sense to grep for. The `message` is a
 * one-line human description. The `err` (optional) is the raw
 * throwable; we serialize the `.message` and the `digest` (if Next 15
 * attached one) but never the stack — Next already logs the stack at
 * the framework boundary and we don't want to double-print it.
 *
 * SECURITY: never pass user-typed input as the `message`. If the
 * upstream error includes a SQL row payload, redact it before passing
 * in. The `err` argument is fine because we only surface `.message` +
 * `.name`, not the rest of the object.
 */

type LogLevel = "error" | "warn" | "info";

type ErrorDetails = {
  cause?: unknown;
  code?: unknown;
  digest?: unknown;
  message?: unknown;
  name?: unknown;
};

function boundedLogText(value: string): string {
  return value
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[redacted-database-url]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

/**
 * Prefer the deepest causal error. Drizzle's outer message embeds the full
 * SQL statement and bound parameters, while the node-postgres cause carries
 * the useful SQLSTATE and a short operational message.
 */
function summarizeError(error: Error): string {
  const seen = new Set<unknown>();
  let current: unknown = error;
  let name = error.name || "Error";
  let message = error.message || "Unknown error";
  let code: string | null = null;
  let digest: string | null = null;

  for (let depth = 0; depth < 8 && current != null; depth += 1) {
    if (seen.has(current) || typeof current !== "object") break;
    seen.add(current);
    const details = current as ErrorDetails;

    try {
      if (typeof details.name === "string" && details.name) {
        name = details.name;
      }
      if (typeof details.message === "string" && details.message) {
        message = details.message;
      }
      if (
        code == null &&
        typeof details.code === "string" &&
        /^[0-9A-Z]{5}$/.test(details.code)
      ) {
        code = details.code;
      }
      if (
        digest == null &&
        typeof details.digest === "string" &&
        details.digest
      ) {
        digest = boundedLogText(details.digest);
      }
      current = details.cause;
    } catch {
      break;
    }
  }

  const safeMessage = /failed query:|(?:^|\s)params:/i.test(message)
    ? "Database query failed"
    : boundedLogText(message);
  const codePart = code ? ` code=${code}` : "";
  const digestPart = digest ? ` digest=${digest}` : "";
  return `${name}: ${safeMessage}${codePart}${digestPart}`;
}

/**
 * Internal — emit a single prefixed line. Stays a function so future
 * deployments (e.g. structured logging via a Vercel Drain) can swap
 * this for a JSON emitter without touching call sites.
 */
function emit(level: LogLevel, area: string, message: string, err?: unknown) {
  try {
    const ts = new Date().toISOString();
    const prefix = `[${level}:${area}]`;
    let suffix = "";
    if (err !== undefined && err !== null) {
      if (err instanceof Error) {
        suffix = ` — ${summarizeError(err)}`;
      } else if (typeof err === "string") {
        suffix = ` — ${boundedLogText(err)}`;
      } else {
        // Last-resort stringify. Never spread arbitrary objects directly
        // into the log line; one Pg error can include the entire failed
        // SQL text + params.
        try {
          suffix = ` — ${JSON.stringify(err).slice(0, 500)}`;
        } catch {
          suffix = " — [unserialisable error]";
        }
      }
    }
    const line = `${ts} ${prefix} ${message}${suffix}`;
    // Route by level so Vercel's log UI shows the right severity icon.
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  } catch {
    // Logging is observability, never control flow. A hostile Error getter or
    // failing console sink must not replace a contained application failure.
  }
}

/**
 * Log an error. Use when a recoverable failure happens that the caller
 * is handling (e.g. wrapping in a fallback) — the stack still goes to
 * the server log so the on-call engineer can find it.
 */
export function logError(area: string, message: string, err?: unknown) {
  emit("error", area, message, err);
}

/** Log a warning. Use for soft anomalies that don't break the flow. */
export function logWarn(area: string, message: string, err?: unknown) {
  emit("warn", area, message, err);
}

/** Log an info-level event. Use sparingly; production-only milestones. */
export function logInfo(area: string, message: string) {
  emit("info", area, message);
}

/** Which read engine a degraded query was hitting. */
export type QueryEngine = "postgres";

export function runTelemetrySafely(report: () => void): void {
  try {
    report();
  } catch {
    // Observability is best-effort. A reporting failure must not escape an
    // application error handler.
  }
}

/**
 * Emit one structured query-failure line carrying the engine token,
 * `duration_ms` elapsed-before-degrade, and the failure `kind`
 * (`timeout` vs `error`). It reuses {@link logError}'s `[error:<area>]`
 * prefix and redaction rules (name/message/digest only, no stack;
 * non-Error sliced to 500 chars), so a failed PG tile and a failed CH read
 * log in the same shape and grep the same way (`kind=timeout`, `kind=error`,
 * `engine=postgres`, `duration_ms=<int>`). Carries no
 * SQL/params/row payloads.
 */
export function logQueryFailure(
  area: string,
  details: {
    engine: QueryEngine;
    durationMs: number;
    kind: "timeout" | "error";
  },
  err?: unknown,
) {
  emit(
    "error",
    area,
    `query failed engine=${details.engine} duration_ms=${details.durationMs} kind=${details.kind}`,
    err,
  );

  // safeQuery deliberately catches the original exception, so Sentry's
  // unhandled-error integration cannot see it. Emit a sanitized operational
  // event with only bounded diagnostic tags. Never attach the raw throwable,
  // SQL, parameters, request data, or user identifiers.
  if (process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN) {
    runTelemetrySafely(() => {
      Sentry.withScope((scope) => {
        scope.setTag("area", area.slice(0, 120));
        scope.setTag("db.engine", details.engine);
        scope.setTag("failure.kind", details.kind);
        scope.setExtra(
          "duration_ms",
          Math.max(0, Math.round(details.durationMs)),
        );
        scope.setFingerprint([
          "postgres-query-failure",
          area.slice(0, 120),
          details.kind,
        ]);
        Sentry.captureMessage("PostgreSQL query failed", "error");
        Sentry.metrics.count("database.query_failures", 1, {
          attributes: {
            area: area.slice(0, 120),
            engine: details.engine,
            kind: details.kind,
          },
        });
      });
    });
  }
}
