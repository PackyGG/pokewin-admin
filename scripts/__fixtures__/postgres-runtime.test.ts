import assert from "node:assert/strict";
import { test } from "node:test";

import { queryDecodedRows } from "../../src/lib/drizzle-query";
import {
  PostgresResultError,
  decodePostgresRows,
  nullable,
  postgresArray,
  postgresBigInt,
  postgresBoolean,
  postgresJson,
  postgresNumeric,
  postgresObject,
  postgresSafeInteger,
  postgresString,
  postgresTimestamp,
  postgresTimestampIso,
} from "../../src/lib/postgres-runtime";

test("normalizes PostgreSQL timestamp strings and Date values to UTC", () => {
  assert.equal(
    postgresTimestampIso("2026-07-26 15:04:05.123456"),
    "2026-07-26T15:04:05.123Z",
  );
  assert.equal(
    postgresTimestampIso("2026-07-26T17:04:05.123+02:00"),
    "2026-07-26T15:04:05.123Z",
  );

  const source = new Date("2026-07-26T15:04:05.123Z");
  const decoded = postgresTimestamp(source);
  assert.notEqual(decoded, source);
  assert.equal(decoded.toISOString(), source.toISOString());
  assert.throws(
    () => postgresTimestamp("not-a-date", "row.created_at"),
    /row\.created_at: invalid timestamp/,
  );
});

test("keeps NUMERIC exact and guards BIGINT/count precision", () => {
  assert.equal(
    postgresNumeric("12345678901234567890.123456789"),
    "12345678901234567890.123456789",
  );
  assert.throws(() => postgresNumeric(-12.5), /exact PostgreSQL numeric string/);
  assert.equal(postgresBigInt("9007199254740993"), 9_007_199_254_740_993n);
  assert.equal(postgresSafeInteger("42"), 42);
  assert.throws(
    () => postgresSafeInteger("9007199254740993", "row.count"),
    /row\.count: integer .* exceeds JavaScript's safe range/,
  );
  assert.throws(() => postgresNumeric("NaN"), PostgresResultError);
});

test("parses JSON text and validates its complete runtime shape", () => {
  const metadataDecoder = postgresObject<{
    source: string;
    settled: boolean;
    tags: string[];
  }>({
    source: postgresString,
    settled: postgresBoolean,
    tags: postgresArray(postgresString),
  });

  assert.deepEqual(
    postgresJson(
      '{"source":"deposit","settled":true,"tags":["fiat","verified"]}',
      metadataDecoder,
      "row.metadata",
    ),
    {
      source: "deposit",
      settled: true,
      tags: ["fiat", "verified"],
    },
  );
  assert.throws(
    () =>
      postgresJson(
        '{"source":"deposit","settled":"yes","tags":[]}',
        metadataDecoder,
        "row.metadata",
      ),
    /row\.metadata\.settled: expected a boolean/,
  );
});

test("decodes raw rows with field paths and nullable values", () => {
  const rowDecoder = postgresObject<{
    created_at: Date;
    amount: string;
    count: number;
    metadata: { source: string } | null;
  }>({
    created_at: postgresTimestamp,
    amount: postgresNumeric,
    count: postgresSafeInteger,
    metadata: nullable((value, path) =>
      postgresJson(
        value,
        postgresObject<{ source: string }>({ source: postgresString }),
        path,
      ),
    ),
  });

  const [row] = decodePostgresRows(
    [
      {
        created_at: "2026-07-26 15:04:05",
        amount: "19.9900",
        count: "3",
        metadata: '{"source":"reward"}',
      },
    ],
    rowDecoder,
  );

  assert.equal(row.created_at.toISOString(), "2026-07-26T15:04:05.000Z");
  assert.equal(row.amount, "19.9900");
  assert.equal(row.count, 3);
  assert.deepEqual(row.metadata, { source: "reward" });
});

test("queryDecodedRows validates mocked Drizzle results at the boundary", async () => {
  const decoder = postgresObject<{
    created_at: Date;
    total: string;
  }>({
    created_at: postgresTimestamp,
    total: postgresNumeric,
  });
  const fakeDb = {
    async execute() {
      return {
        rows: [{ created_at: "2026-07-26 12:00:00", total: "10.25" }],
      };
    },
  };

  const rows = await queryDecodedRows(
    fakeDb as never,
    "SELECT $1::text",
    ["bound"],
    decoder,
  );
  assert.equal(rows[0].created_at.toISOString(), "2026-07-26T12:00:00.000Z");
  assert.equal(rows[0].total, "10.25");
});
