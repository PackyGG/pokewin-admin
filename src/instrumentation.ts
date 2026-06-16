import * as Sentry from "@sentry/nextjs";

/**
 * Next.js instrumentation hook. Loads the runtime-appropriate Sentry init
 * (nodejs vs edge) once per server boot. Both inits are dormant unless
 * SENTRY_DSN is set, so this is a no-op without configuration.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

/**
 * Captures errors thrown in Server Components, Route Handlers and Server
 * Actions (the App Router nested-request error hook). No-op when Sentry is
 * dormant.
 */
export const onRequestError = Sentry.captureRequestError;
