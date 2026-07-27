import { cache } from "react";
import { cookies } from "next/headers";

// Per-request main-DB environment switch.
//
// MAIN reads normally point at MIRROR_PRODUCTION_DB. A logged-in admin can
// temporarily route *their* own reads at MIRROR_DEV_DB via a cookie. Mutation
// flows resolve the same cookie but keep using DATABASE_URL / DEV_DATABASE_URL.
//
// Resolution is async and cookie-based — each call to `readDbEnv`
// reads the `admin_db_env` cookie fresh. `cache()` memoizes the
// result per React render so multiple queries in one request pay the
// cookie read cost once. Use `getReadDrizzleDb()` for reads and
// `getPrimaryDrizzleDb()` for write flows.
//
// The Admin DB is NEVER env-switched — admin users,
// sessions and audit events always live in the same place.

export const DB_ENV_COOKIE = "admin_db_env";
export const DB_ENVS = ["prod", "dev"] as const;
export type DbEnv = (typeof DB_ENVS)[number];

export function isDevDbConfigured(): boolean {
  return Boolean(
    process.env.MIRROR_DEV_DB?.trim() && process.env.DEV_DATABASE_URL?.trim(),
  );
}

function isDbEnv(value: unknown): value is DbEnv {
  return value === "prod" || value === "dev";
}

/**
 * Async read of the current DB env from the request cookie. Memoized
 * per React render via `cache()` — safe to call from every query
 * without round-tripping the cookie jar multiple times.
 */
export const readDbEnv = cache(async (): Promise<DbEnv> => {
  try {
    const jar = await cookies();
    const raw = jar.get(DB_ENV_COOKIE)?.value;
    if (isDbEnv(raw) && (raw === "prod" || isDevDbConfigured())) {
      return raw;
    }
  } catch {
    // cookies() is only callable inside a request scope. Background
    // contexts (cron, top-level module code) fall back to prod.
  }
  return "prod";
});

/**
 * Server-only helper for UI: read the active env for banner / header
 * display. Not memoized because it's used by the layout shell which
 * already runs once per render.
 */
export async function readDbEnvFromCookie(): Promise<DbEnv> {
  try {
    const jar = await cookies();
    const raw = jar.get(DB_ENV_COOKIE)?.value;
    if (isDbEnv(raw) && (raw === "prod" || isDevDbConfigured())) {
      return raw;
    }
  } catch {
    // ignore
  }
  return "prod";
}
