import type { Event } from "@sentry/node";

type SanitizableLog = {
  message: unknown;
  attributes?: Record<string, unknown>;
};

const DEFAULT_TRACE_SAMPLE_RATE = 0.1;
const DEFAULT_PROFILE_SESSION_SAMPLE_RATE = 0.01;

export function sentryTraceSampleRate(value: string | undefined): number {
  if (value === undefined || value.trim() === "")
    return DEFAULT_TRACE_SAMPLE_RATE;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? parsed
    : DEFAULT_TRACE_SAMPLE_RATE;
}

export function sentryProfileSessionSampleRate(
  value: string | undefined,
): number {
  if (value === undefined || value.trim() === "") {
    return DEFAULT_PROFILE_SESSION_SAMPLE_RATE;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? parsed
    : DEFAULT_PROFILE_SESSION_SAMPLE_RATE;
}

export function stripUrlDetails(value: string | undefined): string | undefined {
  if (!value) return value;
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return value.split(/[?#]/, 1)[0];
  }
}

function scrubText(
  value: string | undefined,
  secrets: readonly string[],
): string | undefined {
  if (!value) return value;
  const scrubbed = secrets.reduce(
    (scrubbed, secret) =>
      secret ? scrubbed.replaceAll(secret, "[Filtered]") : scrubbed,
    value,
  );
  return scrubbed.replace(
    /https?:\/\/[^\s"'<>]+/gu,
    (url) => stripUrlDetails(url) ?? url,
  );
}

const SENSITIVE_KEY =
  /(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|dsn|query(?:_string)?|statement|email|ip[_-]?address|user[_-]?id)/iu;

function scrubUnknown(
  value: unknown,
  secrets: readonly string[],
  seen: WeakSet<object>,
): unknown {
  if (typeof value === "string") return scrubText(value, secrets);
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      value[index] = scrubUnknown(value[index], secrets, seen);
    }
    return value;
  }
  const record = value as Record<string, unknown>;
  const operation =
    typeof record.op === "string" ? record.op.toLowerCase() : "";
  if (operation.startsWith("db")) {
    delete record.description;
    delete record.data;
  }
  for (const [key, child] of Object.entries(record)) {
    if (SENSITIVE_KEY.test(key)) {
      delete record[key];
      continue;
    }
    record[key] = scrubUnknown(child, secrets, seen);
  }
  return record;
}

/** Remove request/user payloads and known credentials before an event leaves Railway. */
export function sanitizeSentryEvent<T extends Event>(
  event: T,
  secrets: readonly string[],
): T {
  delete event.user;
  if (event.request) {
    event.request.url = stripUrlDetails(event.request.url);
    delete event.request.cookies;
    delete event.request.data;
    delete event.request.headers;
    delete event.request.query_string;
  }
  if (event.exception?.values) {
    for (const exception of event.exception.values) {
      exception.value = scrubText(exception.value, secrets);
      if (exception.stacktrace?.frames) {
        for (const frame of exception.stacktrace.frames) delete frame.vars;
      }
    }
  }
  event.message = scrubText(event.message, secrets);
  scrubUnknown(event.breadcrumbs, secrets, new WeakSet());
  scrubUnknown(event.contexts, secrets, new WeakSet());
  scrubUnknown(event.extra, secrets, new WeakSet());
  scrubUnknown(event.tags, secrets, new WeakSet());
  scrubUnknown(event.spans, secrets, new WeakSet());
  return event;
}

export function sanitizeSentryLog<T extends SanitizableLog>(
  log: T,
  secrets: readonly string[] = [],
): T {
  log.message = scrubUnknown(log.message, secrets, new WeakSet());
  if (log.attributes) scrubUnknown(log.attributes, secrets, new WeakSet());
  return log;
}
