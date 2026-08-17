import { postgresErrorCode } from "../postgres-errors";

/**
 * Turn an unknown throwable into a string that is safe to PERSIST in an
 * admin-visible column and to RENDER to staff.
 *
 * The failure this exists for: `DrizzleQueryError`'s own `.message` is
 * literally ``Failed query: <full SQL>\nparams: <bound values>`` (see
 * `drizzle-orm/errors.js`). Antifraud outbox and deposit-resolution paths
 * store `error.message` into columns the Fraud workspace renders verbatim
 * (`antifraud_signals.containment_outbox_error`,
 * `antifraud_identifier_blocking_outbox.error`, `…deposits.last_error`), so
 * one failed lookup published the statement plus the bound user id / email /
 * identifier to every analyst with page access — and left it in the Admin DB
 * indefinitely.
 *
 * What survives: that it was a database failure, the SQLSTATE, and a short
 * category — which is what an operator actually triages on ("did this time
 * out, hit a constraint, or get refused?"). What never survives: SQL text,
 * bound parameters, driver detail strings, and anything shaped like an email,
 * IP, URL/connection string, token, UUID or fingerprint id.
 *
 * Total by contract: it never throws, always returns a string, and accepts
 * `null` / `undefined` / non-`Error` input.
 */

const MAX_SAFE_MESSAGE_LENGTH = 300;

/** Drizzle's wrapper message, and node-postgres detail lines that echo params. */
const DRIVER_MESSAGE_SHAPE = /failed query:|(?:^|[\s(])params:/i;

/**
 * Applied in order to any message we do echo. These are defensive: an operator
 * message should never carry these shapes, so a hit means an upstream string
 * leaked into a place we thought we controlled.
 */
const REDACTIONS: readonly (readonly [RegExp, string])[] = [
  // Any absolute URL — a DSN carries the password, an API URL can carry a
  // token in the query string.
  [/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[redacted-url]"],
  // JWTs and other dot-delimited signed payloads.
  [
    /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    "[redacted-token]",
  ],
  // Prefixed API/webhook secrets and bearer credentials.
  [
    /\b(?:bearer|basic|sk|pk|rk|whsec|token|apikey|api_key)[ _-][A-Za-z0-9._-]{8,}/gi,
    "[redacted-token]",
  ],
  [/[\w.+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, "[redacted-email]"],
  [
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    "[redacted-id]",
  ],
  // Device fingerprints and hashes reach us as long hex runs.
  [/\b[0-9a-f]{16,}\b/gi, "[redacted-id]"],
  [/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "[redacted-ip]"],
  // IPv6 needs 4+ hextet groups so a clock time (12:34:56) is left alone.
  [/\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi, "[redacted-ip]"],
  // Numeric/snowflake identifiers do not have a globally unique shape, so
  // redact them only when the surrounding label makes their meaning clear.
  [
    /\b(?:user|account|customer|creator|subject|target[_ -]?user|discord)[_ -]?(?:id|identifier)\s*[=:]\s*["']?[A-Za-z0-9_-]{3,}["']?/gi,
    "[redacted-id]",
  ],
  [
    /\b(?:failed for|(?:user|account|customer|creator|subject|pack|card|set)\s+)["']?\d{4,}["']?/gi,
    "[redacted-id]",
  ],
];

/** SQLSTATEs worth naming exactly, because the triage differs per code. */
const SQLSTATE_CATEGORY: Record<string, string | undefined> = {
  "0A000": "feature not supported",
  "22P02": "invalid text representation",
  "23502": "not-null violation",
  "23503": "foreign key violation",
  "23505": "unique violation",
  "23514": "check violation",
  "25006": "read-only transaction",
  "40001": "serialization failure",
  "40P01": "deadlock detected",
  "42501": "insufficient privilege",
  "42P01": "undefined table",
  "42703": "undefined column",
  "53200": "out of memory",
  "53300": "too many connections",
  "55P03": "lock not available",
  "57014": "statement timeout",
};

/** Fallback by SQLSTATE class, so an unlisted code still names its family. */
const SQLSTATE_CLASS_CATEGORY: Record<string, string | undefined> = {
  "08": "connection failure",
  "22": "data exception",
  "23": "constraint violation",
  "25": "invalid transaction state",
  "28": "invalid authorization",
  "2D": "invalid transaction termination",
  "3D": "invalid catalog name",
  "3F": "invalid schema name",
  "40": "transaction rollback",
  "42": "syntax or access rule violation",
  "53": "insufficient resources",
  "54": "program limit exceeded",
  "55": "object not in prerequisite state",
  "57": "operator intervention",
  "58": "system error",
  P0: "PL/pgSQL error",
  XX: "internal error",
};

type ErrorLike = {
  cause?: unknown;
  message?: unknown;
  params?: unknown;
  query?: unknown;
};

function sqlStateCategory(code: string): string {
  return (
    SQLSTATE_CATEGORY[code] ??
    SQLSTATE_CLASS_CATEGORY[code.slice(0, 2)] ??
    "unclassified"
  );
}

function redact(value: string): string {
  let text = value;
  for (const [pattern, replacement] of REDACTIONS) {
    text = text.replace(pattern, replacement);
  }
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_SAFE_MESSAGE_LENGTH);
}

/**
 * Walk the cause chain for the deepest message that is NOT driver-shaped, and
 * flag whether any level was. Drizzle wraps the node-postgres error, so the
 * useful operational text and the leaking SQL live at different depths.
 */
function inspect(error: unknown): { message: string; driver: boolean } {
  if (typeof error === "string") {
    return DRIVER_MESSAGE_SHAPE.test(error)
      ? { message: "", driver: true }
      : { message: error, driver: false };
  }

  const seen = new Set<unknown>();
  let current: unknown = error;
  let message = "";
  let driver = false;

  for (let depth = 0; depth < 8 && current != null; depth += 1) {
    if (typeof current !== "object" || seen.has(current)) break;
    seen.add(current);
    const node = current as ErrorLike;

    try {
      // DrizzleQueryError carries the statement and the bound values as own
      // properties, so the shape stays detectable even if the message does not.
      if (typeof node.query === "string" && Array.isArray(node.params)) {
        driver = true;
      }
      if (typeof node.message === "string" && node.message.trim()) {
        if (DRIVER_MESSAGE_SHAPE.test(node.message)) driver = true;
        else message = node.message;
      }
      current = node.cause;
    } catch {
      break;
    }
  }

  return { message, driver };
}

/**
 * The safe rendering of `error`. `fallback` is returned when nothing
 * meaningful survives — pass `""` if the caller wants to branch on empty.
 *
 * Database failures always collapse to a `Database error (SQLSTATE …)` line:
 * the driver message is dropped wholesale rather than filtered, because pg
 * embeds parameter values in its own text too (`invalid input syntax for type
 * uuid: "…"`), so allow-listing parts of it would keep leaking.
 */
export function safeErrorMessage(
  error: unknown,
  fallback: string = "Unknown error",
): string {
  try {
    if (error == null) return fallback;

    const code = postgresErrorCode(error);
    const { message, driver } = inspect(error);

    if (code) {
      return `Database error (SQLSTATE ${code}: ${sqlStateCategory(code)})`;
    }
    if (driver) return "Database error (no SQLSTATE reported)";

    return redact(message) || fallback;
  } catch {
    // A hostile getter or an exotic cause chain must not turn a contained
    // failure into a second throw on the error path.
    return fallback;
  }
}
