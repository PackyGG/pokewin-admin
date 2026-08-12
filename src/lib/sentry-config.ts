import type { ErrorEvent } from "@sentry/nextjs";

const DEFAULT_TRACE_SAMPLE_RATE = 0.1;

/**
 * Keep a malformed deployment variable from disabling tracing with NaN or
 * accidentally sampling every request. Sentry accepts values from 0 through 1.
 */
export function sentryTraceSampleRate(value: string | undefined): number {
  if (value === undefined || value.trim() === "") {
    return DEFAULT_TRACE_SAMPLE_RATE;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? parsed
    : DEFAULT_TRACE_SAMPLE_RATE;
}

/**
 * Retain the failing route and method while preventing query strings, headers,
 * cookies, request bodies, and user identity from leaving the admin app.
 */
export function sanitizeSentryEvent(event: ErrorEvent): ErrorEvent {
  delete event.user;

  if (event.request) {
    delete event.request.cookies;
    delete event.request.data;
    delete event.request.headers;
    delete event.request.query_string;

    if (event.request.url) {
      try {
        const url = new URL(event.request.url, "https://sentry.invalid");
        event.request.url = url.origin === "https://sentry.invalid"
          ? url.pathname
          : `${url.origin}${url.pathname}`;
      } catch {
        event.request.url = event.request.url.split(/[?#]/, 1)[0];
      }
    }
  }

  return event;
}
