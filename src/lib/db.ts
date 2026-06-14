import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { readDbEnv, type DbEnv } from "./db-env";

const globalForPrisma = globalThis as unknown as {
  prismaClients: Map<DbEnv, PrismaClient> | undefined;
};

function createClient(connectionString: string | undefined, label: string) {
  const adapter = new PrismaPg(
    {
      connectionString,
      min: 0,
      // Per-instance pool cap kept SMALL on purpose. This admin app shares the
      // live prod game DB (Postgres `max_connections = 100`) with the main
      // website backend, and on Vercel each warm serverless instance holds its
      // OWN pool — so peak app connections ≈ (max × concurrent warm instances).
      // At max:5 the shared DB was observed over its 100-connection cap (~111,
      // "sorry, too many clients already"), which surfaced as "query timed
      // out" bands on uncached admin reads (verified 2026-06-14, the
      // /transactions withdrawals-tab incident — the query was 12–91ms, the
      // wait was pool/connection contention, not the query). Internal admin
      // traffic is low-volume and does not need a big per-instance pool, so cap
      // it low to leave the bulk of the 100 connections for the game backend.
      // Proper long-term fix is a connection pooler / pooled DATABASE_URL
      // (PgBouncer / Prisma Accelerate) — an owner-side env change, not code.
      max: 3,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
      // Server-side cap on how long ANY single statement may run on a
      // pooled connection. `pg` issues `SET statement_timeout` per
      // connection, so Postgres itself aborts (and frees the connection of)
      // a query that exceeds this — independent of whether the Node caller
      // is still awaiting it.
      //
      // Why it's needed: the app-level `safeQuery`/`withTimeout` wrappers
      // (15–20s budgets on the heavy creator + insights aggregates) only
      // stop US awaiting a slow query via Promise.race — they do NOT cancel
      // the query in Postgres. A timed-out scan therefore keeps running and
      // keeps holding one of the `max: 5` pool slots, so a couple of
      // runaway scans can starve the whole pool and make even cheap reads
      // queue behind them (the /creators/[userId] "analytics taking too
      // long" failure mode). With this set, Postgres releases the
      // connection when the statement is killed, so the slot returns to the
      // pool instead of being pinned until the platform tears the request
      // down.
      //
      // Value (30s, GLOBAL — chosen conservatively): every legitimate query
      // in the app finishes well inside 30s on prod-sized data, and the
      // heaviest paths are already bounded BELOW this by their own
      // safeQuery budgets (creator detail 20s, Net-PnL/reward insights
      // 15s). So 30s sits comfortably ABOVE every real budget and only
      // fires on a genuinely pathological/runaway scan — it will not abort a
      // healthy long query. Keep it >= the largest safeQuery timeout so the
      // app-level fallback always wins the race first under normal slowness,
      // and this only acts as the backstop that frees the connection.
      statement_timeout: 30_000,
      maxLifetimeSeconds: 600,
      keepAlive: true,
      keepAliveInitialDelayMillis: 5_000,
      allowExitOnIdle: true,
    },
    {
      onPoolError: (err) =>
        console.error(`[db:${label}] Pool error:`, err.message),
    },
  );

  return new PrismaClient({ adapter }).$extends({
    query: {
      $allOperations: async ({ args, query }) => {
        const MAX_RETRIES = 2;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
          try {
            return await query(args);
          } catch (error) {
            if (attempt < MAX_RETRIES && isConnectionError(error)) {
              const delay = attempt === 0 ? 100 : 500;
              console.warn(
                `[db:${label}] Connection error (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying in ${delay}ms...`,
              );
              await new Promise((r) => setTimeout(r, delay));
              continue;
            }
            throw error;
          }
        }
      },
    },
  }) as unknown as PrismaClient;
}

function isConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: string }).code;
  if (code === "P1017" || code === "P1001" || code === "P2024") return true;
  const msg = error.message;
  if (
    msg.includes("Connection terminated") ||
    msg.includes("terminated unexpectedly") ||
    msg.includes("connection lost") ||
    msg.includes("Client has encountered a connection error") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("connection timeout")
  )
    return true;
  if (error.cause instanceof Error) return isConnectionError(error.cause);
  return false;
}

// Clients are lazily created per env and cached on globalThis so HMR
// in dev doesn't leak connections. Only the prod client exists until
// an admin explicitly switches to dev.
const clients: Map<DbEnv, PrismaClient> =
  globalForPrisma.prismaClients ?? new Map<DbEnv, PrismaClient>();
if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prismaClients = clients;
}

// Bust the dev client cache when `prisma generate` updates the client
// (HMR keeps the old PrismaClient instance otherwise → stale enum validation).
const PRISMA_CLIENT_BUILD_ID = "2026-05-28-upgrader-enums";
let cachedBuildId: string | undefined;

function getClient(env: DbEnv): PrismaClient {
  if (
    process.env.NODE_ENV !== "production" &&
    cachedBuildId !== PRISMA_CLIENT_BUILD_ID
  ) {
    clients.clear();
    cachedBuildId = PRISMA_CLIENT_BUILD_ID;
  }

  let client = clients.get(env);
  if (client) return client;

  const connectionString =
    env === "dev" ? process.env.DEV_DATABASE_URL : process.env.DATABASE_URL;

  if (env === "dev" && !connectionString) {
    // Caller should have verified DEV_DATABASE_URL is configured via
    // isDevDbConfigured(). If not, fall back to prod instead of
    // instantiating a broken client with an empty connection string.
    const prodClient = clients.get("prod") ?? createClient(process.env.DATABASE_URL, "prod");
    clients.set("prod", prodClient);
    return prodClient;
  }

  client = createClient(connectionString, env);
  clients.set(env, client);
  return client;
}

/**
 * Explicit prod-pinned client. Use ONLY when you need to force prod
 * regardless of the admin's current env toggle (e.g. admin audit
 * writes that should never go to dev). Prefer `getDb()` otherwise.
 */
export function getProdDb(): PrismaClient {
  return getClient("prod");
}

/**
 * Explicit dev-pinned client. Throws if DEV_DATABASE_URL isn't set.
 * Rarely needed directly — `getDb()` is the normal entry point.
 */
export function getDevDb(): PrismaClient {
  if (!process.env.DEV_DATABASE_URL?.trim()) {
    throw new Error("DEV_DATABASE_URL is not configured on this server");
  }
  return getClient("dev");
}

/**
 * The canonical way to read the main DB. Reads the `admin_db_env`
 * cookie fresh (memoized per React render via `cache()`), then
 * returns the prod or dev PrismaClient accordingly.
 *
 * Race-condition-free: no mutable global state, no ALS. Each request
 * independently resolves its own env from its own cookie jar.
 *
 * Usage:
 *   const db = await getDb();
 *   const users = await db.user.findMany({ ... });
 */
export async function getDb(): Promise<PrismaClient> {
  const env = await readDbEnv();
  return getClient(env);
}

/** Sync client for a known env — use inside `unstable_cache` callbacks keyed on env. */
export function dbForEnv(env: DbEnv): PrismaClient {
  return getClient(env);
}
