import assert from "node:assert/strict";
import test from "node:test";

// admin-db.ts constructs its `pg.Pool` at module load and throws if
// ADMIN_DATABASE_URL isn't set. `Pool` itself is lazy (no connection until a
// query runs) and every test below injects `deps` to bypass the real
// `adminDrizzle` write path, so a dummy connection string is enough — no
// live database is touched. The import is deferred into an async helper
// (rather than a top-level await) because this fixture suite runs under a
// CJS transform that rejects top-level await.
process.env.ADMIN_DATABASE_URL ??=
  "postgres://test:test@localhost:5432/test";

async function loadDurableAudit() {
  const mod = await import("../../src/lib/admin-audit");
  return mod.createAdminAuditEventDurable;
}

test("durable audit write succeeds on retry without touching the fallback path", async () => {
  let attempts = 0;
  let fallbackCalled = false;
  const createAdminAuditEventDurable = await loadDurableAudit();
  const outcome = await createAdminAuditEventDurable(
    { adminUserId: null, eventType: "test.event" },
    {
      write: async () => {
        attempts += 1;
        if (attempts < 2) throw new Error("transient");
      },
      writeFallback: async () => {
        fallbackCalled = true;
        return "unused";
      },
      notify: async () => {},
      delay: async () => {},
    },
  );

  assert.equal(outcome.status, "recorded");
  assert.equal(attempts, 2);
  assert.equal(fallbackCalled, false);
});

test("createAdminAuditEvent throwing on every attempt is captured by the durable fallback row, not silently dropped", async () => {
  let writeAttempts = 0;
  let fallbackCaptured: {
    eventType: string;
    targetUserId?: string;
  } | null = null;
  let notified = false;

  const createAdminAuditEventDurable = await loadDurableAudit();
  const outcome = await createAdminAuditEventDurable(
    {
      adminUserId: "11111111-1111-1111-1111-111111111111",
      eventType: "whop_refund_account_recovered",
      targetUserId: "user-1",
      metadata: { recovered_total_usd: 42 },
    },
    {
      write: async () => {
        writeAttempts += 1;
        throw new Error("admin db unavailable");
      },
      writeFallback: async (params, errorMessage, attemptCount) => {
        fallbackCaptured = {
          eventType: params.eventType,
          targetUserId: params.targetUserId,
        };
        assert.ok(errorMessage.includes("admin db unavailable"));
        assert.equal(attemptCount, writeAttempts);
        return "fallback-row-id";
      },
      notify: async () => {
        notified = true;
      },
      delay: async () => {},
    },
  );

  assert.equal(outcome.status, "fallback");
  assert.equal(
    outcome.status === "fallback" ? outcome.fallbackId : null,
    "fallback-row-id",
  );
  assert.deepEqual(fallbackCaptured, {
    eventType: "whop_refund_account_recovered",
    targetUserId: "user-1",
  });
  assert.ok(notified, "the failure alert path should have been attempted");
  // Initial attempt + 3 backoff retries = 4 attempts before falling back.
  assert.equal(writeAttempts, 4);
});

test("a lost outcome is only reported when the durable fallback row insert also fails", async () => {
  let notified = false;
  const createAdminAuditEventDurable = await loadDurableAudit();
  const outcome = await createAdminAuditEventDurable(
    { adminUserId: null, eventType: "whop_refund_accounts_recovered" },
    {
      write: async () => {
        throw new Error("admin db unavailable");
      },
      writeFallback: async () => {
        throw new Error("fallback insert also failed");
      },
      notify: async () => {
        notified = true;
      },
      delay: async () => {},
    },
  );

  assert.equal(outcome.status, "lost");
  assert.ok(
    notified,
    "the alert path should still be attempted even when the fallback row fails",
  );
});

test("a notify failure never changes the outcome — the fallback row is still what matters", async () => {
  const createAdminAuditEventDurable = await loadDurableAudit();
  const outcome = await createAdminAuditEventDurable(
    { adminUserId: null, eventType: "test.event" },
    {
      write: async () => {
        throw new Error("admin db unavailable");
      },
      writeFallback: async () => "fallback-row-id",
      notify: async () => {
        throw new Error("discord unavailable");
      },
      delay: async () => {},
    },
  );

  assert.equal(outcome.status, "fallback");
});
