import assert from "node:assert/strict";
import test from "node:test";

import {
  FTD_MAX_ACCOUNT_AGE_DAYS,
  isFtdAccountAgeEligible,
} from "./ftd-account-age";

const createdAt = new Date("2026-01-01T00:00:00.000Z");
const daysAfterCreation = (days: number) =>
  new Date(createdAt.getTime() + days * 24 * 60 * 60 * 1_000);

test("FTD permits a first deposit through exactly four weeks", () => {
  assert.equal(FTD_MAX_ACCOUNT_AGE_DAYS, 28);
  assert.equal(isFtdAccountAgeEligible(createdAt, createdAt), true);
  assert.equal(isFtdAccountAgeEligible(createdAt, daysAfterCreation(28)), true);
});

test("FTD rejects older accounts and invalid pre-signup deposits", () => {
  assert.equal(
    isFtdAccountAgeEligible(
      createdAt,
      new Date(daysAfterCreation(28).getTime() + 1),
    ),
    false,
  );
  assert.equal(
    isFtdAccountAgeEligible(
      createdAt,
      new Date(createdAt.getTime() - 1),
    ),
    false,
  );
});
