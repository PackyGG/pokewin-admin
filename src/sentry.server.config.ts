import * as Sentry from "@sentry/nextjs";

/**
 * Sentry server-runtime init (Node.js). DORMANT BY DEFAULT — same contract as
 * the ClickHouse / Redis layers: with no SENTRY_DSN the SDK is `enabled: false`
 * and captures/sends nothing, so behavior is identical to not having it.
 *
 * Loaded by src/instrumentation.ts register() only for the nodejs runtime.
 * Never put secrets or user PII into events (sendDefaultPii stays false).
 */
const dsn = process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  release: process.env.VERCEL_GIT_COMMIT_SHA,
  // Performance tracing — sample modestly in prod; override via env.
  tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.1"),
  // Never attach cookies / headers / user PII automatically.
  sendDefaultPii: false,
});
