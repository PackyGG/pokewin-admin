import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { FastifyBaseLogger } from "fastify";
import type pg from "pg";

import type { Databases } from "../src/db.js";
import { FiatDepositAccessClient } from "../src/fiat-deposit-access.js";
import { FiatDepositAccessControl } from "../src/fiat-deposit-access-control.js";

const config = {
  FIAT_ACCESS_API_BASE_URL: "https://packy.gg/v1/",
  ADMIN_API_KEY: "admin-key",
  xbypasssecret: "bypass-secret",
};

const defaultSignupAccessMigration = readFileSync(
  new URL(
    "../migrations/056_default_new_signup_fiat_access_off.sql",
    import.meta.url,
  ),
  "utf8",
);

test("per-user Fiat access uses and confirms the backend controller contract", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const client = new FiatDepositAccessClient(config, async (url, init) => {
    requestUrl = String(url);
    requestInit = init;
    return Response.json({
      success: true,
      data: { user_id: "user/123", enabled: true },
    });
  });

  assert.equal(await client.update("user/123", true), true);
  assert.equal(
    requestUrl,
    "https://packy.gg/v1/admin/users/user%2F123/fiat-deposit-access",
  );
  assert.equal(requestInit?.method, "PUT");
  assert.deepEqual(JSON.parse(String(requestInit?.body)), { enabled: true });
  const headers = requestInit?.headers as Record<string, string>;
  assert.equal(
    headers["x-api-key"],
    "admin-key",
  );
  assert.equal(
    headers["x-bypass-secret"],
    "bypass-secret",
  );
  assert.equal(headers["x-admin-api-key"], undefined);
  assert.equal(headers.xbypasssecret, undefined);
});

test("per-user Fiat access rejects an unconfirmed backend value", async () => {
  const client = new FiatDepositAccessClient(config, async () =>
    Response.json({
      success: true,
      data: { user_id: "user-1", enabled: false },
    }),
  );

  await assert.rejects(
    client.update("user-1", true),
    /fiat_deposit_access_confirmation_mismatch/,
  );
});

test("per-user Fiat access fails closed without backend credentials", async () => {
  const client = new FiatDepositAccessClient({
    FIAT_ACCESS_API_BASE_URL: "https://packy.gg/v1",
  });

  await assert.rejects(
    client.update("user-1", false),
    /fiat_deposit_access_admin_key_missing/,
  );
});

test("new signups default to disabled without changing existing accounts", () => {
  assert.match(
    defaultSignupAccessMigration,
    /'new_signups'[\s\S]*?false[\s\S]*?'system:default-new-signup-policy'/,
  );
  assert.match(
    defaultSignupAccessMigration,
    /fiat_deposit_access_cursors\(stream, occurred_at, source_id\)/,
  );
  assert.doesNotMatch(defaultSignupAccessMigration, /'existing_accounts'/);
});

type RolloutFixture = {
  policy_id: string;
  enabled: boolean;
  cutoff_at: Date;
  cursor_at: Date;
  cursor_id: string;
  enqueue_complete: boolean;
  status: "queued" | "running" | "complete" | "stalled";
};

function rolloutControlFixture(
  rollout: RolloutFixture,
  visibleUsers: Array<{ id: string; created_at: Date }>,
) {
  const insertedUsers: string[] = [];
  const antifraudSql: string[] = [];
  const sourceSql: string[] = [];
  const sourceQueries: unknown[][] = [];
  const query = async (text: string, values?: unknown[]) => {
    const sql = text.replace(/\s+/g, " ").trim();
    antifraudSql.push(sql);
    if (
      sql.includes("SELECT r.policy_id")
      && sql.includes("FROM fiat_deposit_access_rollouts")
    ) {
      return { rows: [rollout], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO fiat_deposit_access_operations")) {
      insertedUsers.push(String(values?.[1]));
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE fiat_deposit_access_rollouts")) {
      rollout.cursor_at = values?.[1] as Date;
      rollout.cursor_id = String(values?.[2]);
      rollout.enqueue_complete ||= values?.[3] === true;
      if (rollout.status === "queued") rollout.status = "running";
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  };
  const db = {
    antifraud: {
      query,
      connect: async () => ({ query, release() {} }),
    } as unknown as pg.Pool,
    source: {
      query: async (text: string, values?: unknown[]) => {
        sourceSql.push(text.replace(/\s+/g, " ").trim());
        sourceQueries.push(values ?? []);
        const [cursorAt, cursorId, cutoffAt, limit] = values as [
          Date,
          string,
          Date,
          number,
        ];
        const rows = visibleUsers
          .filter((user) =>
            user.created_at < cutoffAt
            && (
              user.created_at > cursorAt
              || (
                user.created_at.getTime() === cursorAt.getTime()
                && user.id > cursorId
              )
            )
          )
          .sort((left, right) =>
            left.created_at.getTime() - right.created_at.getTime()
            || left.id.localeCompare(right.id)
          )
          .slice(0, limit);
        return { rows, rowCount: rows.length };
      },
    } as unknown as pg.Pool,
    fiatDevSource: null,
  } satisfies Databases;
  const control = new FiatDepositAccessControl(
    db,
    { update: async () => true } as unknown as FiatDepositAccessClient,
    { warn() {} } as unknown as FastifyBaseLogger,
  );
  return { control, insertedUsers, antifraudSql, sourceSql, sourceQueries };
}

type ExistingRolloutSeams = {
  enqueueExistingAccounts(): Promise<string | null>;
  refreshRollout(policyId: string): Promise<void>;
};

type NewSignupSeams = {
  enqueueNewSignups(): Promise<void>;
};

test("existing-account rollout verifies from the beginning before completion", async () => {
  const cutoff = new Date("2026-08-07T02:00:00.000Z");
  const rollout: RolloutFixture = {
    policy_id: "policy-1",
    enabled: true,
    cutoff_at: cutoff,
    cursor_at: new Date("2026-08-07T01:00:00.000Z"),
    cursor_id: "user-newer",
    enqueue_complete: false,
    status: "running",
  };
  const fixture = rolloutControlFixture(rollout, [{
    id: "late-visible-user",
    created_at: new Date("2026-08-06T23:00:00.000Z"),
  }]);
  const seams = fixture.control as unknown as ExistingRolloutSeams;

  // The forward cursor sees no rows. This starts verification at the epoch;
  // it must not put the cutoff completion sentinel in place yet.
  assert.equal(await seams.enqueueExistingAccounts(), null);
  assert.equal(rollout.enqueue_complete, true);
  assert.equal(rollout.cursor_at.getTime(), 0);
  assert.equal(rollout.status, "running");
  assert.deepEqual(fixture.insertedUsers, []);

  assert.equal(await seams.enqueueExistingAccounts(), "policy-1");
  assert.deepEqual(fixture.insertedUsers, ["late-visible-user"]);
  assert.equal(
    rollout.cursor_at.toISOString(),
    "2026-08-06T23:00:00.000Z",
  );

  // Only an empty page after the verification pass establishes the sentinel
  // used by refreshRollout's completion condition.
  assert.equal(await seams.enqueueExistingAccounts(), null);
  assert.equal(rollout.cursor_at, cutoff);
  await seams.refreshRollout("policy-1");
  assert.match(
    fixture.antifraudSql.at(-1) ?? "",
    /r\.enqueue_complete AND r\.cursor_at >= p\.cutoff_at AND stats\.open = 0/,
  );
  assert.ok(fixture.sourceQueries.every((values) => values[3] === 100));
  assert.ok(fixture.sourceSql.every((sql) =>
    sql.startsWith("SELECT id, created_at FROM \"user\"")
    && sql.endsWith("LIMIT $4")
  ));
});

test("a completed rollout keeps reconciling bounded pages for late mirror rows", async () => {
  const cutoff = new Date("2026-08-07T02:00:00.000Z");
  const rollout: RolloutFixture = {
    policy_id: "policy-2",
    enabled: false,
    cutoff_at: cutoff,
    cursor_at: cutoff,
    cursor_id: "",
    enqueue_complete: true,
    status: "complete",
  };
  const fixture = rolloutControlFixture(rollout, [{
    id: "very-late-user",
    created_at: new Date("2026-07-01T00:00:00.000Z"),
  }]);
  const seams = fixture.control as unknown as ExistingRolloutSeams;

  assert.equal(await seams.enqueueExistingAccounts(), null);
  assert.equal(rollout.cursor_at.getTime(), 0);
  assert.equal(rollout.status, "complete");

  assert.equal(await seams.enqueueExistingAccounts(), "policy-2");
  assert.deepEqual(fixture.insertedUsers, ["very-late-user"]);
  assert.ok(fixture.sourceQueries.every((values) => values[3] === 100));
  assert.ok(fixture.sourceSql.every((sql) =>
    sql.startsWith("SELECT id, created_at FROM \"user\"")
    && sql.endsWith("LIMIT $4")
  ));
});

test("new-signup reconciliation catches rows behind the live mirror cursor", async () => {
  const effectiveAt = new Date("2026-08-01T00:00:00.000Z");
  const lateUser = {
    id: "late-new-signup",
    created_at: new Date("2026-08-02T00:00:00.000Z"),
  };
  const cursors = new Map<string, { occurred_at: Date; source_id: string }>([
    ["new_signups", {
      occurred_at: new Date("2026-08-03T00:00:00.000Z"),
      source_id: "newer-user",
    }],
    ["new_signups_reconciliation", {
      occurred_at: new Date("2026-08-03T00:00:00.000Z"),
      source_id: "newer-user",
    }],
  ]);
  const operationKeys = new Set<string>();
  const sourceSql: string[] = [];
  const sourceParams: unknown[][] = [];
  const query = async (text: string, values?: unknown[]) => {
    const sql = text.replace(/\s+/g, " ").trim();
    if (
      sql.includes("FROM fiat_deposit_access_policies")
      && sql.includes("scope = 'new_signups'")
    ) {
      return {
        rows: [{
          id: "new-policy-1",
          generation: "1",
          enabled: false,
          effective_at: effectiveAt,
          cutoff_at: null,
          actor_id: "system",
        }],
        rowCount: 1,
      };
    }
    if (
      sql.startsWith("INSERT INTO fiat_deposit_access_cursors")
      && !cursors.has("new_signups_reconciliation")
    ) {
      cursors.set("new_signups_reconciliation", {
        occurred_at: values?.[0] as Date,
        source_id: "",
      });
      return { rows: [], rowCount: 1 };
    }
    if (
      sql.startsWith("SELECT stream, occurred_at, source_id")
      && sql.includes("FROM fiat_deposit_access_cursors")
    ) {
      return {
        rows: [...cursors].map(([stream, cursor]) => ({ stream, ...cursor })),
        rowCount: cursors.size,
      };
    }
    if (
      sql.startsWith("UPDATE fiat_deposit_access_cursors")
      && sql.includes("stream = 'new_signups_reconciliation'")
    ) {
      cursors.set("new_signups_reconciliation", {
        occurred_at: values?.[0] as Date,
        source_id: "",
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO fiat_deposit_access_operations")) {
      const key = `${values?.[0]}:${values?.[1]}`;
      const inserted = !operationKeys.has(key);
      operationKeys.add(key);
      return { rows: [], rowCount: inserted ? 1 : 0 };
    }
    if (
      sql.startsWith("UPDATE fiat_deposit_access_cursors")
      && typeof values?.[2] === "string"
    ) {
      cursors.set(values[2], {
        occurred_at: values[0] as Date,
        source_id: String(values[1]),
      });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  };
  const db = {
    antifraud: {
      query,
      connect: async () => ({ query, release() {} }),
    } as unknown as pg.Pool,
    source: {
      query: async (text: string, values?: unknown[]) => {
        const sql = text.replace(/\s+/g, " ").trim();
        sourceSql.push(sql);
        sourceParams.push(values ?? []);
        const [cursorAt, cursorId, limit] = values as [Date, string, number];
        const rows = (
          lateUser.created_at > cursorAt
          || (
            lateUser.created_at.getTime() === cursorAt.getTime()
            && lateUser.id > cursorId
          )
        ) ? [lateUser].slice(0, limit) : [];
        return { rows, rowCount: rows.length };
      },
    } as unknown as pg.Pool,
    fiatDevSource: null,
  } satisfies Databases;
  const control = new FiatDepositAccessControl(
    db,
    { update: async () => true } as unknown as FiatDepositAccessClient,
    { warn() {} } as unknown as FastifyBaseLogger,
  );
  const seams = control as unknown as NewSignupSeams;

  // Both cursors initially sit beyond the late-visible tuple. The independent
  // reconciliation stream cycles back without moving the low-latency cursor.
  await seams.enqueueNewSignups();
  assert.equal(
    cursors.get("new_signups")?.occurred_at.toISOString(),
    "2026-08-03T00:00:00.000Z",
  );
  assert.equal(
    cursors.get("new_signups_reconciliation")?.occurred_at,
    effectiveAt,
  );

  await seams.enqueueNewSignups();
  assert.deepEqual([...operationKeys], ["new-policy-1:late-new-signup"]);
  assert.equal(
    cursors.get("new_signups_reconciliation")?.source_id,
    lateUser.id,
  );

  // A second cycle sees the row again but the durable operation key absorbs
  // it, so reconciliation remains safe to run for the service lifetime.
  await seams.enqueueNewSignups();
  await seams.enqueueNewSignups();
  assert.equal(operationKeys.size, 1);
  assert.ok(sourceParams.every((values) => values[2] === 100));
  assert.ok(sourceSql.every((sql) =>
    sql.startsWith("SELECT id, created_at FROM \"user\"")
    && sql.endsWith("LIMIT $3")
  ));
  assert.ok(sourceSql.some((sql) =>
    sql.includes("created_at < now() - interval '5 minutes'")
  ));
  assert.ok(sourceSql.some((sql) =>
    !sql.includes("created_at < now() - interval '5 minutes'")
  ));
});
