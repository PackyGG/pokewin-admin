import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type pg from "pg";

import type { Databases } from "../src/db.js";
import {
  cleanupExpiredNetworkSnapshots,
  NETWORK_SNAPSHOT_CLEANUP_BATCH_SIZE,
  NETWORK_SNAPSHOT_RETENTION_DAYS,
} from "../src/network-risk.js";

test("network snapshot cleanup stays outside evidence windows and is bounded", async () => {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const client = {
    async query(sql: string, values: unknown[] = []) {
      queries.push({ sql, values });
      if (sql.includes("pg_try_advisory_xact_lock")) {
        return { rows: [{ acquired: true }], rowCount: 1 };
      }
      if (sql.includes("SELECT snapshot.id")) {
        return { rows: [{ id: "00000000-0000-0000-0000-000000000001" }], rowCount: 1 };
      }
      if (sql.includes("DELETE FROM network_snapshots")) {
        return { rows: [{ id: "00000000-0000-0000-0000-000000000001" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  } as unknown as pg.PoolClient;
  const antifraud = { connect: async () => client } as unknown as pg.Pool;
  const db = { source: antifraud, fiatDevSource: null, antifraud } satisfies Databases;

  const deleted = await cleanupExpiredNetworkSnapshots(db);

  assert.equal(deleted, 1);
  assert.ok(NETWORK_SNAPSHOT_RETENTION_DAYS > 30);
  assert.ok(NETWORK_SNAPSHOT_CLEANUP_BATCH_SIZE <= 10);
  const candidate = queries.find(({ sql }) => sql.includes("SELECT snapshot.id"));
  assert.deepEqual(candidate?.values, [
    NETWORK_SNAPSHOT_RETENTION_DAYS,
    NETWORK_SNAPSHOT_CLEANUP_BATCH_SIZE,
  ]);
  const transaction = queries.map(({ sql }) => sql).join("\n");
  assert.match(transaction, /BEGIN/);
  assert.match(transaction, /scanned_at < now\(\) - \(\$1::text \|\| ' days'\)::interval/);
  assert.match(transaction, /newer\.network_key = snapshot\.network_key/);
  assert.match(transaction, /newer\.root_user_id = snapshot\.root_user_id/);
  assert.equal(
    (transaction.match(/\(newer\.scanned_at, newer\.id\) > \(snapshot\.scanned_at, snapshot\.id\)/g) ?? [])
      .length,
    2,
  );
  assert.match(transaction, /pg_try_advisory_xact_lock/);
  assert.match(transaction, /LIMIT \$2/);
  assert.match(transaction, /FOR UPDATE OF snapshot SKIP LOCKED/);
  assert.match(
    transaction,
    /DELETE FROM network_snapshots snapshot[\s\S]*c\.network_snapshot_id = snapshot\.id/,
  );
  assert.ok(
    transaction.indexOf("FOR UPDATE OF snapshot") <
      transaction.indexOf("c.network_snapshot_id = snapshot.id"),
  );
  assert.match(transaction, /COMMIT/);
});

test("retention migration adds the global cutoff index", async () => {
  const migration = await readFile(
    new URL("../migrations/084_network_snapshot_retention.sql", import.meta.url),
    "utf8",
  );

  assert.match(
    migration,
    /CREATE INDEX IF NOT EXISTS network_snapshots_scanned_id_idx\s+ON network_snapshots\(scanned_at, id\)/,
  );
  assert.match(
    migration,
    /CREATE INDEX IF NOT EXISTS cases_network_snapshot_idx\s+ON cases\(network_snapshot_id\)\s+WHERE network_snapshot_id IS NOT NULL/,
  );
});

test("network snapshot cleanup destroys a client when rollback is uncertain", async () => {
  const releases: Array<boolean | Error | undefined> = [];
  const client = {
    async query(sql: string) {
      if (sql === "BEGIN") return { rows: [], rowCount: 0 };
      if (sql === "ROLLBACK") throw new Error("rollback failed");
      throw new Error("cleanup failed");
    },
    release(destroy?: boolean | Error) {
      releases.push(destroy);
    },
  } as unknown as pg.PoolClient;
  const antifraud = { connect: async () => client } as unknown as pg.Pool;
  const db = { source: antifraud, fiatDevSource: null, antifraud } satisfies Databases;

  await assert.rejects(cleanupExpiredNetworkSnapshots(db), /cleanup failed/);
  assert.deepEqual(releases, [true]);
});

test("network worker runs best-effort retention only after normal jobs", async () => {
  const source = await readFile(
    new URL("../src/network-risk.ts", import.meta.url),
    "utf8",
  );
  const work = source.slice(
    source.indexOf("private async work("),
    source.indexOf("private async recoverStaleJobs("),
  );

  assert.ok(work.indexOf("await this.claimJob()") < work.indexOf("cleanupExpiredNetworkSnapshots"));
  assert.match(work, /NETWORK_SNAPSHOT_CLEANUP_INTERVAL_MS/);
  assert.match(work, /catch \(error\)/);
  assert.match(work, /cleanup deferred after failure/);
});
