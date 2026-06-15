import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assertReadOnlySql,
  isReadOnlySql,
  ClickHouseReadOnlyError,
} from "../../src/lib/clickhouse/guards";

test("allows legitimate read statements", () => {
  const ok = [
    "SELECT 1",
    "WITH a AS (SELECT 1 AS x) SELECT x FROM a",
    "SELECT * FROM events WHERE created_at > now() - INTERVAL 1 DAY", // CREATE not matched in created_at
    "SELECT replaceAll(name, 'a', 'b') FROM users",                   // replace not matched in replaceAll
    "SELECT * FROM ledger SETTINGS max_threads = 4",                  // SET not matched in SETTINGS
    "SELECT * FROM system.tables",                                    // reading system.* is fine
    "SELECT * FROM user_inventory WHERE _peerdb_is_deleted = 0",      // DELETE not matched in _is_deleted
    "SHOW CREATE TABLE ledger_transactions",                         // SHOW bypasses the CREATE scan
    "SHOW TABLES",
    "DESCRIBE TABLE users",
    "EXPLAIN SELECT 1",
    "SELECT 1 /* DROP TABLE x */",                                   // keyword hidden in a comment
    "SELECT 1 -- DROP TABLE x",
    "SELECT 1;",                                                      // single trailing semicolon
  ];
  for (const sql of ok) {
    assert.equal(isReadOnlySql(sql), true, `expected allowed: ${sql}`);
  }
});

test("rejects writes, DDL, privilege, and maintenance statements", () => {
  const bad = [
    "INSERT INTO t VALUES (1)",
    "UPDATE t SET x = 1",
    "ALTER TABLE t DROP COLUMN c",
    "DROP TABLE t",
    "TRUNCATE TABLE t",
    "CREATE TABLE t (x Int)",
    "OPTIMIZE TABLE t FINAL",
    "SYSTEM RELOAD CONFIG",
    "SET readonly = 0",
    "GRANT SELECT ON db.* TO user",
    "RENAME TABLE a TO b",
    "ATTACH TABLE t",
    "KILL QUERY WHERE 1",
    "SELECT 1; DROP TABLE t",                // multi-statement piggyback
    "SELECT * INTO OUTFILE 'x' FROM t",      // result exfil to file
    "/* only a comment */",
    "",
  ];
  for (const sql of bad) {
    assert.equal(isReadOnlySql(sql), false, `expected rejected: ${sql}`);
  }
});

test("assertReadOnlySql throws ClickHouseReadOnlyError", () => {
  assert.throws(() => assertReadOnlySql("DROP TABLE t"), ClickHouseReadOnlyError);
});
