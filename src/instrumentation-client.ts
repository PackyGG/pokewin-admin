import * as Sentry from "@sentry/nextjs";

import { registerWebappErrorListeners } from "@/lib/errors/report-webapp-error";
import {
  sanitizeSentryEvent,
  sanitizeSentryLog,
  sentryProfileSessionSampleRate,
  sentryReplayErrorSampleRate,
  sentryTraceSampleRate,
} from "@/lib/sentry-config";

/**
 * Sentry browser init. It must run synchronously so startup exceptions and the
 * first App Router transition cannot race a lazy SDK import. With no DSN the
 * SDK remains disabled and sends nothing.
 *
 * Normal sessions are never uploaded. A bounded sample keeps the rolling error
 * replay buffer; all text/inputs are masked and all media is blocked.
 */
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.NODE_ENV,
  tracesSampleRate: sentryTraceSampleRate(
    process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE,
  ),
  tracePropagationTargets: [
    "localhost",
    /^https:\/\/(?:fraud\.|packs\.|marketing\.)?packydash\.com(?:\/|$)/,
  ],
  integrations: [
    Sentry.replayIntegration({
      maskAllText: true,
      maskAllInputs: true,
      blockAllMedia: true,
    }),
    Sentry.browserProfilingIntegration(),
  ],
  profileSessionSampleRate: sentryProfileSessionSampleRate(
    process.env.NEXT_PUBLIC_SENTRY_PROFILE_SESSION_SAMPLE_RATE,
  ),
  profileLifecycle: "trace",
  enableLogs: true,
  replaysOnErrorSampleRate: sentryReplayErrorSampleRate(
    process.env.NEXT_PUBLIC_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE,
  ),
  replaysSessionSampleRate: 0,
  sendDefaultPii: false,
  initialScope: {
    tags: { "app.component": "admin-dashboard", "app.runtime": "browser" },
  },
  beforeSend: (event) => sanitizeSentryEvent(event),
  beforeSendLog: (log) => sanitizeSentryLog(log),
  beforeSendTransaction: (event) => sanitizeSentryEvent(event),
  beforeBreadcrumb(breadcrumb) {
    return breadcrumb.category === "console" ? null : breadcrumb;
  },
});

registerWebappErrorListeners();

/**
 * Instruments App Router client navigations, including the first navigation
 * after boot. Sentry treats this as a no-op when the SDK is disabled.
 */
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
