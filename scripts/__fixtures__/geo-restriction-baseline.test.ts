import assert from "node:assert/strict";
import test from "node:test";

import {
  countActiveRestrictions,
  isRowRestricted,
  type RestrictionRowData,
} from "@/app/(admin)/system/geo-blocking/restrictions-table";

function openRow(
  overrides: Partial<RestrictionRowData> = {},
): RestrictionRowData {
  return {
    code: "DE",
    name: "Germany",
    physicalWithdrawal: true,
    digitalWithdrawal: true,
    giftCardDeposit: true,
    promoCodeDeposit: true,
    blocked: false,
    lockedDepositsCrypto: [],
    lockedDepositsFiat: [],
    lockedWithdrawalsCrypto: [],
    ...overrides,
  };
}

test("site-wide fiat lock is not counted as a geo restriction", () => {
  const row = openRow({ lockedDepositsFiat: ["credit_card"] });

  assert.equal(isRowRestricted(row), true);
  assert.equal(countActiveRestrictions(row), 1);
  assert.equal(isRowRestricted(row, true), false);
  assert.equal(countActiveRestrictions(row, true), 0);
});

test("real location restrictions remain visible with the fiat baseline ignored", () => {
  const row = openRow({
    blocked: true,
    physicalWithdrawal: false,
    lockedDepositsFiat: ["credit_card"],
  });

  assert.equal(isRowRestricted(row, true), true);
  assert.equal(countActiveRestrictions(row, true), 2);
});

test("unused gift-card flag does not create a restriction", () => {
  const row = openRow({ giftCardDeposit: false });

  assert.equal(isRowRestricted(row), false);
  assert.equal(countActiveRestrictions(row), 0);
});
