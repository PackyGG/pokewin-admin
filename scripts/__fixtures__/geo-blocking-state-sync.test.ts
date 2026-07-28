import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyRestrictionValue,
  reconcileConfirmedRestrictions,
  rememberConfirmedRestriction,
  type ConfirmedRestrictionOverrides,
} from "@/app/(admin)/system/geo-blocking/restriction-state";
import type { CountryRestrictionRow } from "@/lib/queries/geo-blocking";

const baseRow: CountryRestrictionRow = {
  countryCode: "BV",
  physicalWithdrawal: true,
  digitalWithdrawal: true,
  giftCardDeposit: true,
  promoCodeDeposit: true,
  blocked: false,
  lockedDepositsCrypto: [],
  lockedDepositsFiat: [],
  lockedWithdrawalsCrypto: [],
};

test("primary-confirmed fiat value survives stale transition props until readback catches up", () => {
  const property = "lockedDepositsFiat" as const;
  const initialRows = [baseRow];

  const optimisticRows = applyRestrictionValue(
    initialRows,
    "BV",
    property,
    ["credit_card", "apple_pay", "google_pay"],
  );
  assert.deepEqual(optimisticRows[0].lockedDepositsFiat, [
    "credit_card",
    "apple_pay",
    "google_pay",
  ]);

  let overrides: ConfirmedRestrictionOverrides =
    rememberConfirmedRestriction(
      {},
      {
        countryCode: "BV",
        property,
        value: optimisticRows[0].lockedDepositsFiat,
        revision: 1,
      },
    );

  const staleTransition = reconcileConfirmedRestrictions(
    initialRows,
    overrides,
  );
  assert.deepEqual(staleTransition.rows[0].lockedDepositsFiat, [
    "credit_card",
    "apple_pay",
    "google_pay",
  ]);
  assert.equal(Object.keys(staleTransition.remainingOverrides).length, 1);

  const freshReadbackRows = [
    {
      ...baseRow,
      lockedDepositsFiat: [
        "credit_card",
        "apple_pay",
        "google_pay",
      ],
    },
  ];
  const freshReadback = reconcileConfirmedRestrictions(
    freshReadbackRows,
    staleTransition.remainingOverrides,
  );
  assert.deepEqual(
    freshReadback.rows[0].lockedDepositsFiat,
    freshReadbackRows[0].lockedDepositsFiat,
  );
  assert.deepEqual(freshReadback.remainingOverrides, {});

  overrides = rememberConfirmedRestriction(
    freshReadback.remainingOverrides,
    {
      countryCode: "BV",
      property,
      value: [],
      revision: 2,
    },
  );
  const staleReverseTransition = reconcileConfirmedRestrictions(
    freshReadbackRows,
    overrides,
  );
  assert.deepEqual(staleReverseTransition.rows[0].lockedDepositsFiat, []);

  const freshReverseReadback = reconcileConfirmedRestrictions(
    [baseRow],
    staleReverseTransition.remainingOverrides,
  );
  assert.deepEqual(freshReverseReadback.rows[0].lockedDepositsFiat, []);
  assert.deepEqual(freshReverseReadback.remainingOverrides, {});
});

test("an actual rejected mutation rolls the optimistic value back without a confirmed override", async () => {
  let rows = applyRestrictionValue(
    [baseRow],
    "BV",
    "lockedDepositsFiat",
    ["credit_card", "apple_pay", "google_pay"],
  );
  const failedMutation = async (): Promise<{ persistedValues: string[] }> => {
    throw new Error("database write failed");
  };

  await assert.rejects(failedMutation(), /database write failed/);
  try {
    await failedMutation();
  } catch {
    rows = applyRestrictionValue(
      rows,
      "BV",
      "lockedDepositsFiat",
      baseRow.lockedDepositsFiat,
    );
  }

  assert.deepEqual(rows, [baseRow]);
  assert.deepEqual(
    reconcileConfirmedRestrictions(rows, {}).remainingOverrides,
    {},
  );
});

test("the component wires authoritative readback, stale-prop reconciliation, refresh, and failure rollback", () => {
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  const componentSource = readFileSync(
    path.join(
      repoRoot,
      "src/app/(admin)/system/geo-blocking/geo-blocking-content.tsx",
    ),
    "utf8",
  );
  const actionSource = readFileSync(
    path.join(
      repoRoot,
      "src/app/(admin)/system/geo-blocking/actions.ts",
    ),
    "utf8",
  );

  assert.match(componentSource, /reconcileConfirmedRestrictions\(/);
  assert.doesNotMatch(
    componentSource,
    /\[countryRestrictions,\s*isPending,\s*siteLockedMethods\]/,
  );
  assert.match(componentSource, /res\.persistedValues/);
  assert.match(componentSource, /patchRow\(countryCode, prop, previousValues\)/);
  assert.match(componentSource, /router\.refresh\(\)/);
  assert.match(actionSource, /persisted_values:\s*persistedColumn/);
  assert.match(actionSource, /persistedValues:\s*updated\[0\]\.persisted_values/);
});
