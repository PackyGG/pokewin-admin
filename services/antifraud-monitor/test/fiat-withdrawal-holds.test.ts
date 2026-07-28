import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type pg from "pg";

import {
  fetchFiatWithdrawalHolds,
  fiatWithdrawalHoldMarker,
  fiatWithdrawalHoldSourceRef,
  FIAT_WITHDRAWAL_HOLD_SCORE,
  type FiatWithdrawalHold,
} from "../src/fiat-withdrawal-holds.js";

const hold: FiatWithdrawalHold = {
  user_id: "user-1",
  username: "player",
  source_created_at: new Date("2026-01-01T00:00:00.000Z"),
  locked_at: new Date("2026-07-28T10:00:00.123Z"),
  reason: "Lifetime deposits reached $100.00",
  locked_withdrawals_crypto: ["all"],
  locked_withdrawals_items: true,
};

test("automatic fiat withdrawal hold marker opens a high review signal", () => {
  const marker = fiatWithdrawalHoldMarker(hold);

  assert.equal(FIAT_WITHDRAWAL_HOLD_SCORE, 80);
  assert.equal(marker.eventType, "fiat_deposit_withdrawal_hold");
  assert.equal(marker.source, "fiat_withdrawal_hold");
  assert.equal(marker.score, 80);
  assert.equal(marker.sourceRef, "user-1:2026-07-28T10:00:00.123Z");
  assert.deepEqual(marker.payload.lockedWithdrawalsCrypto, ["all"]);
  assert.equal(marker.payload.lockedWithdrawalsItems, true);
  assert.equal(fiatWithdrawalHoldSourceRef(hold), marker.sourceRef);
});

test("source scan selects only complete automatic lifetime-deposit holds", async () => {
  let queryText = "";
  let queryValues: unknown[] = [];
  const source = {
    async query(sql: string, values: unknown[]) {
      queryText = sql;
      queryValues = values;
      return { rows: [hold] };
    },
  } as unknown as pg.Pool;

  const rows = await fetchFiatWithdrawalHolds(
    source,
    {
      occurredAt: new Date("2026-07-28T09:00:00.000Z"),
      sourceId: "user-0",
    },
    25,
  );

  assert.deepEqual(rows, [hold]);
  assert.match(queryText, /FROM user_feature_locks fl/);
  assert.match(
    queryText,
    /locked_withdrawals_reason LIKE 'Lifetime deposits reached \$%'/,
  );
  assert.match(queryText, /'all' = ANY\(fl\.locked_withdrawals_crypto\)/);
  assert.match(queryText, /fl\.locked_withdrawals_items = true/);
  assert.match(queryText, /ORDER BY date_trunc\('milliseconds'/);
  assert.equal(queryValues[2], 25);
});

test("hold persistence uses independent durable review and Discord sinks", async () => {
  const monitor = await readFile(
    new URL("../src/monitor.ts", import.meta.url),
    "utf8",
  );
  const migration = await readFile(
    new URL(
      "../migrations/016_fiat_withdrawal_hold_delivery.sql",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(monitor, /INSERT INTO fiat_withdrawal_hold_alert_outbox/);
  assert.match(monitor, /INSERT INTO risk_events/);
  assert.match(monitor, /sendWithdrawalHold/);
  assert.match(monitor, /UPDATE source_cursors/);
  assert.match(migration, /fiat-withdrawal-holds/);
  assert.match(migration, /WHERE discord_delivered_at IS NULL/);
});
