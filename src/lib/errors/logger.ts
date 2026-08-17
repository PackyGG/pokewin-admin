import * as Sentry from "@sentry/nextjs";

import { safeErrorMessage } from "./safe-error-message";

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
 * throwable; we serialize only its persistence-safe summary, but never the
 * stack, framework digest, or enumerable payload.
 *
 * SECURITY: never pass user-typed input as the `message`. If the
 * upstream error includes a SQL row payload, redact it before passing in. The
 * `err` argument is sanitized centrally and arbitrary objects are not
 * stringified.
 */

type LogLevel = "error" | "warn" | "info";

type ErrorDetails = {
  cause?: unknown;
  code?: unknown;
  name?: unknown;
};

function safeLogArea(area: string): string {
  return area
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "redacted-id")
    .replace(/\b\d{5,}\b/g, "redacted-id")
    .replace(/\b[0-9a-f]{16,}\b/gi, "redacted-id")
    .replace(/[^a-z0-9_.-]+/gi, "-")
    .slice(0, 120);
}

function safeErrorName(name: unknown): string {
  return typeof name === "string" && /^[A-Za-z][A-Za-z_.-]*Error$/.test(name)
    ? name.slice(0, 80)
    : "Error";
}

/**
 * Prefer the deepest causal error. Drizzle's outer message embeds the full
 * SQL statement and bound parameters, while the node-postgres cause carries
 * the useful SQLSTATE and a short operational message.
 */
function summarizeError(error: Error): string {
  const seen = new Set<unknown>();
  let current: unknown = error;
  let name = safeErrorName(error.name);
  let code: string | null = null;

  for (let depth = 0; depth < 8 && current != null; depth += 1) {
    if (seen.has(current) || typeof current !== "object") break;
    seen.add(current);
    const details = current as ErrorDetails;

    try {
      if (typeof details.name === "string" && details.name) {
        name = safeErrorName(details.name);
      }
      if (
        code == null &&
        typeof details.code === "string" &&
        /^[0-9A-Z]{5}$/.test(details.code)
      ) {
        code = details.code;
      }
      current = details.cause;
    } catch {
      break;
    }
  }

  // Centralize throwable rendering in the persistence-safe sanitizer. Besides
  // Drizzle SQL/params it removes URLs, credentials and identifier shapes.
  // Reading `Error#message` directly here previously let nested pg messages
  // bypass the stronger sanitizer used by Admin DB persistence paths.
  const safeMessage = safeErrorMessage(error, "Unknown error");
  const codePart = code ? ` code=${code}` : "";
  return `${name}: ${safeMessage}${codePart}`;
}

/**
 * Internal — emit a single prefixed line. Stays a function so future
 * deployments (e.g. structured logging via a Vercel Drain) can swap
 * this for a JSON emitter without touching call sites.
 */
function emit(level: LogLevel, area: string, message: string, err?: unknown) {
  try {
    const ts = new Date().toISOString();
    const prefix = `[${level}:${safeLogArea(area)}]`;
    let suffix = "";
    if (err !== undefined && err !== null) {
      if (err instanceof Error) {
        suffix = ` — ${summarizeError(err)}`;
      } else if (typeof err === "string") {
        suffix = ` — ${safeErrorMessage(err, "Unknown error")}`;
      } else {
        // Never stringify arbitrary objects. pg/Drizzle errors and API client
        // failures may expose SQL, bound values, response payloads or tokens in
        // enumerable properties even when their message is safe.
        suffix = " — [non-Error throwable redacted]";
      }
    }
    const line = `${ts} ${prefix} ${safeErrorMessage(message, "Log message redacted")}${suffix}`;
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
  const safeArea = safeLogArea(area);
  emit(
    "error",
    safeArea,
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
        scope.setTag("area", safeArea);
        scope.setTag("db.engine", details.engine);
        scope.setTag("failure.kind", details.kind);
        scope.setExtra(
          "duration_ms",
          Math.max(0, Math.round(details.durationMs)),
        );
        scope.setFingerprint([
          "postgres-query-failure",
          safeArea,
          details.kind,
        ]);
        Sentry.captureMessage("PostgreSQL query failed", "error");
        Sentry.metrics.count("database.query_failures", 1, {
          attributes: {
            area: safeArea,
            engine: details.engine,
            kind: details.kind,
          },
        });
      });
    });
  }
}
