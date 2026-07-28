import assert from "node:assert/strict";
import test from "node:test";

import {
  applyMandatoryJurisdictionPolicy,
  CRYPTO_RESTRICTION_TOKENS,
  FIAT_JURISDICTION_POLICY,
  hasAllWhopFiatDepositLocks,
  hasAnyWhopFiatDepositLock,
  isCreditCardDepositLocked,
  isGlobalFiatPolicyActive,
  isMandatoryJurisdictionPolicyEnforced,
  isMandatoryFiatJurisdiction,
  MANDATORY_FIAT_JURISDICTION_CODES,
  WHOP_FIAT_DEPOSIT_LOCK_TOKENS,
  withWhopFiatDepositLocks,
  withoutWhopFiatDepositLocks,
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

test("Whop helpers move card and wallet locks as one policy", () => {
  assert.deepEqual(
    withWhopFiatDepositLocks(["paypal", "fiat", "credit_card"]),
    ["paypal", ...WHOP_FIAT_DEPOSIT_LOCK_TOKENS],
  );
  assert.deepEqual(
    withoutWhopFiatDepositLocks([
      "paypal",
      "fiat",
      "credit_card",
      "apple_pay",
      "google_pay",
      "cash_app",
      "cashapp",
    ]),
    ["paypal"],
  );
  assert.ok(isCreditCardDepositLocked(["fiat"]));
  assert.ok(isCreditCardDepositLocked(["credit_card"]));
  assert.ok(!isCreditCardDepositLocked(["paypal"]));
  assert.ok(hasAnyWhopFiatDepositLock(["apple_pay"]));
  assert.ok(hasAnyWhopFiatDepositLock(["cashapp"]));
  assert.ok(hasAllWhopFiatDepositLocks([...WHOP_FIAT_DEPOSIT_LOCK_TOKENS]));
  assert.ok(!hasAllWhopFiatDepositLocks(["credit_card"]));
});

test("global enablement is independent from per-location fiat overrides", () => {
  const manualOverrides = [
    restriction("DE", ["credit_card"]),
    restriction("FR"),
  ];

  assert.ok(isGlobalFiatPolicyActive([], manualOverrides));
  assert.ok(
    !isGlobalFiatPolicyActive(["credit_card"], [
      restriction("DE"),
      restriction("FR"),
    ]),
  );
});

test("mandatory policy closes every independently enforced direct route", () => {
  const original = restriction("US-CA");
  const enforced = applyMandatoryJurisdictionPolicy(original);

  assert.equal(enforced.blocked, true);
  assert.equal(enforced.physicalWithdrawal, false);
  assert.equal(enforced.digitalWithdrawal, false);
  assert.equal(enforced.giftCardDeposit, false);
  assert.equal(enforced.promoCodeDeposit, false);
  assert.deepEqual(enforced.lockedDepositsCrypto, [
    ...CRYPTO_RESTRICTION_TOKENS,
  ]);
  assert.ok(hasAllWhopFiatDepositLocks(enforced.lockedDepositsFiat));
  assert.deepEqual(enforced.lockedWithdrawalsCrypto, [
    ...CRYPTO_RESTRICTION_TOKENS,
  ]);
  assert.ok(isMandatoryJurisdictionPolicyEnforced(enforced));
  const ordinary = restriction("DE");
  assert.equal(applyMandatoryJurisdictionPolicy(ordinary), ordinary);
});
