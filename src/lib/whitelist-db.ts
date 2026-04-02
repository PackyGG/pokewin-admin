import pg from "pg";

const globalForWhitelistPool = globalThis as unknown as {
  whitelistPool: pg.Pool | undefined;
};

function createPool() {
  return new pg.Pool({
    connectionString: process.env.WHITELIST_DATABASE_URL,
    min: 0,
    max: 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });
}

export const whitelistPool =
  globalForWhitelistPool.whitelistPool ?? createPool();

if (process.env.NODE_ENV !== "production")
  globalForWhitelistPool.whitelistPool = whitelistPool;
