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

const resolveBaseUrl = (env: DbEnv): string => {
  const resolved =
    env === "dev"
      ? pick("BACKEND_API_URL_DEV", "DEV_BACKEND_API_URL")
      : pick("BACKEND_API_URL_PROD", "BACKEND_API_URL");

  if (!resolved) {
    throw new MissingBackendApiConfigError(
      `Missing backend API URL for env '${env}'. Set ${
        env === "dev" ? "BACKEND_API_URL_DEV" : "BACKEND_API_URL_PROD"
      }.`
    );
  }

  return resolved.replace(/\/+$/, "");
};

const resolveAdminKey = (env: DbEnv): string => {
  const resolved =
    env === "dev"
      ? pick("BACKEND_ADMIN_KEY_DEV", "DEV_BACKEND_API_KEY")
      : pick("BACKEND_ADMIN_KEY_PROD", "BACKEND_API_KEY");

  if (!resolved) {
    throw new MissingBackendApiConfigError(
      `Missing admin API key for env '${env}'. Set ${
        env === "dev" ? "BACKEND_ADMIN_KEY_DEV" : "BACKEND_ADMIN_KEY_PROD"
      }.`
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
  const env = await readDbEnv();
  return {
    env,
    baseUrl: resolveBaseUrl(env),
    adminKey: resolveAdminKey(env),
    cfHeaders: resolveCfHeaders(),
  };
};
