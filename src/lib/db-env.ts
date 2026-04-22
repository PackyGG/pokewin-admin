import { AsyncLocalStorage } from "node:async_hooks";
import { cache } from "react";
import { cookies } from "next/headers";

// Per-request main-DB environment switch.
//
// The Main DB (`db` from @/lib/db) normally points at production
// (DATABASE_URL). A logged-in admin can temporarily route *their* own
// requests at the DEV environment (DEV_DATABASE_URL) via a cookie.
//
// The resolution is wired through AsyncLocalStorage so the Proxy in
// @/lib/db can pick the right client SYNCHRONOUSLY on property access
// — critical for Prisma's array-form `$transaction([...])`, which
// requires the inner operations to be real PrismaPromises from the
// same client (not generic thenables).
//
// ALS is seeded once per request in `verifySession()` via
// `resolveAndBindDbEnv()`. Any flow that never calls verifySession
// (cron, webhooks, unauth paths) transparently defaults to "prod".
//
// `adminDb` (the Admin DB) is NEVER env-switched — admin users,
// sessions and audit events always live in the same place.

export const DB_ENV_COOKIE = "admin_db_env";
export const DB_ENVS = ["prod", "dev"] as const;
export type DbEnv = (typeof DB_ENVS)[number];

const store = new AsyncLocalStorage<DbEnv>();

export function isDevDbConfigured(): boolean {
  return Boolean(process.env.DEV_DATABASE_URL?.trim());
}

function isDbEnv(value: unknown): value is DbEnv {
  return value === "prod" || value === "dev";
}

/**
 * Synchronous read of the current request's DB env. Used by the
 * legacy `db` Proxy in @/lib/db. Returns "prod" when ALS hasn't been
 * seeded — new call sites should prefer `await getDb()` which reads
 * the cookie directly per call and avoids this fallback entirely.
 */
export function getDbEnvSync(): DbEnv {
  return store.getStore() ?? "prod";
}

/**
 * Async read of the current DB env directly from the request cookie.
 * No ALS, no global state — callers always get a fresh answer that
 * reflects the most recent `switchDbEnv` action. Memoized per React
 * render via `cache()` so multiple queries in one request only pay
 * the cookie read once.
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
 * Async: read the env cookie and seed ALS for the remainder of the
 * current request's async context. Called from `verifySession()`.
 *
 * - "dev" is only honored when DEV_DATABASE_URL is configured; any
 *   other value (missing, invalid, dev without DEV_DATABASE_URL)
 *   collapses to "prod".
 * - Uses `enterWith` so the binding survives across awaits for the
 *   rest of the request without having to wrap every caller in
 *   `.run()`.
 */
export async function resolveAndBindDbEnv(): Promise<DbEnv> {
  const existing = store.getStore();
  if (existing) return existing;

  let env: DbEnv = "prod";
  try {
    const jar = await cookies();
    const raw = jar.get(DB_ENV_COOKIE)?.value;
    if (isDbEnv(raw) && (raw === "prod" || isDevDbConfigured())) {
      env = raw;
    }
  } catch {
    // cookies() is only available inside a request scope. Background
    // contexts (cron, top-level module code) fall back to prod.
  }

  store.enterWith(env);
  return env;
}

/**
 * Server-only helper for UI: read the active env without throwing
 * when the cookie is missing. Does NOT seed ALS — callers are
 * read-only consumers (banner, header toggle).
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
