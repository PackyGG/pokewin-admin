import { z } from "zod";

const fiatEligibilityEnabledSchema = z
  .enum(["true", "false"])
  .optional()
  .transform((value) => value === "true");

export function parseFiatEligibilityGloballyEnabled(value: unknown): boolean {
  const parsed = fiatEligibilityEnabledSchema.safeParse(value);
  return parsed.success ? parsed.data : false;
}

const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  SENTRY_DSN: z.string().url().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).optional(),
  SENTRY_PROFILE_SESSION_SAMPLE_RATE: z.coerce
    .number()
    .min(0)
    .max(1)
    .optional(),
  SENTRY_RELEASE: z.string().min(1).optional(),
  RAILWAY_ENVIRONMENT_NAME: z.string().optional(),
  RAILWAY_GIT_COMMIT_SHA: z.string().optional(),
  RAILWAY_DEPLOYMENT_ID: z.string().optional(),
  // Nothing reads `config.TZ` — the process timezone is pinned by
  // `process.env.TZ ??= "UTC"` in server.ts and by `-c TimeZone=UTC` on both
  // pools. The field stays declared anyway: the audit-contracts test requires
  // every `process.env.X` consumed under src/ to be declared here, so this is
  // the schema's record of an env var the service does read.
  TZ: z.string().min(1).default("UTC"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4100),
  SOURCE_DATABASE_URL: z.string().min(1),
  SOURCE_DATABASE_SSL: z.enum(["disable", "require"]).default("disable"),
  SOURCE_DATABASE_CA: z.string().optional(),
  FIAT_ELIGIBILITY_DEV_SOURCE_DATABASE_URL: z.string().min(1).optional(),
  FIAT_ELIGIBILITY_DEV_SOURCE_DATABASE_SSL: z
    .enum(["disable", "require"])
    .default("disable"),
  FIAT_ELIGIBILITY_DEV_SOURCE_DATABASE_CA: z.string().optional(),
  BATTLE_TEST_DEV_DATABASE_URL: z.string().min(1).optional(),
  BATTLE_TEST_DEV_SERVER_SEED_PEPPER: z.string().min(32).optional(),
  ANTIFRAUD_DATABASE_URL: z.string().min(1),
  ANTIFRAUD_DATABASE_SSL: z.enum(["disable", "require"]).default("disable"),
  ANTIFRAUD_DATABASE_CA: z.string().optional(),
  REDIS_URL: z.string().min(1),
  FINGERPRINT_SECRET_API_KEY: z.string().min(1),
  FINGERPRINT_REGION: z.enum(["eu", "us", "ap"]).default("eu"),
  PROXYCHECK_API_KEY: z.string().min(1),
  ABSTRACT_IP_INTELLIGENCE_API_KEY: z.string().min(1),
  ABSTRACT_EMAIL_REPUTATION_API_KEY: z.string().min(1),
  /** Company-scoped Whop credentials used only by the bounded payment poller. */
  WHOP_ADMIN_KEY: z.string().min(1).optional(),
  WHOP_COMPANY_ID: z
    .string()
    .regex(/^biz_[A-Za-z0-9]+$/)
    .optional(),
  MAXMIND_ACCOUNT_ID: z.string().regex(/^\d+$/).optional(),
  MAXMIND_LICENSE_KEY: z.string().min(16).optional(),
  MAXMIND_ALERT_WEBHOOK_SECRET: z.string().min(20).max(100).optional(),
  FIAT_ACCESS_API_BASE_URL: z.string().url().default("https://packy.gg/v1"),
  ADMIN_API_KEY: z.string().min(1).optional(),
  xbypasssecret: z.string().min(1).optional(),
  XBYPASSSECRET: z.string().min(1).optional(),
  SUMSUB_ADMIN_TOKEN: z.string().min(1).optional(),
  SUMSUB_ADMIN_KEY: z.string().min(1).optional(),
  API_TOKEN: z.string().min(32),
  API_ADMIN_TOKEN: z.string().min(32),
  FIAT_ELIGIBILITY_DEV_API_KEY: z.string().min(32).optional(),
  FIAT_ELIGIBILITY_PROD_API_KEY: z.string().min(32).optional(),
  FIAT_ELIGIBILITY_GLOBALLY_ENABLED: fiatEligibilityEnabledSchema,
  // Automatic account containment for enforced denials. Defaults to ON: an
  // unset variable must not silently downgrade the endpoint to observe-only.
  // Set it to "false" to keep assessing and denying while withholding locks.
  FIAT_ELIGIBILITY_CONTAINMENT_ENABLED: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value !== "false"),
  // Approved rail locks for high-confidence post-authorization identity risk.
  // KYC is always a staff decision and is never changed by this switch.
  // Defaults to ON for the same reason as the switch above. Set it to "false"
  // for an observe-only window: every deposit is still evaluated and recorded
  // with `enforcement = 'suppressed'`, and the Discord alert still fires, but
  // no account is locked. Review-only findings still open Account Review.
  FIAT_DEPOSIT_IDENTITY_CONTAINMENT_ENABLED: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value !== "false"),
  FIAT_ELIGIBILITY_RATE_LIMIT_PER_MINUTE: z.coerce
    .number()
    .int()
    .min(1)
    .max(10_000)
    .default(120),
  PUBLIC_BASE_URL: z.string().url(),
  ANTIFRAUD_DASHBOARD_URL: z
    .string()
    .url()
    .default("https://fraud.packydash.com/monitor"),
  ANTIFRAUD_INGEST_URL: z.string().url(),
  ANTIFRAUD_INGEST_SECRET: z.string().min(32),
  ANTIFRAUD_WEBAPP_HEALTH_URL: z
    .string()
    .url()
    .default("https://fraud.packydash.com/api/health/antifraud-webapp"),
  ADMIN_GUILD_ID: z
    .string()
    .regex(/^\d{15,21}$/)
    .default("1483064422778798112"),
  FIAT_ALERT_DASHBOARD_URL: z
    .string()
    .url()
    .default("https://fraud.packydash.com/fiat-deposits"),
  ALLOWED_ORIGINS: z.string().min(1),
  API_RATE_LIMIT_PER_MINUTE: z.coerce
    .number()
    .int()
    .min(10)
    .max(10_000)
    .default(300),
  API_WRITE_RATE_LIMIT_PER_MINUTE: z.coerce
    .number()
    .int()
    .min(1)
    .max(1_000)
    .default(30),
  WS_TICKET_RATE_LIMIT_PER_MINUTE: z.coerce
    .number()
    .int()
    .min(1)
    .max(1_000)
    .default(30),
  // Live websocket transport tuning. Deliberately optional: the operational
  // defaults live in LiveBus (8 per actor, 500 global, 60 minute sessions) so
  // partial Config literals in tests keep compiling.
  LIVE_MAX_CONNECTIONS_PER_ACTOR: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .optional(),
  LIVE_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(10_000).optional(),
  LIVE_SESSION_MAX_AGE_MINUTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(1_440)
    .optional(),
  POLL_INTERVAL_MS: z.coerce.number().int().min(500).max(60_000).default(1_000),
  // The activity scan issues one heavy source query per active monitor
  // session, so it must not run at the 1s signup cadence: at ~100 active
  // sessions that is ~100 six-branch UNION queries per second against a small
  // source pool, which pushes the tick past POLL_INTERVAL_MS and silently
  // degrades the poller. Sessions live for MONITOR_DURATION_SECONDS, so a 5s
  // cadence still samples every session dozens of times before it completes.
  POLL_ACTIVITY_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(60_000)
    .default(5_000),
  POLL_SIGNUP_BATCH_SIZE: z.coerce
    .number()
    .int()
    .min(10)
    .max(1_000)
    .default(100),
  POLL_MAX_SIGNUP_BATCHES: z.coerce.number().int().min(1).max(20).default(5),
  POLL_ACTIVITY_BATCH_SIZE: z.coerce
    .number()
    .int()
    .min(100)
    .max(10_000)
    .default(2_000),
  POLL_ACTIVITY_OVERLAP_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(30_000)
    .default(2_000),
  POLL_STALE_AFTER_MS: z.coerce
    .number()
    .int()
    .min(5_000)
    .max(300_000)
    .default(15_000),
  // Liveness budget for the container healthcheck: how long the elected leader
  // may go without a successful tick before /health reports 503 and Railway
  // restarts the process. Deliberately far above POLL_STALE_AFTER_MS so a
  // transient degrade does not cycle the container.
  POLLER_LIVENESS_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(30_000)
    .max(900_000)
    .default(120_000),
  MONITOR_DURATION_SECONDS: z.coerce
    .number()
    .int()
    .min(30)
    .max(3_600)
    .default(300),
  MONITOR_START_SCORE: z.coerce.number().int().min(0).max(100).default(21),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(): Config {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const errors = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join(", ");
    throw new Error(`Invalid configuration: ${errors}`);
  }
  const config = parsed.data;
  if (
    config.NODE_ENV !== "test" &&
    (!config.MAXMIND_ACCOUNT_ID || !config.MAXMIND_LICENSE_KEY)
  ) {
    throw new Error(
      "Invalid configuration: MAXMIND_ACCOUNT_ID and MAXMIND_LICENSE_KEY are required",
    );
  }
  if (config.API_TOKEN === config.API_ADMIN_TOKEN) {
    throw new Error(
      "Invalid configuration: API_TOKEN and API_ADMIN_TOKEN must differ",
    );
  }
  if (Boolean(config.SUMSUB_ADMIN_TOKEN) !== Boolean(config.SUMSUB_ADMIN_KEY)) {
    throw new Error(
      "Invalid configuration: SUMSUB_ADMIN_TOKEN and SUMSUB_ADMIN_KEY must be configured together",
    );
  }
  if (Boolean(config.WHOP_ADMIN_KEY) !== Boolean(config.WHOP_COMPANY_ID)) {
    throw new Error(
      "Invalid configuration: WHOP_ADMIN_KEY and WHOP_COMPANY_ID must be configured together",
    );
  }
  const serviceKeys = [
    config.API_TOKEN,
    config.API_ADMIN_TOKEN,
    config.FIAT_ELIGIBILITY_DEV_API_KEY,
    config.FIAT_ELIGIBILITY_PROD_API_KEY,
  ].filter((value): value is string => Boolean(value));
  if (new Set(serviceKeys).size !== serviceKeys.length) {
    throw new Error(
      "Invalid configuration: all API credentials must be distinct",
    );
  }
  if (
    config.FIAT_ELIGIBILITY_DEV_API_KEY &&
    !config.FIAT_ELIGIBILITY_DEV_SOURCE_DATABASE_URL
  ) {
    throw new Error(
      "Invalid configuration: the dev Fiat eligibility key requires a dev source database",
    );
  }
  if (
    Boolean(config.BATTLE_TEST_DEV_DATABASE_URL) !==
    Boolean(config.BATTLE_TEST_DEV_SERVER_SEED_PEPPER)
  ) {
    throw new Error(
      "Invalid configuration: battle test dev database and pepper must be configured together",
    );
  }
  if (
    config.BATTLE_TEST_DEV_DATABASE_URL &&
    config.BATTLE_TEST_DEV_DATABASE_URL === config.SOURCE_DATABASE_URL
  ) {
    throw new Error(
      "Invalid configuration: battle testing cannot use the production source database",
    );
  }
  const publicUrl = new URL(config.PUBLIC_BASE_URL);
  if (config.NODE_ENV === "production" && publicUrl.protocol !== "https:") {
    throw new Error(
      "Invalid configuration: PUBLIC_BASE_URL must use HTTPS in production",
    );
  }
  const ingestUrl = new URL(config.ANTIFRAUD_INGEST_URL);
  if (
    ingestUrl.username ||
    ingestUrl.password ||
    (config.NODE_ENV === "production" && ingestUrl.protocol !== "https:")
  ) {
    throw new Error(
      "Invalid configuration: ANTIFRAUD_INGEST_URL must be credential-free and use HTTPS in production",
    );
  }
  const healthUrl = new URL(config.ANTIFRAUD_WEBAPP_HEALTH_URL);
  if (
    healthUrl.username ||
    healthUrl.password ||
    (config.NODE_ENV === "production" && healthUrl.protocol !== "https:")
  ) {
    throw new Error(
      "Invalid configuration: ANTIFRAUD_WEBAPP_HEALTH_URL must be credential-free and use HTTPS in production",
    );
  }
  for (const rawOrigin of config.ALLOWED_ORIGINS.split(",")) {
    const origin = rawOrigin.trim();
    if (!origin || origin === "*") {
      throw new Error(
        "Invalid configuration: ALLOWED_ORIGINS must contain exact origins",
      );
    }
    const parsedOrigin = new URL(origin);
    if (
      config.NODE_ENV === "production" &&
      parsedOrigin.protocol !== "https:"
    ) {
      throw new Error(
        "Invalid configuration: production origins must use HTTPS",
      );
    }
  }

  return config;
}
