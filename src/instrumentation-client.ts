import { registerWebappErrorListeners } from "@/lib/errors/report-webapp-error";

/**
 * Sentry browser init — DORMANT AND ZERO-WEIGHT by default. With no
 * NEXT_PUBLIC_SENTRY_DSN we never import `@sentry/nextjs`, so the (large)
 * browser SDK is NOT shipped in the per-page client bundle — the dynamic
 * import lands in a separate chunk that is never fetched. Setting the DSN
 * activates capture on the next build (the import branch goes live then).
 *
 * Replay is disabled (0 sample) to avoid session-replay payloads / extra
 * weight unless the owner opts in later.
 */
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

let routerTransitionStart: (...args: unknown[]) => void = () => {};

registerWebappErrorListeners();

if (dsn) {
  void import("@sentry/nextjs").then((Sentry) => {
    Sentry.init({
      dsn,
      enabled: true,
      environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.NODE_ENV,
      tracesSampleRate: Number(
        process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? "0.1",
      ),
      replaysOnErrorSampleRate: 0,
      replaysSessionSampleRate: 0,
      sendDefaultPii: false,
    });
    routerTransitionStart = (...args: unknown[]) =>
      (Sentry.captureRouterTransitionStart as (...a: unknown[]) => void)(
        ...args,
      );
  });
}

/**
 * Instruments App Router client navigations so transient errors that fire
 * DURING a route transition (e.g. the /chat -> /dashboard redirect replay that
 * surfaces React #310) are captured with navigation context. Stable wrapper
 * that delegates to the lazily-loaded Sentry hook; a no-op until (and unless)
 * the SDK is activated by a DSN.
 */
export const onRouterTransitionStart = (...args: unknown[]) =>
  routerTransitionStart(...args);
