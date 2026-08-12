import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

test("catch-all containment keeps the first apply's lock timestamps on retry", () => {
  const helper = read("src/lib/antifraud/abstract-catchall-containment.ts");
  const onConflict = helper.slice(
    helper.indexOf("ON CONFLICT (user_id) DO UPDATE SET"),
    helper.indexOf("RETURNING user_id"),
  );

  // A bare `= EXCLUDED.locked_*_at` re-stamps NOW() on every containment
  // outbox retry, so "locked since" drifts with the retry, not the lock.
  assert.doesNotMatch(onConflict, /locked_deposits_at = EXCLUDED/);
  assert.doesNotMatch(onConflict, /locked_withdrawals_at = EXCLUDED/);
  assert.match(
    onConflict,
    /locked_deposits_reason\s*\n?\s*= EXCLUDED\.locked_deposits_reason/,
  );

  // A lock the automation does not own is still overwritten here: the release
  // path restores it verbatim, and it matches on exactly this applied reason.
  assert.match(onConflict, /ELSE EXCLUDED\.locked_deposits_at/);
  assert.match(onConflict, /ELSE EXCLUDED\.locked_withdrawals_at/);
  assert.match(onConflict, /locked_deposits_reason = EXCLUDED/);
  assert.match(onConflict, /locked_withdrawals_reason = EXCLUDED/);
});

test("every monitor alert outbox drains its batch concurrently", () => {
  const monitor = read("services/antifraud-monitor/src/monitor.ts");
  const drains = monitor.match(/await drainOutbox(<[^>]+>)?\(\{/g) ?? [];
  const concurrent = monitor.match(/concurrent: true/g) ?? [];

  // Serial drains spend one five-second enqueue timeout per row of a cold
  // batch, which an ingest outage turns into the poller's liveness budget.
  assert.equal(drains.length, 3);
  assert.equal(concurrent.length, drains.length);
});

test("monitor rollbacks never mask the error that aborted the transaction", () => {
  const monitor = read("services/antifraud-monitor/src/monitor.ts");
  assert.doesNotMatch(monitor, /await client\.query\("ROLLBACK"\);/);
  assert.match(monitor, /await client\.query\("ROLLBACK"\)\.catch\(/);
});

test("giveaway entry resolves the MAIN requirement before it locks the row", () => {
  const giveaways = read("src/lib/discord-giveaways.ts");
  const enter = giveaways.slice(
    giveaways.indexOf("export async function enterDiscordGiveaway"),
    giveaways.indexOf("async function finalizeDueGiveaway"),
  );
  assert.notEqual(enter, "");

  // The transaction holds the giveaway row FOR UPDATE, so a mirror read
  // inside it queues every concurrent entry behind one cross-pool round trip.
  const resolved = enter.indexOf("meetsEntryRequirement(");
  const transaction = enter.indexOf("adminDrizzle.transaction");
  assert.ok(resolved > -1 && transaction > -1);
  assert.ok(resolved < transaction);
  assert.doesNotMatch(enter.slice(transaction), /getProdReadDrizzleDb/);
});
