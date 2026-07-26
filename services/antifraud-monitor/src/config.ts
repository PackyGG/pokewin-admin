import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4100),
  SOURCE_DATABASE_URL: z.string().min(1),
  SOURCE_DATABASE_SSL: z.enum(["disable", "require"]).default("disable"),
  SOURCE_DATABASE_CA: z.string().optional(),
  ANTIFRAUD_DATABASE_URL: z.string().min(1),
  ANTIFRAUD_DATABASE_SSL: z.enum(["disable", "require"]).default("disable"),
  ANTIFRAUD_DATABASE_CA: z.string().optional(),
  REDIS_URL: z.string().min(1),
  FINGERPRINT_SECRET_API_KEY: z.string().min(1),
  FINGERPRINT_REGION: z.enum(["eu", "us", "ap"]).default("eu"),
  PROXYCHECK_API_KEY: z.string().min(1),
  API_TOKEN: z.string().min(32),
  API_ADMIN_TOKEN: z.string().min(32),
  PUBLIC_BASE_URL: z.string().url(),
  ANTIFRAUD_DASHBOARD_URL: z
    .string()
    .url()
    .default("https://fraud.packydash.com/monitor"),
  ANTIFRAUD_DISCORD_WEBHOOK_URL: z.string().url().optional(),
  ALLOWED_ORIGINS: z.string().min(1),
  API_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(10).max(10_000).default(300),
  API_WRITE_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(1_000).default(30),
  WS_TICKET_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(1_000).default(30),
  POLL_INTERVAL_MS: z.coerce.number().int().min(500).max(60_000).default(1_000),
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

  const publicUrl = new URL(config.PUBLIC_BASE_URL);
  if (config.NODE_ENV === "production" && publicUrl.protocol !== "https:") {
    throw new Error("Invalid configuration: PUBLIC_BASE_URL must use HTTPS in production");
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
