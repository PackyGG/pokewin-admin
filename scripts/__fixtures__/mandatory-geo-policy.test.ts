import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const actions = readFileSync(
  new URL(
    "../../src/app/(admin)/system/geo-blocking/actions.ts",
    import.meta.url,
  ),
  "utf8",
);
const geoUi = readFileSync(
  new URL(
    "../../src/app/(admin)/system/geo-blocking/geo-blocking-content.tsx",
    import.meta.url,
  ),
  "utf8",
);
const restrictionsUi = readFileSync(
  new URL(
    "../../src/app/(admin)/system/geo-blocking/restrictions-table.tsx",
    import.meta.url,
  ),
  "utf8",
);
const securityActions = readFileSync(
  new URL("../../src/app/(admin)/security/actions.ts", import.meta.url),
  "utf8",
);
const securityLoader = readFileSync(
  new URL(
    "../../src/app/(admin)/security/security-sections-loader.tsx",
    import.meta.url,
  ),
  "utf8",
);

test("mandatory policy cannot be weakened through bulk or per-row actions", () => {
  assert.match(
    actions,
    /mandatory legal-policy jurisdictions cannot be globally unblocked/,
  );
  assert.match(
    actions,
    /mandatory legal block and cannot be opened individually/,
  );
  for (const field of [
    "blocked = true",
    "physical_withdrawal = false",
    "digital_withdrawal = false",
    "gift_card_deposit = false",
    "promo_code_deposit = false",
    "locked_deposits_crypto",
    "locked_deposits_fiat",
    "locked_withdrawals_crypto",
  ]) {
    assert.match(actions, new RegExp(field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(geoUi, /allPolicyFullyEnforced/);
  assert.match(geoUi, /disabled=\{policyGeoPending \|\| allPolicyFullyEnforced\}/);
  assert.match(restrictionsUi, /Mandatory legal geo block/);
});

test("ordinary row edits report runtime cache uptake", () => {
  const invalidations = actions.match(
    /backendApi\.post\("\/admin\/invalidate-country-restrictions-cache"\)/g,
  );
  assert.ok((invalidations?.length ?? 0) >= 5);
  assert.match(actions, /countryRestrictionsCacheReloaded/);
  assert.match(
    geoUi,
    /restriction was saved, but the backend cache did not reload/,
  );
});

test("crypto chips use exact backend lock names", () => {
  assert.match(restrictionsUi, /\{ value: "doge", label: "Dogecoin \(DOGE\)" \}/);
  assert.match(restrictionsUi, /\{ value: "xrp", label: "XRP" \}/);
  assert.doesNotMatch(restrictionsUi, /value: "dogecoin"/);
  assert.doesNotMatch(restrictionsUi, /value: "ripple"/);
});

test("raw Security config cannot bypass the atomic geo policy owner", () => {
  assert.match(securityLoader, /\.\.\.GEO_POLICY_SITE_CONFIG_KEYS/);
  assert.match(securityActions, /assertNotGeoPolicyKey\(trimmedKey\)/);
  assert.match(securityActions, /assertNotGeoPolicyKey\(key\.trim\(\)\)/);
});
