import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeWhopPaymentMethod,
  whopPaymentMethodInfo,
  whopPaymentMethodLabel,
} from "../../src/lib/whop-payment-method";

test("normalizes Whop wallet and card method names", () => {
  assert.equal(normalizeWhopPaymentMethod("apple"), "apple_pay");
  assert.equal(normalizeWhopPaymentMethod("Google Pay"), "google_pay");
  assert.equal(normalizeWhopPaymentMethod("cash_app"), "cashapp");
  assert.equal(normalizeWhopPaymentMethod("credit-card"), "card");
});

test("extracts method and card details from nested Whop metadata", () => {
  assert.deepEqual(
    whopPaymentMethodInfo({
      payment: {
        payment_method_type: "apple_pay",
        card_brand: "visa",
        card_last4: "4242",
      },
    }),
    { type: "apple_pay", cardBrand: "visa", cardLast4: "4242" },
  );
});

test("falls back across provider metadata and webhook payloads", () => {
  assert.deepEqual(
    whopPaymentMethodInfo({}, { data: { payment_method_type: "cashapp" } }),
    { type: "cashapp", cardBrand: null, cardLast4: null },
  );
  assert.equal(whopPaymentMethodLabel("google_pay"), "Google Pay");
  assert.equal(whopPaymentMethodLabel(null), "Whop payment");
});
