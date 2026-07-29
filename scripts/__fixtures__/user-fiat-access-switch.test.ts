import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const component = readFileSync(
  "src/app/(admin)/users/[id]/fiat-deposit-access-button.tsx",
  "utf8",
);
const apiClient = readFileSync(
  "src/lib/backend-api/fiat-deposit-access.ts",
  "utf8",
);

test("Fiat access calls the packy.gg API host", () => {
  assert.match(
    apiClient,
    /FIAT_DEPOSIT_ACCESS_BASE_URL = "https:\/\/packy\.gg\/v1"/,
  );
  assert.doesNotMatch(apiClient, /backendApi\.(get|put)/);
});

test("user Fiat access is an immediate switch without a confirmation dialog", () => {
  assert.match(component, /<Switch[\s\S]*onCheckedChange=\{update\}/);
  assert.match(
    component,
    /updateFiatDepositAccessAction\(userId, nextEnabled\)/,
  );
  assert.doesNotMatch(component, /AlertDialog|Confirm|confirmation/);
});

test("failed Fiat access updates restore the prior switch state", () => {
  assert.match(component, /const previousEnabled = enabled/);
  assert.match(component, /setEnabled\(nextEnabled\)/);
  assert.match(component, /setEnabled\(previousEnabled\)/);
});
