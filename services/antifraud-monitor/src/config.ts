import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
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
  ANTIFRAUD_DATABASE_URL: z.string().min(1),
  ANTIFRAUD_DATABASE_SSL: z.enum(["disable", "require"]).default("disable"),
  ANTIFRAUD_DATABASE_CA: z.string().optional(),
  REDIS_URL: z.string().min(1),
  FINGERPRINT_SECRET_API_KEY: z.string().min(1),
  FINGERPRINT_REGION: z.enum(["eu", "us", "ap"]).default("eu"),
  PROXYCHECK_API_KEY: z.string().min(1),
  ABSTRACT_IP_INTELLIGENCE_API_KEY: z.string().min(1),
  ABSTRACT_EMAIL_REPUTATION_API_KEY: z.string().min(1),
  ADMIN_API_KEY: z.string().min(1).optional(),
  xbypasssecret: z.string().min(1).optional(),
  XBYPASSSECRET: z.string().min(1).optional(),
  SUMSUB_ADMIN_TOKEN: z.string().min(1).optional(),
  SUMSUB_ADMIN_KEY: z.string().min(1).optional(),
  API_TOKEN: z.string().min(32),
  API_ADMIN_TOKEN: z.string().min(32),
  FIAT_ELIGIBILITY_DEV_API_KEY: z.string().min(32).optional(),
  FIAT_ELIGIBILITY_PROD_API_KEY: z.string().min(32).optional(),
  FIAT_ELIGIBILITY_DEV_ALLOWED_IPS: z.string().default(""),
  FIAT_ELIGIBILITY_PROD_ALLOWED_IPS: z.string().default(""),
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
  ADMIN_GUILD_ID: z
    .string()
    .regex(/^\d{15,21}$/)
    .default("1483064422778798112"),
  FIAT_ALERT_DASHBOARD_URL: z
    .string()
    .url()
    .default("https://fraud.packydash.com/fiat-deposits"),
  ALLOWED_ORIGINS: z.string().min(1),
  API_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(10).max(10_000).default(300),
  API_WRITE_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(1_000).default(30),
  WS_TICKET_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(1_000).default(30),
  POLL_INTERVAL_MS: z.coerce.number().int().min(500).max(60_000).default(1_000),
  POLL_SIGNUP_BATCH_SIZE: z.coerce.number().int().min(10).max(1_000).default(100),
  POLL_MAX_SIGNUP_BATCHES: z.coerce.number().int().min(1).max(20).default(5),
  POLL_ACTIVITY_BATCH_SIZE: z.coerce.number().int().min(100).max(10_000).default(2_000),
  POLL_ACTIVITY_OVERLAP_MS: z.coerce.number().int().min(0).max(30_000).default(2_000),
  POLL_STALE_AFTER_MS: z.coerce.number().int().min(5_000).max(300_000).default(15_000),
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
  MONITOR_DURATION_SECONDS: z.coerce.number().int().min(30).max(3_600).default(180),
  MONITOR_START_SCORE: z.coerce.number().int().min(0).max(500).default(25),
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
  if (config.API_TOKEN === config.API_ADMIN_TOKEN) {
    throw new Error("Invalid configuration: API_TOKEN and API_ADMIN_TOKEN must differ");
  }
  if (Boolean(config.SUMSUB_ADMIN_TOKEN) !== Boolean(config.SUMSUB_ADMIN_KEY)) {
    throw new Error(
      "Invalid configuration: SUMSUB_ADMIN_TOKEN and SUMSUB_ADMIN_KEY must be configured together",
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
    config.FIAT_ELIGIBILITY_DEV_API_KEY
    && !config.FIAT_ELIGIBILITY_DEV_SOURCE_DATABASE_URL
  ) {
    throw new Error(
      "Invalid configuration: the dev Fiat eligibility key requires a dev source database",
    );
  }
  for (const [key, allowlist] of [
    [
      config.FIAT_ELIGIBILITY_DEV_API_KEY,
      config.FIAT_ELIGIBILITY_DEV_ALLOWED_IPS,
    ],
    [
      config.FIAT_ELIGIBILITY_PROD_API_KEY,
      config.FIAT_ELIGIBILITY_PROD_ALLOWED_IPS,
    ],
  ] as const) {
    if (key && !allowlist.trim()) {
      throw new Error(
        "Invalid configuration: every Fiat eligibility key requires an IP allowlist",
      );
    }
  }
  const publicUrl = new URL(config.PUBLIC_BASE_URL);
  if (config.NODE_ENV === "production" && publicUrl.protocol !== "https:") {
    throw new Error("Invalid configuration: PUBLIC_BASE_URL must use HTTPS in production");
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

  for (const rawOrigin of config.ALLOWED_ORIGINS.split(",")) {
    const origin = rawOrigin.trim();
    if (!origin || origin === "*") {
      throw new Error("Invalid configuration: ALLOWED_ORIGINS must contain exact origins");
    }
    const parsedOrigin = new URL(origin);
    if (
      config.NODE_ENV === "production" &&
      parsedOrigin.protocol !== "https:"
    ) {
      throw new Error("Invalid configuration: production origins must use HTTPS");
    }
  }

  return config;
}
