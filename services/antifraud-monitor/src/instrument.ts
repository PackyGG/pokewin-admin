import * as Sentry from "@sentry/node";
import { nodeProfilingIntegration } from "@sentry/profiling-node";

import {
  sanitizeSentryEvent,
  sanitizeSentryLog,
  sentryProfileSessionSampleRate,
  sentryTraceSampleRate,
} from "./sentry-config.js";

const dsn = process.env.SENTRY_DSN;
const secrets = [
  process.env.SOURCE_DATABASE_URL,
  process.env.FIAT_ELIGIBILITY_DEV_SOURCE_DATABASE_URL,
  process.env.SOURCE_DATABASE_CA,
  process.env.FIAT_ELIGIBILITY_DEV_SOURCE_DATABASE_CA,
  process.env.BATTLE_TEST_DEV_DATABASE_URL,
  process.env.BATTLE_TEST_DEV_SERVER_SEED_PEPPER,
  process.env.ANTIFRAUD_MIGRATION_DATABASE_URL,
  process.env.ANTIFRAUD_DATABASE_URL,
  process.env.ANTIFRAUD_DATABASE_CA,
  process.env.REDIS_URL,
  process.env.FINGERPRINT_SECRET_API_KEY,
  process.env.PROXYCHECK_API_KEY,
  process.env.ABSTRACT_IP_INTELLIGENCE_API_KEY,
  process.env.ABSTRACT_EMAIL_REPUTATION_API_KEY,
  process.env.MAXMIND_LICENSE_KEY,
  process.env.MAXMIND_ALERT_WEBHOOK_SECRET,
  process.env.WHOP_ADMIN_KEY,
  process.env.ADMIN_API_KEY,
  process.env.xbypasssecret,
  process.env.XBYPASSSECRET,
  process.env.SUMSUB_ADMIN_TOKEN,
  process.env.SUMSUB_ADMIN_KEY,
  process.env.API_TOKEN,
  process.env.API_ADMIN_TOKEN,
  process.env.FIAT_ELIGIBILITY_DEV_API_KEY,
  process.env.FIAT_ELIGIBILITY_PROD_API_KEY,
  process.env.ANTIFRAUD_INGEST_SECRET,
].filter((value): value is string => Boolean(value));

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  environment: process.env.RAILWAY_ENVIRONMENT_NAME ?? process.env.NODE_ENV,
  // Git-backed deploys use the commit; direct Railway CLI deploys still get a
  // unique release through their deployment ID.
  release:
    process.env.RAILWAY_GIT_COMMIT_SHA ??
    process.env.RAILWAY_DEPLOYMENT_ID ??
    process.env.SENTRY_RELEASE,
  sendDefaultPii: false,
  enableLogs: true,
  profileSessionSampleRate: sentryProfileSessionSampleRate(
    process.env.SENTRY_PROFILE_SESSION_SAMPLE_RATE,
  ),
  profileLifecycle: "trace",
  dataCollection: { genAI: { inputs: false, outputs: false } },
  initialScope: {
    tags: { "app.component": "antifraud-monitor", "app.runtime": "railway" },
  },
  integrations: [
    nodeProfilingIntegration(),
    Sentry.fastifyIntegration({
      // Fastify v5 request failures are captured explicitly in the service's
      // central error handler, after expected 4xx errors have been excluded.
      shouldHandleError: () => false,
    }),
  ],
  tracesSampler: (samplingContext) => {
    const name = samplingContext.name.toLowerCase();
    if (name.includes("/health") || name.includes("/ready")) return 0;
    return samplingContext.inheritOrSampleWith(
      sentryTraceSampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE),
    );
  },
  beforeBreadcrumb: (breadcrumb) =>
    breadcrumb.category === "console" ? null : breadcrumb,
  beforeSend: (event) => sanitizeSentryEvent(event, secrets),
  beforeSendLog: (log) => sanitizeSentryLog(log, secrets),
  beforeSendTransaction: (event) => sanitizeSentryEvent(event, secrets),
});
