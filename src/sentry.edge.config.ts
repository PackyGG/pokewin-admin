import * as Sentry from "@sentry/nextjs";

import {
  sanitizeSentryEvent,
  sanitizeSentryLog,
  sentrySecretValues,
  sentryTraceSampleRate,
} from "@/lib/sentry-config";

/**
 * Sentry edge-runtime init (middleware + edge route handlers). DORMANT BY
 * DEFAULT — with no SENTRY_DSN the SDK is `enabled: false` and sends nothing.
 *
 * Loaded by src/instrumentation.ts register() only for the edge runtime.
 */
const dsn = process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN;
const secrets = sentrySecretValues(process.env);

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  release: process.env.VERCEL_GIT_COMMIT_SHA,
  tracesSampleRate: sentryTraceSampleRate(
    process.env.SENTRY_TRACES_SAMPLE_RATE,
  ),
  enableLogs: true,
  sendDefaultPii: false,
  initialScope: {
    tags: { "app.component": "admin-dashboard", "app.runtime": "edge" },
  },
  beforeSend: (event) => sanitizeSentryEvent(event, secrets),
  beforeSendLog: (log) => sanitizeSentryLog(log, secrets),
  beforeSendTransaction: (event) => sanitizeSentryEvent(event, secrets),
  beforeBreadcrumb(breadcrumb) {
    return breadcrumb.category === "console" ? null : breadcrumb;
  },
});
