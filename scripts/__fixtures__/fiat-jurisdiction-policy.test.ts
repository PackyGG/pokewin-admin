import assert from "node:assert/strict";
import test from "node:test";

import {
  applyGlobalFiatPolicy,
  CREDIT_CARD_DEPOSIT_METHOD,
  FIAT_JURISDICTION_POLICY,
  isCreditCardDepositLocked,
  isGlobalFiatPolicyActive,
  isMandatoryFiatJurisdiction,
  MANDATORY_FIAT_JURISDICTION_CODES,
  withCreditCardLock,
  withoutCreditCardLock,
} from "@/lib/fiat-jurisdiction-policy";
import type { CountryRestrictionRow } from "@/lib/queries/geo-blocking";

function restriction(
  countryCode: string,
  lockedDepositsFiat: string[] = [],
): CountryRestrictionRow {
  return {
    countryCode,
    physicalWithdrawal: true,
    digitalWithdrawal: true,
    giftCardDeposit: true,
    promoCodeDeposit: true,
    blocked: false,
    lockedDepositsCrypto: [],
    lockedDepositsFiat,
    lockedWithdrawalsCrypto: [],
  };
}

test("fiat policy contains the exact 33 unique required jurisdictions", () => {
  const expectedCodes = [
    "AF",
    "BY",
    "CD",
    "CU",
    "HT",
    "IR",
    "KP",
    "LB",
    "MM",
    "RU",
    "SD",
    "SO",
    "SS",
    "SY",
    "UA-09",
    "UA-14",
    "UA-40",
    "UA-43",
    "US-CA",
    "US-CT",
    "US-DE",
    "US-ID",
    "US-LA",
    "US-MD",
    "US-MI",
    "US-MS",
    "US-MT",
    "US-NJ",
    "US-NV",
    "US-NY",
    "US-WA",
    "VE",
    "YE",
  ];
  assert.equal(MANDATORY_FIAT_JURISDICTION_CODES.length, 33);
  assert.equal(new Set(MANDATORY_FIAT_JURISDICTION_CODES).size, 33);
  assert.deepEqual(
    [...MANDATORY_FIAT_JURISDICTION_CODES].sort(),
    expectedCodes,
  );
  assert.deepEqual(
    FIAT_JURISDICTION_POLICY.map((group) => [
      group.key,
      group.jurisdictions.length,
    ]),
    [
      ["prohibited_states", 9],
      ["enhanced_monitoring_states", 4],
      ["sanctions_restricted", 12],
      ["high_risk", 8],
    ],
  );
  assert.ok(isMandatoryFiatJurisdiction("US-CA"));
  assert.ok(isMandatoryFiatJurisdiction("UA-43"));
  assert.ok(isMandatoryFiatJurisdiction("VE"));
  assert.ok(!isMandatoryFiatJurisdiction("US-TX"));
  assert.ok(!isMandatoryFiatJurisdiction("DE"));
});

test("credit-card helpers replace the ineffective legacy fiat token", () => {
  assert.deepEqual(withCreditCardLock(["paypal", "fiat", "credit_card"]), [
    "paypal",
    CREDIT_CARD_DEPOSIT_METHOD,
  ]);
  assert.deepEqual(
    withoutCreditCardLock(["paypal", "fiat", "credit_card"]),
    ["paypal"],
  );
  assert.ok(isCreditCardDepositLocked(["fiat"]));
  assert.ok(isCreditCardDepositLocked(["credit_card"]));
  assert.ok(!isCreditCardDepositLocked(["paypal"]));
});

test("global enablement opens ordinary locations and locks every policy row", () => {
  const input = [
    restriction("DE", ["fiat", "paypal"]),
    ...MANDATORY_FIAT_JURISDICTION_CODES.map((code) =>
      restriction(code, ["fiat"]),
    ),
  ];
  const enabled = applyGlobalFiatPolicy(input, true);
  const ordinary = enabled.find((row) => row.countryCode === "DE");

  assert.deepEqual(ordinary?.lockedDepositsFiat, ["paypal"]);
  assert.ok(
    enabled
      .filter((row) => row.countryCode !== "DE")
      .every((row) =>
        row.lockedDepositsFiat.includes(CREDIT_CARD_DEPOSIT_METHOD),
      ),
  );
  assert.ok(isGlobalFiatPolicyActive([], enabled));
  assert.ok(!isGlobalFiatPolicyActive(["credit_card"], enabled));
});

test("global disablement locks every row and incomplete policy is never active", () => {
  const disabled = applyGlobalFiatPolicy(
    [restriction("DE"), restriction("US-CA")],
    false,
  );
  assert.ok(
    disabled.every((row) =>
      row.lockedDepositsFiat.includes(CREDIT_CARD_DEPOSIT_METHOD),
    ),
  );
  assert.ok(!isGlobalFiatPolicyActive([], disabled));
  assert.ok(!isGlobalFiatPolicyActive([], [restriction("DE")]));
});
