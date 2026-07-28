import type { CountryRestrictionRow } from "@/lib/queries/geo-blocking";

export type RestrictionValue = boolean | string[];

export type RestrictionProperty = {
  [K in keyof CountryRestrictionRow]: CountryRestrictionRow[K] extends
    | boolean
    | string[]
    ? K
    : never;
}[keyof CountryRestrictionRow];

export type ConfirmedRestrictionOverride = {
  countryCode: string;
  property: RestrictionProperty;
  value: RestrictionValue;
  revision: number;
};

export type ConfirmedRestrictionOverrides = Record<
  string,
  ConfirmedRestrictionOverride
>;

export function restrictionOverrideKey(
  countryCode: string,
  property: RestrictionProperty,
): string {
  return `${countryCode}:${property}`;
}

export function applyRestrictionValue(
  rows: CountryRestrictionRow[],
  countryCode: string,
  property: RestrictionProperty,
  value: RestrictionValue,
): CountryRestrictionRow[] {
  return rows.map((row) =>
    row.countryCode === countryCode
      ? ({
          ...row,
          [property]: Array.isArray(value) ? [...value] : value,
        } as CountryRestrictionRow)
      : row,
  );
}

export function rememberConfirmedRestriction(
  overrides: ConfirmedRestrictionOverrides,
  override: ConfirmedRestrictionOverride,
): ConfirmedRestrictionOverrides {
  return {
    ...overrides,
    [restrictionOverrideKey(override.countryCode, override.property)]: {
      ...override,
      value: Array.isArray(override.value)
        ? [...override.value]
        : override.value,
    },
  };
}

function valuesEqual(left: RestrictionValue, right: RestrictionValue): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => value === right[index])
    );
  }
  return left === right;
}

/**
 * Reconcile a fresh Server Component payload with values that the mutation
 * primary already returned from `UPDATE ... RETURNING`.
 *
 * A revalidation can reach the read mirror before replication catches up.
 * Keep the primary-confirmed value in the UI until a later payload matches it,
 * then retire the override so future external changes can flow through.
 */
export function reconcileConfirmedRestrictions(
  incomingRows: CountryRestrictionRow[],
  overrides: ConfirmedRestrictionOverrides,
): {
  rows: CountryRestrictionRow[];
  remainingOverrides: ConfirmedRestrictionOverrides;
} {
  let rows = incomingRows;
  const remainingOverrides: ConfirmedRestrictionOverrides = {};

  for (const [key, override] of Object.entries(overrides)) {
    const incoming = incomingRows.find(
      (row) => row.countryCode === override.countryCode,
    );
    if (!incoming) {
      remainingOverrides[key] = override;
      continue;
    }

    const incomingValue = incoming[override.property] as RestrictionValue;
    if (valuesEqual(incomingValue, override.value)) {
      continue;
    }

    rows = applyRestrictionValue(
      rows,
      override.countryCode,
      override.property,
      override.value,
    );
    remainingOverrides[key] = override;
  }

  return { rows, remainingOverrides };
}
