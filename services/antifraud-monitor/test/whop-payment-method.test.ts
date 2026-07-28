import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  adjustFiatRiskForPaymentMethod,
  normalizeWhopPaymentMethod,
} from "../src/whop-payment-method.js";

test("normalizes Whop wallet names", () => {
  assert.equal(normalizeWhopPaymentMethod("apple"), "apple_pay");
  assert.equal(normalizeWhopPaymentMethod("Google Pay"), "google_pay");
  assert.equal(normalizeWhopPaymentMethod("cash_app"), "cashapp");
  assert.equal(normalizeWhopPaymentMethod("card"), "card");
});

test("Apple Pay reduces positive fiat risk by 20 percent", () => {
  assert.equal(
    adjustFiatRiskForPaymentMethod(
      "fiat_deposit",
      { fiat_payment_method_type: "apple_pay" },
      20,
    ),
    16,
  );
  assert.equal(
    adjustFiatRiskForPaymentMethod(
      "fiat_deposit",
      { fiat_payment_method_type: "apple" },
      61,
    ),
    49,
  );
});

test("other methods and non-positive weights are unchanged", () => {
  assert.equal(
    adjustFiatRiskForPaymentMethod(
      "fiat_deposit",
      { fiat_payment_method_type: "google_pay" },
      20,
    ),
    20,
  );
  assert.equal(
    adjustFiatRiskForPaymentMethod(
      "fiat_deposit",
      { fiat_payment_method_type: "apple_pay" },
      -20,
    ),
    -20,
  );
  assert.equal(
    adjustFiatRiskForPaymentMethod(
      "crypto_deposit",
      { fiat_payment_method_type: "apple_pay" },
      20,
    ),
    20,
  );
});

test("fiat activity carries Whop method evidence into scoring", async () => {
  const source = await readFile(
    new URL("../src/source.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /provider_metadata->'payment'->>'payment_method_type'/);
  assert.match(source, /'fiat_payment_method_type', whop\.payment_method_type/);
  assert.match(source, /'fiat_card_brand', whop\.card_brand/);
  assert.match(source, /'fiat_card_last4', whop\.card_last4/);
});
