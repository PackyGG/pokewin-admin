import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  adjustFiatRiskForPaymentMethod,
  normalizeWhopPaymentMethod,
  whopPaymentMethodFromPayload,
  whopPaymentMethodInfo,
  whopPaymentMethodLabel,
} from "../src/whop-payment-method.js";

test("normalizes Whop wallet names", () => {
  assert.equal(normalizeWhopPaymentMethod("apple"), "apple_pay");
  assert.equal(normalizeWhopPaymentMethod("Google Pay"), "google_pay");
  assert.equal(normalizeWhopPaymentMethod("cash_app"), "cashapp");
  assert.equal(normalizeWhopPaymentMethod("card"), "card");
});

test("extracts and labels nested Whop payment options without inference", () => {
  assert.equal(
    whopPaymentMethodFromPayload({
      data: { payment: { payment_method_type: "apple" } },
    }),
    "apple_pay",
  );
  assert.equal(whopPaymentMethodLabel("apple_pay"), "Apple Pay");
  assert.equal(whopPaymentMethodLabel("google_pay"), "Google Pay");
  assert.equal(whopPaymentMethodLabel("cashapp"), "Cash App");
  assert.equal(whopPaymentMethodLabel("card"), "Card");
  assert.equal(whopPaymentMethodLabel(null), "Unknown");
  assert.equal(whopPaymentMethodFromPayload({ data: { card: {} } }), null);
});

test("payment identities are one-way hashed for cross-account matching", () => {
  const info = whopPaymentMethodInfo({
    data: {
      user: { id: "whop-customer-secret" },
      payment: { payment_method_id: "payment-token-secret" },
    },
  });
  assert.match(info.customerIdHash ?? "", /^[a-f0-9]{64}$/);
  assert.match(info.paymentMethodIdHash ?? "", /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(info).includes("secret"), false);
});

test("combines payment evidence from separate provider sources", () => {
  const info = whopPaymentMethodInfo(
    { data: { user: { id: "customer-secret" } } },
    {
      data: {
        payment: {
          payment_method_type: "card",
          payment_method_id: "method-secret",
          card_brand: "Visa",
          card_last4: "4242",
        },
      },
    },
  );
  assert.equal(info.type, "card");
  assert.equal(info.cardBrand, "visa");
  assert.equal(info.cardLast4, "4242");
  assert.match(info.customerIdHash ?? "", /^[a-f0-9]{64}$/);
  assert.match(info.paymentMethodIdHash ?? "", /^[a-f0-9]{64}$/);
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
