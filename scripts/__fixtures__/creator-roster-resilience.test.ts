import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(path, "utf8");

test("creator list surfaces share the retained roster cache", () => {
  const hub = read(
    "src/app/(creator-hub)/creator-hub/creators/_queries/list-roster-creators.ts",
  );
  const legacy = read(
    "src/app/(admin)/creators/_queries/list-creators-by-tab.ts",
  );
  const cache = read("src/lib/cache/creator-backend-cache.ts");

  for (const source of [hub, legacy]) {
    assert.match(source, /getCachedCreatorRoster\(\)/);
    assert.doesNotMatch(source, /creatorsApi\.list/);
  }
  assert.match(cache, /cacheGetOrSetStale\(/);
  assert.match(cache, /ROSTER_STALE_TTL_SECONDS = 6 \* 60 \* 60/);
});

test("idempotent backend reads retry bounded transient failures", () => {
  const client = read("src/lib/backend-api/client.ts");

  assert.match(client, /MAX_GET_FAILURE_RETRIES = 1/);
  assert.match(client, /res\.status === 500/);
  assert.match(client, /res\.status === 502/);
  assert.match(client, /res\.status === 504/);
  assert.match(client, /method === "GET"/);
});

test("MAIN pool acquire budget outlives its statement budget", () => {
  const db = read("src/lib/db.ts");

  const acquire = Number(
    db.match(/connectionTimeoutMillis:\s*([\d_]+)/)?.[1].replaceAll("_", ""),
  );
  const statement = Number(
    db.match(/statement_timeout:\s*([\d_]+)/)?.[1].replaceAll("_", ""),
  );

  assert.ok(Number.isFinite(acquire));
  assert.ok(Number.isFinite(statement));
  assert.ok(acquire > statement);
});
