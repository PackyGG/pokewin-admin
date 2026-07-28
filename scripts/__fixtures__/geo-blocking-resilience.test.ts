import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const geoQuerySource = readFileSync(
  new URL("../../src/lib/queries/geo-blocking.ts", import.meta.url),
  "utf8",
);
const fiatQuerySource = readFileSync(
  new URL("../../src/lib/queries/fiat.ts", import.meta.url),
  "utf8",
);
const warmRouteSource = readFileSync(
  new URL("../../src/app/api/cron/warm/route.ts", import.meta.url),
  "utf8",
);

test("Geo Blocking read-only cache fills use the bounded transient retry", () => {
  assert.match(geoQuerySource, /withTransientPostgresReadRetry/);
  assert.match(fiatQuerySource, /withTransientPostgresReadRetry/);
});

test("the recurring warm route keeps both Geo Blocking cache keys warm", () => {
  assert.match(
    warmRouteSource,
    /\["geoBlockingRestrictions", \(\) => getCountryRestrictions\(\)\]/,
  );
  assert.match(warmRouteSource, /\["fiatConfig", \(\) => getFiatConfig\(\)\]/);
});
