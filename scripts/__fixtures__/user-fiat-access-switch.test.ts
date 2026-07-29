import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const component = readFileSync(
  "src/app/(admin)/users/[id]/fiat-deposit-access-button.tsx",
  "utf8",
);

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
