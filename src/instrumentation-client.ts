import * as Sentry from "@sentry/nextjs";

import { registerWebappErrorListeners } from "@/lib/errors/report-webapp-error";
import {
  sanitizeSentryEvent,
  sentryTraceSampleRate,
} from "@/lib/sentry-config";

/**
 * Sentry browser init. It must run synchronously so startup exceptions and the
 * first App Router transition cannot race a lazy SDK import. With no DSN the
 * SDK remains disabled and sends nothing.
 *
 * Replay is disabled (0 sample) to avoid session-replay payloads / extra
 * weight unless the owner opts in later.
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
  replaysOnErrorSampleRate: 0,
  replaysSessionSampleRate: 0,
  sendDefaultPii: false,
  beforeSend: sanitizeSentryEvent,
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
