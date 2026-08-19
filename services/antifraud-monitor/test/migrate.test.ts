import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type pg from "pg";

import { checkDuplicatePrefixes, computeChecksum, migrate } from "../src/migrate.js";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

async function realMigrationFiles(): Promise<string[]> {
  const entries = await readdir(migrationsDir);
  return entries.filter((name) => /^\d+.*\.sql$/.test(name)).sort();
}

type QueryCall = { text: string; values?: unknown[] };

function fakePool(options: {
  appliedVersions?: Set<string>;
  storedChecksums?: Map<string, string | null>;
  nullChecksumVersions?: string[];
} = {}) {
  const calls: QueryCall[] = [];
  const updates: Array<{ version: string; checksum: string }> = [];
  const inserts: Array<{ version: string; checksum: string }> = [];
  let released = false;

  const client = {
    query: async (text: string, values?: unknown[]) => {
      calls.push({ text, values });

      if (text.includes("pg_try_advisory_lock")) {
        return { rows: [{ locked: true }], rowCount: 1 };
      }

      if (text.includes("SELECT version FROM schema_migrations WHERE checksum IS NULL")) {
        const versions = options.nullChecksumVersions ?? [];
        return { rows: versions.map((version) => ({ version })), rowCount: versions.length };
      }
      if (
        text.includes("UPDATE schema_migrations") &&
        text.includes("SET checksum")
      ) {
        const [checksum, version] = values as [string, string];
        updates.push({ version, checksum });
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = $1)")) {
        const [version] = values as [string];
        return {
          rows: [{ exists: options.appliedVersions?.has(version) ?? false }],
          rowCount: 1,
        };
      }
      if (text.includes("SELECT checksum FROM schema_migrations WHERE version = $1")) {
        const [version] = values as [string];
        return { rows: [{ checksum: options.storedChecksums?.get(version) ?? null }], rowCount: 1 };
      }
      if (text.includes("INSERT INTO schema_migrations")) {
        const [version, checksum] = values as [string, string];
        inserts.push({ version, checksum });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {
      released = true;
    },
  };

  return {
    pool: { connect: async () => client } as unknown as pg.Pool,
    calls,
    updates,
    inserts,
    released: () => released,
  };
}

test("checksum mismatch on an already-applied migration fails loudly", async () => {
  const files = await realMigrationFiles();
  const target = "059_migration_checksum_guard.sql";
  assert.ok(files.includes(target), "expected the checksum-guard migration to exist on disk");

  const fake = fakePool({
    appliedVersions: new Set(files),
    storedChecksums: new Map([[target, "0".repeat(64)]]),
  });

  await assert.rejects(() => migrate(fake.pool), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, new RegExp(target.replace(/\./g, "\\.")));
    assert.match(error.message, /checksum/i);
    return true;
  });
});

test("migration checksums are stable across LF and CRLF checkouts", () => {
  const lf = "CREATE TABLE example (id text);\nINSERT INTO example VALUES ('one');\n";
  const crlf = lf.replaceAll("\n", "\r\n");

  assert.equal(computeChecksum(lf), computeChecksum(crlf));
  assert.notEqual(
    computeChecksum(lf),
    computeChecksum(lf.replace("'one'", "'two'")),
    "semantic edits must remain detectable",
  );
});

test("applied migration 082 retains its production checksum", async () => {
  const raw = await readFile(
    join(migrationsDir, "082_battle_test_user_sequence_environments.sql"),
  );

  assert.equal(
    computeChecksum(raw),
    "1e55ff2244658cbdf536a99732e718d66f49514a20c37616cdb2f1247de0895f",
    "never edit an already-applied migration; put follow-up changes in a new file",
  );
});

test("a legacy raw CRLF checksum is accepted and upgraded to canonical LF", async () => {
  const files = await realMigrationFiles();
  const target = files[0];
  assert.ok(target, "expected at least one migration file on disk");
  const raw = await readFile(join(migrationsDir, target));
  const lf = raw.toString("utf8").replaceAll("\r\n", "\n");
  const legacyCrLfChecksum = createHash("sha256")
    .update(lf.replaceAll("\n", "\r\n"))
    .digest("hex");
  const canonicalChecksum = computeChecksum(raw);
  assert.notEqual(
    legacyCrLfChecksum,
    canonicalChecksum,
    "fixture must exercise distinct raw line-ending checksums",
  );

  const fake = fakePool({
    appliedVersions: new Set(files),
    storedChecksums: new Map([[target, legacyCrLfChecksum]]),
  });

  await migrate(fake.pool);

  assert.deepEqual(
    fake.updates.find((row) => row.version === target),
    { version: target, checksum: canonicalChecksum },
  );
});

test("a new unapplied migration applies and its checksum is stored", async () => {
  const files = await realMigrationFiles();
  const target = files[files.length - 1];
  assert.ok(target, "expected at least one migration file on disk");

  const applied = new Set(files);
  applied.delete(target);

  const fake = fakePool({ appliedVersions: applied });

  await migrate(fake.pool);

  const expectedChecksum = computeChecksum(await readFile(join(migrationsDir, target!)));
  const stored = fake.inserts.find((row) => row.version === target);
  assert.ok(stored, `expected an INSERT for ${target}`);
  assert.equal(stored!.checksum, expectedChecksum);
});

test("NULL-checksum rows are backfilled from the on-disk file on startup", async () => {
  const files = await realMigrationFiles();
  const first = files[0];
  assert.ok(first, "expected at least one migration file on disk");

  const fake = fakePool({
    appliedVersions: new Set(files),
    nullChecksumVersions: [first],
  });

  await migrate(fake.pool);

  const expectedChecksum = computeChecksum(await readFile(join(migrationsDir, first!)));
  const backfilled = fake.updates.find((row) => row.version === first);
  assert.ok(backfilled, `expected a checksum backfill UPDATE for ${first}`);
  assert.equal(backfilled!.checksum, expectedChecksum);
});

test("the duplicate-prefix guard is silent for the historical allowlisted pairs", () => {
  assert.doesNotThrow(() =>
    checkDuplicatePrefixes([
      "002_security_audit.sql",
      "002_split_deposit_risk.sql",
      "003_poller_hardening.sql",
      "003_signup_assessments.sql",
      "014_signup_live_behavior_tuning.sql",
      "014_signup_review_delivery.sql",
      "018_fiat_email_domain_blacklist.sql",
      "018_risky_locations.sql",
      "022_split_high_risk_fiat_destination.sql",
      "022_suspicious_deposit_clusters.sql",
      "045_api_hardening.sql",
      "045_fiat_assessment_provider_payment_id.sql",
    ]),
  );
});

test("the duplicate-prefix guard fails loudly for a brand new collision", () => {
  assert.throws(
    () => checkDuplicatePrefixes(["099_first_new_thing.sql", "099_second_new_thing.sql"]),
    /099_first_new_thing\.sql.*099_second_new_thing\.sql|099_second_new_thing\.sql.*099_first_new_thing\.sql/s,
  );
});

test("the duplicate-prefix guard fails if a new file is added onto an existing allowlisted prefix", () => {
  assert.throws(() =>
    checkDuplicatePrefixes([
      "002_security_audit.sql",
      "002_split_deposit_risk.sql",
      "002_a_third_intruder.sql",
    ]),
  );
});

test("the current on-disk migrations directory has no un-allowlisted duplicate prefixes", async () => {
  const files = await realMigrationFiles();
  assert.doesNotThrow(() => checkDuplicatePrefixes(files));
});

test("migration lock acquisition honors the startup deadline", async () => {
  let releasedWith: Error | undefined;
  const client = {
    query: async (text: string) => {
      if (text.includes("pg_try_advisory_lock")) {
        return { rows: [{ locked: false }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: (error?: Error) => {
      releasedWith = error;
    },
  };

  await assert.rejects(
    () =>
      migrate(
        { connect: async () => client } as unknown as pg.Pool,
        { lockDeadlineAt: Date.now() },
      ),
    /Timed out waiting for the migration lock/,
  );
  assert.equal(releasedWith, undefined);
});

test("migration cleanup redacts direct connection errors before logging", async () => {
  const secret = "postgresql://user:very-secret@example.test/db";
  const logged: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...values: unknown[]) => logged.push(values);
  const client = {
    query: async (text: string) => {
      if (text.includes("pg_try_advisory_lock")) {
        return { rows: [{ locked: true }], rowCount: 1 };
      }
      if (text.includes("pg_advisory_unlock")) {
        throw new Error(`connection failed for ${secret}`);
      }
      if (text.includes("SELECT version FROM schema_migrations")) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("SELECT EXISTS")) {
        return { rows: [{ exists: true }], rowCount: 1 };
      }
      if (text.includes("SELECT checksum")) {
        return { rows: [{ checksum: null }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };

  try {
    await migrate(
      { connect: async () => client } as unknown as pg.Pool,
      {
        redactErrorMessage: (error) =>
          String(error instanceof Error ? error.message : error).replaceAll(
            secret,
            "[redacted]",
          ),
      },
    );
  } finally {
    console.error = originalConsoleError;
  }

  const rendered = JSON.stringify(logged);
  assert.doesNotMatch(rendered, /very-secret/);
  assert.match(rendered, /\[redacted\]/);
});
