import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { getDbEnvSync, readDbEnv, type DbEnv } from "./db-env";

const globalForPrisma = globalThis as unknown as {
  prismaClients: Map<DbEnv, PrismaClient> | undefined;
  prismaProxy: PrismaClient | undefined;
};

function createClient(connectionString: string | undefined, label: string) {
  const adapter = new PrismaPg(
    {
      connectionString,
      min: 0,
      max: 5,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
      maxLifetimeSeconds: 30,
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

function getClient(env: DbEnv): PrismaClient {
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
 * The shared Main-DB client. Transparently routes to either the prod
 * or the dev PrismaClient based on the current request's DB env
 * (resolved synchronously via AsyncLocalStorage — see ./db-env).
 *
 * Property access is forwarded directly to the underlying real client
 * so Prisma's internals — model delegates, PrismaPromise identity,
 * $transaction([...]) — all continue to work as if `db` were a normal
 * client. Functions returned off the client (`$transaction`,
 * `$queryRaw`, etc.) are bound to the real client so `this` is
 * correct at invocation time.
 */
function createDbProxy(): PrismaClient {
  return new Proxy({} as PrismaClient, {
    get(_target, prop, _receiver) {
      const client = getClient(getDbEnvSync());
      const value = Reflect.get(client, prop, client);
      if (typeof value === "function") {
        return value.bind(client);
      }
      return value;
    },
    has(_target, prop) {
      const client = getClient(getDbEnvSync());
      return prop in client;
    },
    getPrototypeOf() {
      const client = getClient(getDbEnvSync());
      return Object.getPrototypeOf(client);
    },
  });
}

/**
 * @deprecated — the Proxy reads env via ALS (`getDbEnvSync`), which
 * doesn't propagate reliably across React Server Component render
 * boundaries. Call sites often see stale "prod" even when the admin
 * has toggled to dev. Prefer `await getDb()` below — it reads the
 * cookie fresh per request and returns the right client.
 *
 * Kept for backwards compat until all 77 existing call sites are
 * migrated. New code MUST use `getDb()`.
 */
export const db: PrismaClient =
  globalForPrisma.prismaProxy ?? createDbProxy();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prismaProxy = db;
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
