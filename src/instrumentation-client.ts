import * as Sentry from "@sentry/nextjs";

/**
 * Sentry browser init. DORMANT BY DEFAULT — with no NEXT_PUBLIC_SENTRY_DSN the
 * SDK is `enabled: false` and sends nothing. Loaded automatically by Next.js
 * for client navigation/instrumentation.
 *
 * Replay is disabled (0 sample) to avoid shipping session-replay payloads /
 * extra bundle weight unless the owner opts in later.
 */
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.NODE_ENV,
  tracesSampleRate: Number(
    process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? "0.1",
  ),
  replaysOnErrorSampleRate: 0,
  replaysSessionSampleRate: 0,
  sendDefaultPii: false,
});

/**
 * Instruments App Router client navigations so transient errors that fire
 * DURING a route transition (e.g. the /chat -> /dashboard redirect replay that
 * surfaces React #310) are captured with navigation context instead of being
 * lost. No-op when Sentry is dormant.
 */
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
