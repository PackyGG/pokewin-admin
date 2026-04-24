import "server-only";

import { readDbEnv, type DbEnv } from "@/lib/db-env";

export type BackendApiConfig = {
  env: DbEnv;
  baseUrl: string;
  adminKey: string;
  cfHeaders: Record<string, string>;
};

class MissingBackendApiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingBackendApiConfigError";
  }
}

const pick = (...keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
};

const urlFor = (env: DbEnv): string | undefined =>
  env === "dev"
    ? pick("BACKEND_API_URL_DEV", "DEV_BACKEND_API_URL")
    : pick("BACKEND_API_URL_PROD", "BACKEND_API_URL");

const keyFor = (env: DbEnv): string | undefined =>
  env === "dev"
    ? pick("BACKEND_ADMIN_KEY_DEV", "DEV_BACKEND_API_KEY")
    : pick("BACKEND_ADMIN_KEY_PROD", "BACKEND_API_KEY");

/**
 * Pick the effective env for the backend-api client.
 *
 * Precedence:
 *   1. During local dev (NODE_ENV !== 'production'), prefer the 'dev'
 *      backend when configured. The admin's main-DB cookie defaults to
 *      'prod', but the prod backend may not even be reachable from a
 *      developer's machine — admin_db_env=prod + backend=prod is a
 *      deploy concern, not a local one.
 *   2. Otherwise honor the cookie-requested env if configured.
 *   3. Fall back to whichever env IS configured.
 *   4. If nothing is configured, return the request unchanged so the
 *      downstream resolvers throw a diagnostic error.
 */
const resolveEffectiveEnv = (requested: DbEnv): DbEnv => {
  const isLocalDev = process.env.NODE_ENV !== "production";
  if (isLocalDev && urlFor("dev") && keyFor("dev")) return "dev";

  if (urlFor(requested) && keyFor(requested)) return requested;
  const other: DbEnv = requested === "dev" ? "prod" : "dev";
  if (urlFor(other) && keyFor(other)) return other;
  return requested;
};

const diagnoseConfig = (): string => {
  const lines = [
    `  BACKEND_API_URL_DEV      = ${pick("BACKEND_API_URL_DEV", "DEV_BACKEND_API_URL") ? "✓ set" : "✗ missing"}`,
    `  BACKEND_ADMIN_KEY_DEV    = ${pick("BACKEND_ADMIN_KEY_DEV", "DEV_BACKEND_API_KEY") ? "✓ set" : "✗ missing"}`,
    `  BACKEND_API_URL_PROD     = ${pick("BACKEND_API_URL_PROD", "BACKEND_API_URL") ? "✓ set" : "✗ missing"}`,
    `  BACKEND_ADMIN_KEY_PROD   = ${pick("BACKEND_ADMIN_KEY_PROD", "BACKEND_API_KEY") ? "✓ set" : "✗ missing"}`,
  ];
  return lines.join("\n");
};

const resolveBaseUrl = (env: DbEnv): string => {
  const resolved = urlFor(env);
  if (!resolved) {
    throw new MissingBackendApiConfigError(
      `Missing backend API URL for env '${env}'. Set ${
        env === "dev" ? "BACKEND_API_URL_DEV" : "BACKEND_API_URL_PROD"
      } in .env.local, then restart the dev server.\n\nCurrent env var state:\n${diagnoseConfig()}`,
    );
  }
  return resolved.replace(/\/+$/, "");
};

const resolveAdminKey = (env: DbEnv): string => {
  const resolved = keyFor(env);
  if (!resolved) {
    throw new MissingBackendApiConfigError(
      `Missing admin API key for env '${env}'. Set ${
        env === "dev" ? "BACKEND_ADMIN_KEY_DEV" : "BACKEND_ADMIN_KEY_PROD"
      } in .env.local, then restart the dev server.\n\nCurrent env var state:\n${diagnoseConfig()}`,
    );
  }
  return resolved;
};

/**
 * Cloudflare Access service token headers. Only attached when both are
 * configured so that local/dev setups without CF protection still work.
 * Uses the standard CF-Access-Client-Id / CF-Access-Client-Secret pair.
 */
const resolveCfHeaders = (): Record<string, string> => {
  const clientId = pick("CF_ACCESS_CLIENT_ID");
  const clientSecret = pick("CF_ACCESS_CLIENT_SECRET");

  if (!clientId || !clientSecret) return {};

  return {
    "CF-Access-Client-Id": clientId,
    "CF-Access-Client-Secret": clientSecret,
  };
};

export const resolveBackendApiConfig = async (): Promise<BackendApiConfig> => {
  const requested = await readDbEnv();
  const env = resolveEffectiveEnv(requested);
  return {
    env,
    baseUrl: resolveBaseUrl(env),
    adminKey: resolveAdminKey(env),
    cfHeaders: resolveCfHeaders(),
  };
};
