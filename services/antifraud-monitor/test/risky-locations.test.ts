import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { serviceRequestAuthorized } from "../src/auth.js";
import { normalizeCountryCode } from "../src/risky-locations.js";

const config = {
  API_TOKEN: "read-token",
  API_ADMIN_TOKEN: "admin-token",
};

test("risky location country codes are strict ISO alpha-2 shapes", () => {
  assert.equal(normalizeCountryCode(" cz "), "CZ");
  assert.equal(normalizeCountryCode("CZE"), null);
  assert.equal(normalizeCountryCode("1Z"), null);
  assert.equal(normalizeCountryCode(null), null);
});

test("risky location writes require the admin token", () => {
  for (const [method, path] of [
    ["POST", "/v1/risky-locations"],
    ["PUT", "/v1/risky-locations/CZ"],
  ] as const) {
    assert.equal(
      serviceRequestAuthorized(method, path, config.API_TOKEN, config),
      false,
    );
    assert.equal(
      serviceRequestAuthorized(method, path, config.API_ADMIN_TOKEN, config),
      true,
    );
  }
  assert.equal(
    serviceRequestAuthorized(
      "GET",
      "/v1/risky-locations",
      config.API_TOKEN,
      config,
    ),
    true,
  );
});

test("risky location monitoring is bounded and overrides only the session duration", async () => {
  const [migration, monitor] = await Promise.all([
    readFile(
      new URL("../migrations/018_risky_locations.sql", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../src/monitor.ts", import.meta.url), "utf8"),
  ]);
  assert.match(migration, /BETWEEN 60 AND 3600/);
  assert.match(monitor, /locationPolicy\?\.monitorDurationSeconds/);
  assert.match(monitor, /locationPolicy \|\|/);
  assert.match(monitor, /points: weights\.risky_location/);
  assert.match(monitor, /durationSeconds: opened\.durationSeconds/);
});
