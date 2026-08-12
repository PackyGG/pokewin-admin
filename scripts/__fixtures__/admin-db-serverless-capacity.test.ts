import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * The Admin database has previously been exhausted by warm serverless
 * instances each retaining several sessions, so the DIRECT path stays pinned
 * to a single connection per instance.
 *
 * That cap is an availability guard, not a performance choice — it serializes
 * every Admin read in a request, which the Admin-DB-backed antifraud
 * workspaces pay for on every page. Behind a PgBouncer transaction pooler the
 * database only ever sees `default_pool_size` server connections regardless of
 * how many isolates are warm, so a small per-instance concurrency is safe and
 * the serialization goes away.
 *
 * Both halves of that rule are load-bearing: the direct path must stay at 1,
 * and the raised cap must be conditional on the pooler actually being
 * configured.
 */
test("serverless Admin pool concurrency is conditional on the transaction pooler", () => {
  const source = readFileSync("src/lib/admin-db.ts", "utf8");

  // Direct path: still exactly one session per warm instance.
  assert.match(
    source,
    /max: process\.env\.VERCEL \? \(pooled \? 4 : 1\) : 5/,
    "the direct serverless path must remain capped at a single session",
  );

  // The raised cap must be gated on the pooler being present, never assumed.
  assert.match(source, /ADMIN_DATABASE_URL_POOLED/);
  assert.match(
    source,
    /function usingTransactionPooler\(\): boolean/,
    "pooler detection must be explicit",
  );
  assert.match(
    source,
    /const pooled = usingTransactionPooler\(\);/,
    "the pool size must be derived from the detected pooler, not hardcoded",
  );
});

test("the Admin pool and Drizzle client are process-global in production", () => {
  const source = readFileSync("src/lib/admin-db.ts", "utf8");

  assert.match(source, /globalForAdminDb\.adminPool = adminPool;/);
  assert.match(source, /globalForAdminDb\.adminDrizzle = adminDrizzle;/);
  assert.doesNotMatch(
    source,
    /NODE_ENV !== "production"[\s\S]{0,180}globalForAdminDb\.adminPool/,
    "route chunks must share the same Admin pool in production",
  );
});

/**
 * PgBouncer does not forward `statement_timeout` or
 * `idle_in_transaction_session_timeout` startup parameters — they must be
 * listed in its ignore list for connections to be accepted at all, and
 * "ignore" drops them. Measured through the pooled endpoint, the app's 30s
 * limits degraded to 5min and 0 (disabled) respectively.
 *
 * They are therefore re-asserted as database-level defaults by
 * drizzle/admin/migrations/20260812_admin_db_session_timeouts.sql. The pool
 * options must STAY in the code as well: they still apply on the direct path,
 * where they take precedence as startup parameters.
 */
test("Admin session safety limits survive the pooler", () => {
  const source = readFileSync("src/lib/admin-db.ts", "utf8");
  const migration = readFileSync(
    "drizzle/admin/migrations/20260812_admin_db_session_timeouts.sql",
    "utf8",
  );

  assert.match(source, /statement_timeout: 30_000/);
  assert.match(source, /idle_in_transaction_session_timeout: 30_000/);

  assert.match(
    migration,
    /ALTER DATABASE railway SET statement_timeout = '30s'/,
  );
  assert.match(
    migration,
    /ALTER DATABASE railway SET idle_in_transaction_session_timeout = '30s'/,
  );
});
