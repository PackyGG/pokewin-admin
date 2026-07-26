import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4100),
  SOURCE_DATABASE_URL: z.string().min(1),
  SOURCE_DATABASE_SSL: z.enum(["disable", "require"]).default("disable"),
  ANTIFRAUD_DATABASE_URL: z.string().min(1),
  ANTIFRAUD_DATABASE_SSL: z.enum(["disable", "require"]).default("disable"),
  REDIS_URL: z.string().min(1),
  FINGERPRINT_SECRET_API_KEY: z.string().min(1),
  FINGERPRINT_REGION: z.enum(["eu", "us", "ap"]).default("eu"),
  PROXYCHECK_API_KEY: z.string().min(1),
  API_TOKEN: z.string().min(32),
  PUBLIC_BASE_URL: z.string().url(),
  ALLOWED_ORIGINS: z.string().default(""),
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
  return parsed.data;
}
