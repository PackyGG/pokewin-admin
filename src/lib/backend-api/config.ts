import "server-only";

import { readDbEnv, type DbEnv } from "@/lib/db-env";

export type BackendApiConfig = {
  env: DbEnv;
  baseUrl: string;
  adminKey: string;
  cfHeaders: Record<string, string>;
  bypassHeaders: Record<string, string>;
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
 * The cookie is authoritative — same contract as the main-DB
 * request-scoped Drizzle client. Pages that mix the two
 * data sources would otherwise show data from different envs in
 * the same response (e.g. creators list from dev, social data
 * from prod) when the admin toggles env locally.
 *
 * Precedence:
 *   1. Honor the cookie-requested env if configured.
 *   2. Fall back to whichever env IS configured (recovery path
 *      for a missing config — better to talk to the other env
 *      than 500 the page).
 *   3. If nothing is configured, return the request unchanged so
 *      the downstream resolvers throw a diagnostic error.
 */
const resolveEffectiveEnv = (requested: DbEnv): DbEnv => {
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
  // Strip trailing slash, then ensure the API version prefix is present.
  // The backend mounts every route under `/v1`. Some Vercel deployments
  // were configured with a host-only URL (e.g. `https://api.packy.gg`)
  // which produced `/admin/creators` and 500'd at the not-found handler.
  // Normalizing here makes the env var forgiving — `https://api.packy.gg`
  // and `https://api.packy.gg/v1` both work.
  const trimmed = resolved.replace(/\/+$/, "");
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
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

const resolveBypassHeaders = (): Record<string, string> => {
  const bypassSecret = pick("CF_BYPASS_SECRET", "BACKEND_BYPASS_SECRET");
  return bypassSecret ? { "x-bypass-secret": bypassSecret } : {};
};

export const resolveBackendApiConfig = async (): Promise<BackendApiConfig> => {
  const requested = await readDbEnv();
  const env = resolveEffectiveEnv(requested);
  return {
    env,
    baseUrl: resolveBaseUrl(env),
    adminKey: resolveAdminKey(env),
    cfHeaders: resolveCfHeaders(),
    bypassHeaders: resolveBypassHeaders(),
  };
};
