import * as Sentry from "@sentry/nextjs";

import {
  sanitizeSentryEvent,
  sentrySecretValues,
  sentryTraceSampleRate,
} from "@/lib/sentry-config";

/**
 * Sentry server-runtime init (Node.js). DORMANT BY DEFAULT — same contract as
 * the PostgreSQL / Redis layers: with no SENTRY_DSN the SDK is `enabled: false`
 * and captures/sends nothing, so behavior is identical to not having it.
 *
 * Loaded by src/instrumentation.ts register() only for the nodejs runtime.
 * Never put secrets or user PII into events (sendDefaultPii stays false).
 */
const dsn = process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN;
const secrets = sentrySecretValues(process.env);

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  release: process.env.VERCEL_GIT_COMMIT_SHA,
  // Performance tracing — sample modestly in prod; override via env.
  tracesSampleRate: sentryTraceSampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE),
  // Never attach cookies / headers / user PII automatically.
  sendDefaultPii: false,
  initialScope: {
    tags: { "app.component": "admin-dashboard", "app.runtime": "server" },
  },
  beforeSend: (event) => sanitizeSentryEvent(event, secrets),
  beforeSendTransaction: (event) => sanitizeSentryEvent(event, secrets),
  // SECURITY (SECURITY_AUDIT.md LOW): drop console breadcrumbs. Server logs
  // (e.g. backend-api error payloads) can carry user data; keep them out of
  // Sentry events entirely rather than risk egressing PII on the next capture.
  beforeBreadcrumb(breadcrumb) {
    return breadcrumb.category === "console" ? null : breadcrumb;
  },
});
