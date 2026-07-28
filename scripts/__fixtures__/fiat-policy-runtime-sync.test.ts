import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const actionsSource = readFileSync(
  new URL(
    "../../src/app/(admin)/system/geo-blocking/actions.ts",
    import.meta.url,
  ),
  "utf8",
);
const geoUiSource = readFileSync(
  new URL(
    "../../src/app/(admin)/system/geo-blocking/geo-blocking-content.tsx",
    import.meta.url,
  ),
  "utf8",
);
const fiatUiSource = readFileSync(
  new URL(
    "../../src/app/(admin)/fiat/_components/fiat-config-card.tsx",
    import.meta.url,
  ),
  "utf8",
);

test("global fiat gate reloads only site config and never country restrictions", () => {
  const start = actionsSource.indexOf(
    "export async function setGlobalFiatDeposits",
  );
  const end = actionsSource.indexOf(
    "export async function setGlobalPhysicalItemWithdrawals",
    start,
  );
  const globalAction = actionsSource.slice(start, end);

  assert.match(
    globalAction,
    /backendApi\.post\("\/admin\/refresh-site-config"\)/,
  );
  assert.doesNotMatch(globalAction, /invalidate-country-restrictions-cache/);
  assert.match(globalAction, /siteConfigCacheReloaded:/);
  assert.doesNotMatch(globalAction, /countryRestrictionsCacheReloaded:/);
  assert.doesNotMatch(globalAction, /\.update\(country_restrictions\)/);
  assert.doesNotMatch(globalAction, /UPDATE country_restrictions/);
});

test("operator UI never calls a saved policy live when cache reload failed", () => {
  for (const source of [geoUiSource, fiatUiSource]) {
    assert.match(source, /backend cache did not fully reload|backend cache did not reload/);
    assert.match(source, /before treating the change as live/);
  }
});

test("global switch copy owns the complete Whop checkout", () => {
  for (const label of ["card", "Apple Pay", "Google Pay", "Cash App"]) {
    assert.match(fiatUiSource, new RegExp(label));
  }
  assert.doesNotMatch(fiatUiSource, /requires backend PR #470/);
  assert.doesNotMatch(geoUiSource, /begins when backend PR #470 is deployed/);
});
