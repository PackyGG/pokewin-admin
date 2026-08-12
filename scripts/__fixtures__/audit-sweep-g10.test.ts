import assert from "node:assert/strict";
import test from "node:test";

// See admin-audit-durable.test.ts for why a dummy connection string is enough:
// `pg.Pool` is lazy and every test here injects `deps`, so no database is
// touched. The import stays inside a helper because this fixture suite runs
// under a CJS transform that rejects top-level await.
process.env.ADMIN_DATABASE_URL ??= "postgres://test:test@localhost:5432/test";

async function loadDurableAudit() {
  const mod = await import("../../src/lib/admin-audit");
  return mod.createAdminAuditEventDurable;
}

type Attempted = { writes: number; fallbackAttemptCount: number | null };

async function runDurableWrite(thrown: unknown): Promise<Attempted> {
  const createAdminAuditEventDurable = await loadDurableAudit();
  const state: Attempted = { writes: 0, fallbackAttemptCount: null };
  await createAdminAuditEventDurable(
    { adminUserId: null, eventType: "test.event" },
    {
      write: async () => {
        state.writes += 1;
        throw thrown;
      },
      writeFallback: async (_params, _message, attemptCount) => {
        state.fallbackAttemptCount = attemptCount;
        return "fallback-id";
      },
      notify: async () => {},
      delay: async () => {},
    },
  );
  return state;
}

test("admin pool exhaustion short-circuits the durable audit retry loop", async () => {
  // pg-pool's own queue timeout. Retrying parks another connectionTimeoutMillis
  // (10 s) each time, so the four attempts would burn the serverless budget
  // before the durable fallback row is ever attempted.
  const pooled = await runDurableWrite(
    new Error("timeout exceeded when trying to connect"),
  );
  assert.equal(pooled.writes, 1);
  assert.equal(pooled.fallbackAttemptCount, 1);

  // PostgreSQL-side exhaustion, reported through `code` rather than `message`,
  // and wrapped the way Drizzle wraps driver errors.
  const serverSide = await runDurableWrite(
    new Error("query failed", {
      cause: Object.assign(new Error("sorry, too many clients already"), {
        code: "53300",
      }),
    }),
  );
  assert.equal(serverSide.writes, 1);
  assert.equal(serverSide.fallbackAttemptCount, 1);
});

test("ordinary admin audit write failures still exhaust the retry budget", async () => {
  const transient = await runDurableWrite(new Error("admin db unavailable"));
  // Initial attempt + 3 backoff retries.
  assert.equal(transient.writes, 4);
  assert.equal(transient.fallbackAttemptCount, 4);
});

test("the whop auto-ban list only pays for a COUNT scan when a search narrows it", async () => {
  // antifraud_signals has no index on `kind`, so each of these statements is a
  // full pass over the signal stream. Without a search term the unfiltered
  // status GROUP BY already carries the total, and the second pass is waste.
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(
    new URL("../../src/lib/antifraud/auto-bans.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /const needsCountScan = search !== null;/);
  assert.match(source, /needsCountScan\s*\n\s*\? adminDrizzle\.execute/);
});
