import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const promiseCachePath = "services/antifraud-monitor/src/promise-cache.ts";
const transportLimitsPath = "services/antifraud-monitor/src/transport-limits.ts";
const dbPath = "services/antifraud-monitor/src/db.ts";
const monitorPath = "services/antifraud-monitor/src/monitor.ts";
const ingestDeliveryPath = "services/antifraud-monitor/src/ingest-delivery.ts";

test("the promise cache evicts, so a request-derived key cannot retain a payload forever", async () => {
  const source = await readFile(promiseCachePath, "utf8");

  // The overview cache is keyed on the caller-supplied excluded-user header,
  // so an unbounded map is an unbounded, caller-chosen memory footprint.
  assert.match(source, /const DEFAULT_MAX_ENTRIES = \d+/);
  assert.match(source, /maxEntries\?: number/);
  // Expired keys are otherwise only reclaimed when the same key comes back.
  assert.match(source, /if \(entry\.expiresAt <= currentTime\)/);
  assert.match(source, /evictDown\(entries, lastGood\)/);
  // lastGood survives a rejection that evicted its entry, so it needs its own
  // bound rather than only being dropped alongside entries.
  assert.match(source, /if \(lastGood\.size >= maxEntries\) evictDown\(lastGood\)/);
});

test("the per-IP window map is bounded even when nothing has expired", async () => {
  const source = await readFile(transportLimitsPath, "utf8");

  // The expiry sweep frees nothing when every window is still live, which is
  // exactly the traffic shape (a flood of distinct IPs) that grows the map.
  assert.match(source, /while \(windows\.size > 20_000\)/);
  assert.match(source, /windows\.keys\(\)\.next\(\)\.value/);
});

test("service pool errors are redacted and the antifraud pool keeps no idle-in-transaction reaper", async () => {
  const [db, monitor, ingestDelivery] = await Promise.all([
    readFile(dbPath, "utf8"),
    readFile(monitorPath, "utf8"),
    readFile(ingestDeliveryPath, "utf8"),
  ]);

  // These logs run before Fastify exists, so the `err` serializer in server.ts
  // that scrubs secret VALUES never sees them.
  assert.doesNotMatch(db, /message: error\.message,/);
  assert.equal(db.match(/redactConnectionSecrets\(/g)?.length, 4);

  // The poller lease is a transaction that holds one advisory lock and then
  // sits idle for the whole tick. A server-side idle-in-transaction reaper
  // would release that lock mid-tick and let a second replica run concurrently.
  assert.doesNotMatch(db, /idle_in_transaction_session_timeout=/);
  assert.match(monitor, /pg_try_advisory_xact_lock\(\$1\) AS acquired/);
  assert.match(db, /keepAlive: true/);
  assert.match(db, /maxLifetimeSeconds: 600/);

  // The blacklist delivery read prunes on the delivery receipt, which the
  // top-of-transaction sweep keeps to at most one hour of rows. Losing that
  // predicate is what would turn the read into a full historical walk.
  assert.match(
    ingestDelivery,
    /AND re\.dashboard_delivered_at IS NULL\s+AND re\.payload ->> 'reviewOnly'/,
  );
});
