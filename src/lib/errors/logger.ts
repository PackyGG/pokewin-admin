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

/**
 * Internal — emit a single prefixed line. Stays a function so future
 * deployments (e.g. structured logging via a Vercel Drain) can swap
 * this for a JSON emitter without touching call sites.
 */
function emit(level: LogLevel, area: string, message: string, err?: unknown) {
  const ts = new Date().toISOString();
  const prefix = `[${level}:${area}]`;
  let suffix = "";
  if (err !== undefined && err !== null) {
    if (err instanceof Error) {
      const digest = (err as Error & { digest?: string }).digest;
      const digestPart = digest ? ` digest=${digest}` : "";
      suffix = ` — ${err.name}: ${err.message}${digestPart}`;
    } else if (typeof err === "string") {
      suffix = ` — ${err}`;
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
  details: { engine: QueryEngine; durationMs: number; kind: "timeout" | "error" },
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
    try {
      Sentry.withScope((scope) => {
        scope.setTag("area", area.slice(0, 120));
        scope.setTag("db.engine", details.engine);
        scope.setTag("failure.kind", details.kind);
        scope.setExtra("duration_ms", Math.max(0, Math.round(details.durationMs)));
        scope.setFingerprint([
          "postgres-query-failure",
          area.slice(0, 120),
          details.kind,
        ]);
        Sentry.captureMessage("PostgreSQL query failed", "error");
      });
    } catch {
      // Monitoring must never turn a safely degraded query into a route crash.
    }
  }
}
