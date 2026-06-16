import * as Sentry from "@sentry/nextjs";

/**
 * Sentry edge-runtime init (middleware + edge route handlers). DORMANT BY
 * DEFAULT — with no SENTRY_DSN the SDK is `enabled: false` and sends nothing.
 *
 * Loaded by src/instrumentation.ts register() only for the edge runtime.
 */
const dsn = process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  release: process.env.VERCEL_GIT_COMMIT_SHA,
  tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.1"),
  sendDefaultPii: false,
});
