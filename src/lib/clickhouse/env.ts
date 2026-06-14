import "server-only";

/**
 * ClickHouse Cloud connection config — resolved from SERVER-ONLY env.
 *
 * Mirrors the dormancy contract of src/lib/cache/redis.ts and
 * src/lib/edge-config.ts: if any required var is missing, this returns `null`
 * and the whole ClickHouse read layer stays DORMANT (callers fall back to
 * Postgres, behavior is identical). Never throws, never logs secret values,
 * never exposes anything to the client (no NEXT_PUBLIC_).
 */
export type ClickHouseConfig = {
  url: string;
  username: string;
  password: string;
  database: string;
};

export function resolveClickHouseConfig(): ClickHouseConfig | null {
  // Accept a couple of common aliases (URL/HOST, USERNAME/USER, …) so whatever
  // names the ClickHouse Cloud panel emits map cleanly.
  const url = (process.env.CLICKHOUSE_URL ?? process.env.CLICKHOUSE_HOST)?.trim();
  const username = (
    process.env.CLICKHOUSE_USERNAME ?? process.env.CLICKHOUSE_USER
  )?.trim();
  const password = (
    process.env.CLICKHOUSE_PASSWORD ?? process.env.CLICKHOUSE_TOKEN
  )?.trim();
  const database = (
    process.env.CLICKHOUSE_DATABASE ?? process.env.CLICKHOUSE_DB
  )?.trim();

  if (!url || !username || !password || !database) return null;
  return { url, username, password, database };
}

export function isClickHouseConfigured(): boolean {
  return resolveClickHouseConfig() !== null;
}
