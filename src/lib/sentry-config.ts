const DEFAULT_TRACE_SAMPLE_RATE = 0.1;
const DEFAULT_REPLAY_ERROR_SAMPLE_RATE = 1;

type SanitizableSentryEvent = {
  user?: unknown;
  request?: {
    cookies?: unknown;
    data?: unknown;
    headers?: unknown;
    query_string?: unknown;
    url?: string;
  };
  exception?: {
    values?: Array<{
      value?: string;
      stacktrace?: { frames?: Array<{ vars?: unknown }> };
    }>;
  };
  message?: string;
  logentry?: { message?: string; formatted?: string; params?: unknown };
  breadcrumbs?: unknown;
  contexts?: unknown;
  extra?: unknown;
  tags?: unknown;
  spans?: unknown;
};

/** Keep malformed deployment variables from disabling or oversampling traces. */
export function sentryTraceSampleRate(value: string | undefined): number {
  if (value === undefined || value.trim() === "") {
    return DEFAULT_TRACE_SAMPLE_RATE;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? parsed
    : DEFAULT_TRACE_SAMPLE_RATE;
}

/** Capture the buffered replay for every error by default, never normal sessions. */
export function sentryReplayErrorSampleRate(
  value: string | undefined,
): number {
  if (value === undefined || value.trim() === "") {
    return DEFAULT_REPLAY_ERROR_SAMPLE_RATE;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? parsed
    : DEFAULT_REPLAY_ERROR_SAMPLE_RATE;
}

export function stripSentryUrlDetails(
  value: string | undefined,
): string | undefined {
  if (!value) return value;
  try {
    const url = new URL(value, "https://sentry.invalid");
    return url.origin === "https://sentry.invalid"
      ? url.pathname
      : `${url.origin}${url.pathname}`;
  } catch {
    return value.split(/[?#]/, 1)[0];
  }
}

const SENSITIVE_ENV_KEY =
  /(?:secret|token|password|passwd|api[_-]?key|dsn|database_url|redis_url|pepper)/iu;

/** Called only by server/edge configuration; never exposes values in events. */
export function sentrySecretValues(
  environment: Record<string, string | undefined>,
): string[] {
  return Object.entries(environment)
    .filter(
      ([key, value]) =>
        SENSITIVE_ENV_KEY.test(key) && (value?.length ?? 0) >= 8,
    )
    .map(([, value]) => value as string);
}

const SENSITIVE_DATA_KEY =
  /(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|dsn|query(?:_string)?|statement|email|ip[_-]?address|user[_-]?id|request[_-]?body)/iu;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/gu;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/giu;
const SECRET_ASSIGNMENT =
  /\b(password|passwd|secret|token|api[_-]?key|authorization|cookie)\s*[:=]\s*[^\s,;]+/giu;

function scrubSentryText(
  value: string | undefined,
  secrets: readonly string[],
): string | undefined {
  if (!value) return value;
  const withoutSecrets = secrets.reduce(
    (scrubbed, secret) => scrubbed.replaceAll(secret, "[Filtered]"),
    value,
  );
  return withoutSecrets
    .replace(
      /https?:\/\/[^\s"'<>]+/gu,
      (url) => stripSentryUrlDetails(url) ?? url,
    )
    .replace(BEARER, "Bearer [Filtered]")
    .replace(SECRET_ASSIGNMENT, "$1=[Filtered]")
    .replace(EMAIL, "[Filtered email]")
    .replace(IPV4, "[Filtered IP]");
}

function scrubSentryValue(
  value: unknown,
  secrets: readonly string[],
  seen: WeakSet<object>,
): unknown {
  if (typeof value === "string") return scrubSentryText(value, secrets);
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      value[index] = scrubSentryValue(value[index], secrets, seen);
    }
    return value;
  }

  const record = value as Record<string, unknown>;
  const operation = typeof record.op === "string" ? record.op.toLowerCase() : "";
  if (operation.startsWith("db")) {
    // Timing and status identify a slow span; query text can contain user data.
    delete record.description;
    delete record.data;
  }
  for (const [key, child] of Object.entries(record)) {
    if (SENSITIVE_DATA_KEY.test(key)) {
      delete record[key];
      continue;
    }
    record[key] = scrubSentryValue(child, secrets, seen);
  }
  return record;
}

/** Remove request, identity, credential, query and URL details before egress. */
export function sanitizeSentryEvent<T extends SanitizableSentryEvent>(
  event: T,
  secrets: readonly string[] = [],
): T {
  delete event.user;

  if (event.request) {
    delete event.request.cookies;
    delete event.request.data;
    delete event.request.headers;
    delete event.request.query_string;
    event.request.url = stripSentryUrlDetails(event.request.url);
  }

  if (event.exception?.values) {
    for (const exception of event.exception.values) {
      exception.value = scrubSentryText(exception.value, secrets);
      if (exception.stacktrace?.frames) {
        for (const frame of exception.stacktrace.frames) delete frame.vars;
      }
    }
  }
  event.message = scrubSentryText(event.message, secrets);
  if (event.logentry) {
    event.logentry.message = scrubSentryText(event.logentry.message, secrets);
    event.logentry.formatted = scrubSentryText(
      event.logentry.formatted,
      secrets,
    );
    delete event.logentry.params;
  }
  scrubSentryValue(event.breadcrumbs, secrets, new WeakSet());
  scrubSentryValue(event.contexts, secrets, new WeakSet());
  scrubSentryValue(event.extra, secrets, new WeakSet());
  scrubSentryValue(event.tags, secrets, new WeakSet());
  scrubSentryValue(event.spans, secrets, new WeakSet());
  return event;
}
