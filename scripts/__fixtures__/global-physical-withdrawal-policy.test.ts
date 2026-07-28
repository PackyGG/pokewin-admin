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
const geoQuerySource = readFileSync(
  new URL("../../src/lib/queries/geo-blocking.ts", import.meta.url),
  "utf8",
);

test("global physical switch changes only the physical location flag", () => {
  const action = actionsSource.match(
    /export async function setGlobalPhysicalItemWithdrawals[\s\S]*?\r?\n}\r?\n\r?\nexport async function setMandatoryJurisdictionsGeoBlocked/,
  )?.[0];
  assert.ok(action);
  assert.match(action, /physical_withdrawal = \$\{enabled\}/);
  assert.match(action, /physical_withdrawal IS DISTINCT FROM \$\{enabled\}/);
  assert.match(
    action,
    /backendApi\.post\("\/admin\/invalidate-country-restrictions-cache"\)/,
  );
  assert.doesNotMatch(action, /withdrawals_enabled/);
  assert.doesNotMatch(action, /locked_deposits_fiat/);
});

test("Geo Blocking renders all three global controls on one desktop row", () => {
  assert.match(geoUiSource, /grid gap-3 lg:grid-cols-3/);
  assert.match(geoUiSource, /Whop fiat deposits — global/);
  assert.match(geoUiSource, /Physical item withdrawals — global/);
  assert.match(geoUiSource, /Geo-block policy jurisdictions/);
});

test("physical switch state and optimistic update cover every location row", () => {
  assert.match(
    geoUiSource,
    /rows\.length > 0 && physicalAllowedCount === rows\.length/,
  );
  assert.match(
    geoUiSource,
    /current\.map\(\(row\) => \(\{ \.\.\.row, physicalWithdrawal: enabled \}\)\)/,
  );
  assert.match(
    geoUiSource,
    /onCheckedChange=\{handleGlobalPhysicalItemWithdrawals\}/,
  );
});

test("physical policy reads cannot reuse the retired pre-toggle cache snapshot", () => {
  assert.match(geoQuerySource, /geo-blocking-restrictions-v2/);
  assert.doesNotMatch(geoQuerySource, /geo-blocking-restrictions-v1/);
});
