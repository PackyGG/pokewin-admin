import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import type { Databases } from "../src/db.js";
import {
  BACKFILL_BUDGET_MS,
  BACKFILL_CHUNK_ROWS,
  registerIdentifierBlocklistRoutes,
} from "../src/identifier-blocklist-routes.js";

const RULE_ID = "11111111-1111-4111-8111-111111111111";

const ruleRow = {
  id: RULE_ID,
  kind: "ip",
  value: "203.0.113.0/24",
  match_mode: "cidr",
  reason: "Blocked from the antifraud admin panel",
  source: "manual",
  effect: "block",
  enabled: true,
  created_by: "admin-1",
  updated_by: "admin-1",
  created_at: new Date("2026-08-01T00:00:00Z"),
  updated_at: new Date("2026-08-01T00:00:00Z"),
  expires_at: null,
  match_count: 0,
  affected_users: 0,
  matches_24h: 0,
  matches_7d: 0,
  matches_30d: 0,
  first_match_at: null,
  last_match_at: null,
  lock_review_count: 0,
  review_only_count: 0,
  vpn_detected: false,
  vpn_providers: [],
  vpn_last_detected_at: null,
};

type ChunkCall = { sql: string; values: unknown[] };

/**
 * Fake antifraud pool that plays the POST /v1/blocklists/:kind path: the
 * normalisation lookup, the transaction on a dedicated client, the chunked
 * backfill, and the trailing listRules read.
 *
 * `snapshotRows` is the size of the simulated `signup_identity_snapshots`
 * keyspace the backfill has to walk; `failBackfill` makes every chunk throw the
 * way a statement timeout (SQLSTATE 57014) would.
 */
function fakeDb(options: {
  snapshotRows: number;
  kind?: "ip" | "fingerprint";
  failBackfill?: boolean;
  onChunk?: () => void;
}) {
  const chunks: ChunkCall[] = [];
  const inserts: ChunkCall[] = [];
  let served = 0;
  const query = async (sql: string, values?: unknown[]) => {
    if (sql.includes("WITH scanned AS")) {
      chunks.push({ sql, values: values ?? [] });
      options.onChunk?.();
      if (options.failBackfill) {
        const error = new Error("canceling statement due to statement timeout");
        (error as { code?: string }).code = "57014";
        throw error;
      }
      const limit = Number(values?.[2]);
      const remaining = Math.max(0, options.snapshotRows - served);
      const scanned = Math.min(limit, remaining);
      served += scanned;
      return {
        rows: [{
          scanned,
          matched: scanned,
          inserted: scanned,
          next_cursor: scanned === 0
            ? null
            : `user-${String(served).padStart(9, "0")}`,
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("SELECT CASE")) {
      return { rows: [{ value: "203.0.113.0/24" }], rowCount: 1 };
    }
    // listRules
    return {
      rows: [{ ...ruleRow, kind: options.kind ?? "ip" }],
      rowCount: 1,
    };
  };
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      if (sql.includes("FROM identifier_blocklist_audit")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("INSERT INTO identifier_blocklists")) {
        inserts.push({ sql, values: values ?? [] });
        return {
          rows: [{ id: RULE_ID, value: "203.0.113.0/24" }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  const db = {
    antifraud: { query, connect: async () => client },
  } as unknown as Databases;
  return { db, chunks, inserts };
}

async function createRule(
  db: Databases,
  kind: "ip" | "fingerprint" = "ip",
) {
  const app = Fastify();
  await registerIdentifierBlocklistRoutes(app, db);
  return app.inject({
    method: "POST",
    url: `/v1/blocklists/${kind}`,
    payload: {
      value: kind === "ip" ? "203.0.113.0/24" : "abcd1234efgh",
      matchMode: kind === "ip" ? "cidr" : "exact",
      reason: "Blocked from the antifraud admin panel",
      expiresAt: null,
      idempotencyKey: "22222222-2222-4222-8222-222222222222",
      actorId: "admin-1",
    },
  });
}

test("the historical backfill is chunked, never one unbounded statement", async () => {
  // 12_000 snapshot rows against a 5_000-row window: three bounded statements,
  // each carrying an explicit LIMIT and a cursor strictly past the last one.
  const { db, chunks } = fakeDb({ snapshotRows: 12_000 });
  const response = await createRule(db);

  assert.equal(response.statusCode, 201);
  assert.equal(chunks.length, 3);
  for (const chunk of chunks) {
    assert.match(chunk.sql, /LIMIT \$3::int/);
    assert.doesNotMatch(chunk.sql, /OFFSET/);
    assert.equal(chunk.values[0], RULE_ID);
    assert.equal(chunk.values[2], BACKFILL_CHUNK_ROWS);
  }
  assert.equal(chunks[0]!.values[1], null);
  const cursors = chunks.map((chunk) => chunk.values[1] as string | null);
  assert.deepEqual(cursors.slice(1), [
    "user-000005000",
    "user-000010000",
  ]);

  const backfill = response.json().backfill as Record<string, unknown>;
  assert.deepEqual(backfill, {
    scanned: 12_000,
    matched: 12_000,
    inserted: 12_000,
    chunks: 3,
    completed: true,
    failed: false,
  });
});

for (const kind of ["ip", "fingerprint"] as const) {
  test(`${kind} rule insert uses contiguous typed parameters`, async () => {
    const { db, inserts } = fakeDb({ snapshotRows: 0, kind });
    const response = await createRule(db, kind);

    assert.equal(response.statusCode, 201);
    assert.equal(inserts.length, 1);
    const insert = inserts[0]!;
    const placeholders = [...insert.sql.matchAll(/\$(\d+)/g)].map((match) =>
      Number(match[1])
    );
    assert.deepEqual(
      [...new Set(placeholders)].sort((left, right) => left - right),
      [1, 2, 3, 4, 5, 6],
      "every supplied parameter must be referenced from $1 without a gap",
    );
    assert.equal(Math.max(...placeholders), insert.values.length);
    assert.deepEqual(insert.values, [
      kind === "ip" ? "203.0.113.0/24" : "abcd1234efgh",
      kind === "ip" ? "cidr" : "exact",
      "Blocked from the antifraud admin panel",
      null,
      "admin-1",
      null,
    ]);
  });
}

test("a failing backfill never turns a committed rule into a 500", async () => {
  const { db, chunks } = fakeDb({ snapshotRows: 12_000, failBackfill: true });
  const response = await createRule(db);

  // The rule is committed BEFORE the sweep runs. A statement timeout in the
  // sweep must leave the operator with a live rule and an honest report, not a
  // failure for an action that already succeeded.
  assert.equal(response.statusCode, 201);
  assert.equal(chunks.length, 1, "a throwing chunk must not be retried in-loop");
  const body = response.json();
  assert.equal(body.data.id, RULE_ID);
  assert.equal(body.data.enabled, true);
  assert.deepEqual(body.backfill, {
    scanned: 0,
    matched: 0,
    inserted: 0,
    chunks: 0,
    completed: false,
    failed: true,
  });
});

test("the sweep stops at its wall-clock budget and reports itself incomplete", async () => {
  const realNow = Date.now;
  let clock = 1_000_000;
  // Charge half the budget to every chunk so the loop runs out of time with
  // snapshot rows still unvisited.
  const { db, chunks } = fakeDb({
    snapshotRows: 500_000,
    onChunk: () => {
      clock += BACKFILL_BUDGET_MS / 2;
    },
  });
  Date.now = () => clock;
  let response;
  try {
    response = await createRule(db);
  } finally {
    Date.now = realNow;
  }

  assert.equal(response.statusCode, 201);
  assert.equal(chunks.length, 2);
  const backfill = response.json().backfill as Record<string, unknown>;
  assert.equal(backfill.completed, false);
  assert.equal(backfill.failed, false);
  assert.equal(backfill.chunks, 2);
  assert.equal(backfill.inserted, 2 * BACKFILL_CHUNK_ROWS);
});

test("fingerprint rules keep the indexed equality match instead of a keyspace walk", async () => {
  const { db, chunks } = fakeDb({ snapshotRows: 3, kind: "fingerprint" });
  const response = await createRule(db, "fingerprint");

  assert.equal(response.statusCode, 201);
  assert.equal(chunks.length, 1);
  assert.match(chunks[0]!.sql, /s\.fingerprint_visitor_id=b\.fingerprint_id/);
  assert.doesNotMatch(chunks[0]!.sql, /<<=/);
});

test("chunking preserves the historical-backfill semantics exactly", async () => {
  const ip = fakeDb({ snapshotRows: 1 });
  await createRule(ip.db);
  const fingerprint = fakeDb({ snapshotRows: 1, kind: "fingerprint" });
  await createRule(fingerprint.db, "fingerprint");

  for (const sql of [ip.chunks[0]!.sql, fingerprint.chunks[0]!.sql]) {
    // Same predicate target, same review-only outcome, same source_ref, and
    // matched_at still carries source_created_at so a historical sweep can
    // never retro-contain an account.
    assert.match(sql, /'historical_backfill', 'review_only'/);
    assert.match(sql, /'identity-snapshot:' \|\| \w+\.user_id/);
    assert.match(sql, /\w+\.source_created_at\s*$/m);
    assert.match(
      sql,
      /ON CONFLICT \(blocklist_id,user_id,source_ref\) DO NOTHING/,
    );
    assert.doesNotMatch(sql, /now\(\)/);
  }
  assert.match(
    ip.chunks[0]!.sql,
    /s\.signup_ip IS NOT NULL AND s\.signup_ip <<= b\.ip_network/,
  );
  assert.match(ip.chunks[0]!.sql, /jsonb_build_object\('signupIp',host\(/);
  assert.match(
    fingerprint.chunks[0]!.sql,
    /jsonb_build_object\('fingerprintVisitorId',/,
  );
});
