import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
// `dist/src/migrate.js` and `src/migrate.ts` sit at different depths, so the
// compiled and the tsx/dev layouts resolve the same directory differently.
const migrationDirCandidates = [
  join(here, "..", "..", "migrations"),
  join(here, "..", "migrations"),
];

// Filenames that legitimately share a leading numeric prefix. These predate
// the duplicate-prefix guard below and were already applied in production
// before it existed — renaming them would desync every deployment's
// schema_migrations record and risk re-running a "new" file that's really
// just a rename. They stay as permanent historical exceptions.
//
// Do NOT add to this list: a genuinely new migration must get its own,
// currently-unused numeric prefix instead of colliding with an existing one.
const ALLOWED_DUPLICATE_PREFIXES: Readonly<Record<string, readonly string[]>> = {
  "002": ["002_security_audit.sql", "002_split_deposit_risk.sql"],
  "003": ["003_poller_hardening.sql", "003_signup_assessments.sql"],
  "014": ["014_signup_live_behavior_tuning.sql", "014_signup_review_delivery.sql"],
  "018": ["018_fiat_email_domain_blacklist.sql", "018_risky_locations.sql"],
  "022": ["022_split_high_risk_fiat_destination.sql", "022_suspicious_deposit_clusters.sql"],
  "045": ["045_api_hardening.sql", "045_fiat_assessment_provider_payment_id.sql"],
};

function leadingNumericPrefix(filename: string): string | null {
  const match = /^(\d+)/.exec(filename);
  return match?.[1] ?? null;
}

/**
 * Fails loudly if any migration filenames share a leading numeric prefix
 * unless that exact filename is on the historical allowlist above.
 * Alphabetical filename order already keeps execution deterministic even
 * with duplicate prefixes, but "migration 014" becomes ambiguous the moment
 * a human refers to it by number — so new collisions must never happen.
 */
export function checkDuplicatePrefixes(files: readonly string[]): void {
  const byPrefix = new Map<string, string[]>();
  for (const file of files) {
    const prefix = leadingNumericPrefix(file);
    if (!prefix) continue;
    const group = byPrefix.get(prefix) ?? [];
    group.push(file);
    byPrefix.set(prefix, group);
  }

  for (const [prefix, group] of byPrefix) {
    if (group.length < 2) continue;
    const allowed = new Set(ALLOWED_DUPLICATE_PREFIXES[prefix] ?? []);
    const unexpected = group.filter((file) => !allowed.has(file));
    if (unexpected.length > 0) {
      throw new Error(
        `Duplicate migration number "${prefix}" is not on the historical allowlist: ` +
          `${group.join(", ")}. Give new migrations their own unused numeric prefix ` +
          `instead of colliding with an existing one.`,
      );
    }
  }
}

function normalizeLineEndings(content: Buffer | string): string {
  const text = Buffer.isBuffer(content) ? content.toString("utf8") : content;
  return text.replaceAll("\r\n", "\n");
}

function hash(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Migration identity is independent of the checkout platform's LF/CRLF
 * conversion. Every checksum written from now on uses LF as its canonical
 * representation; every other byte remains significant.
 */
export function computeChecksum(content: Buffer | string): string {
  return hash(normalizeLineEndings(content));
}

function legacyLineEndingChecksums(content: Buffer): Set<string> {
  const canonical = normalizeLineEndings(content);
  return new Set([
    // Old releases hashed the raw bytes. Keep accepting that exact form while
    // upgrading its metadata to the canonical checksum below.
    hash(content),
    // A migration first applied from a Windows checkout may have a raw CRLF
    // checksum while the currently-deployed checkout contains LF bytes.
    hash(canonical.replaceAll("\n", "\r\n")),
  ]);
}

async function resolveMigrations(): Promise<{ dir: string; files: string[] }> {
  for (const dir of migrationDirCandidates) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    const files = entries.filter((name) => /^\d+.*\.sql$/.test(name)).sort();
    if (files.length > 0) return { dir, files };
  }
  throw new Error(
    `Unable to locate the antifraud migrations directory (looked in ${migrationDirCandidates.join(", ")})`,
  );
}

/**
 * Historical rows recorded before the `checksum` column existed have no
 * baseline to compare against. On startup, stamp each of them with the
 * checksum of the file currently on disk under that filename. This can't
 * retroactively prove the file was never edited before today, but from this
 * point on any further edit to an already-applied migration is detectable.
 */
async function backfillMissingChecksums(
  client: pg.PoolClient,
  migrationsDir: string,
): Promise<void> {
  const missing = await client.query<{ version: string }>(
    "SELECT version FROM schema_migrations WHERE checksum IS NULL",
  );
  if (missing.rows.length === 0) return;

  let backfilled = 0;
  for (const { version } of missing.rows) {
    let raw: Buffer;
    try {
      raw = await readFile(join(migrationsDir, version));
    } catch {
      // A historical row for a file that no longer exists on disk. There's
      // nothing to baseline against, so leave it null and move on.
      continue;
    }
    await client.query(
      "UPDATE schema_migrations SET checksum = $1 WHERE version = $2",
      [computeChecksum(raw), version],
    );
    backfilled += 1;
  }

  if (backfilled > 0) {
    console.log(
      `[migrate] Backfilled a checksum baseline for ${backfilled} previously-applied ` +
        `migration(s) (${missing.rows.length - backfilled} skipped: file no longer on disk). ` +
        `Drift will be detectable from this point forward.`,
    );
  }
}

type MigrationOptions = {
  lockDeadlineAt?: number;
  shouldAbort?: () => boolean;
  redactErrorMessage?: (error: unknown) => string;
};

function migrationStartupError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "57P03" });
}

export async function migrate(
  pool: pg.Pool,
  options: MigrationOptions = {},
): Promise<void> {
  const { dir: migrationsDir, files } = await resolveMigrations();
  checkDuplicatePrefixes(files);

  const client = await pool.connect();
  let advisoryLockHeld = false;
  let statementTimeoutDisabled = false;
  let sessionStateUncertain = false;
  try {
    // Migration 083 makes statement_timeout=15000 the database-role default
    // for normal queries. Migration work is neither normal nor interruptible:
    // Polling pg_try_advisory_lock keeps lock acquisition inside the caller's
    // startup deadline. Once this process owns the lock, actual migration DDL
    // remains deliberately uncancelled so a platform timeout cannot interrupt
    // a transaction halfway through its schema change.
    for (;;) {
      if (options.shouldAbort?.()) {
        throw migrationStartupError("Migration startup aborted during shutdown");
      }
      if (
        options.lockDeadlineAt !== undefined &&
        Date.now() >= options.lockDeadlineAt
      ) {
        throw migrationStartupError("Timed out waiting for the migration lock");
      }
      const queryTimeoutMs = Math.max(
        1,
        Math.min(
          5_000,
          options.lockDeadlineAt === undefined
            ? 5_000
            : options.lockDeadlineAt - Date.now(),
        ),
      );
      let lock: pg.QueryResult<{ locked: boolean }>;
      try {
        const query = {
          text: "SELECT pg_try_advisory_lock($1) AS locked",
          values: [841_772_991],
          query_timeout: queryTimeoutMs,
        } as pg.QueryConfig;
        lock = await client.query<{ locked: boolean }>(query);
      } catch (error) {
        sessionStateUncertain = true;
        throw error;
      }
      if (lock.rows[0]?.locked) {
        advisoryLockHeld = true;
        break;
      }
      const remainingMs =
        options.lockDeadlineAt === undefined
          ? 250
          : Math.max(0, options.lockDeadlineAt - Date.now());
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, remainingMs)));
    }
    try {
      const query = {
        text: "SET statement_timeout = 0",
        query_timeout: 5_000,
      } as pg.QueryConfig;
      await client.query(query);
      statementTimeoutDisabled = true;
    } catch (error) {
      sessionStateUncertain = true;
      throw error;
    }
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text
    `);

    await backfillMissingChecksums(client, migrationsDir);

    for (const file of files) {
      const exists = await client.query<{ exists: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = $1) AS exists",
        [file],
      );
      if (exists.rows[0]?.exists) {
        const stored = await client.query<{ checksum: string | null }>(
          "SELECT checksum FROM schema_migrations WHERE version = $1",
          [file],
        );
        const checksum = stored.rows[0]?.checksum ?? null;
        if (checksum) {
          const raw = await readFile(join(migrationsDir, file));
          const current = computeChecksum(raw);
          if (current !== checksum) {
            if (!legacyLineEndingChecksums(raw).has(checksum)) {
              throw new Error(
                `Migration "${file}" was already applied but its file content has changed since ` +
                  `(recorded checksum ${checksum}, current ${current}). Already-applied migrations ` +
                  `must never be edited — add a new migration instead.`,
              );
            }
            await client.query(
              `UPDATE schema_migrations
               SET checksum = $1
               WHERE version = $2 AND checksum = $3`,
              [current, file, checksum],
            );
          }
        }
        continue;
      }

      // One read: the SQL text and the checksum both come from the same bytes,
      // so the record can never describe a different revision than the one
      // that was executed.
      const raw = await readFile(join(migrationsDir, file));
      const checksum = computeChecksum(raw);
      await client.query("BEGIN");
      try {
        await client.query(raw.toString("utf8"));
        await client.query(
          "INSERT INTO schema_migrations(version, checksum) VALUES ($1, $2)",
          [file, checksum],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    // Both cleanup statements are best-effort: on a dead connection they would
    // otherwise throw out of `finally` and REPLACE the real migration error,
    // leaving the logs describing the symptom instead of the cause.
    let cleanupError: Error | undefined;
    const asError = (error: unknown): Error =>
      error instanceof Error ? error : new Error(String(error));
    if (sessionStateUncertain) {
      client.release(true);
    } else {
    if (advisoryLockHeld) {
      await client
        .query({
          text: "SELECT pg_advisory_unlock($1)",
          values: [841_772_991],
          query_timeout: 5_000,
        } as pg.QueryConfig)
        .catch((error: unknown) => {
          cleanupError = asError(error);
          console.error("[migrate] advisory unlock failed", {
            message:
              options.redactErrorMessage?.(cleanupError) ??
              "database cleanup failed",
          });
        });
    }
    if (statementTimeoutDisabled) {
      await client
        .query({
          text: "RESET statement_timeout",
          query_timeout: 5_000,
        } as pg.QueryConfig)
        .catch((error: unknown) => {
          cleanupError ??= asError(error);
        });
    }
    // Both statements above are session-scoped, so a failed cleanup on a
    // still-live connection puts a client back into the shared runtime pool
    // that may hold the migration advisory lock and/or statement_timeout=0 —
    // silently removing the 15s bound from unrelated queries and blocking the
    // next deploy's migrate(). Releasing WITH an error destroys the client
    // instead of reusing it; the pool just opens a fresh one.
    client.release(cleanupError);
    }
  }
}
