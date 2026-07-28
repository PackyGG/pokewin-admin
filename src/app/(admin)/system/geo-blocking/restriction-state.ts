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

export const CONFIRMED_RESTRICTIONS_STORAGE_KEY =
  "geo-blocking:primary-confirmed:v1";
export const CONFIRMED_RESTRICTIONS_MAX_AGE_MS = 10 * 60 * 1000;

const ARRAY_RESTRICTION_PROPERTIES = new Set<RestrictionProperty>([
  "lockedDepositsCrypto",
  "lockedDepositsFiat",
  "lockedWithdrawalsCrypto",
]);

const RESTRICTION_PROPERTIES = new Set<RestrictionProperty>([
  "physicalWithdrawal",
  "digitalWithdrawal",
  "giftCardDeposit",
  "promoCodeDeposit",
  "blocked",
  ...ARRAY_RESTRICTION_PROPERTIES,
]);

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

export function serializeConfirmedRestrictions(
  overrides: ConfirmedRestrictionOverrides,
  savedAt = Date.now(),
): string {
  return JSON.stringify({ version: 1, savedAt, overrides });
}

export function parseConfirmedRestrictions(
  serialized: string | null,
  now = Date.now(),
): ConfirmedRestrictionOverrides {
  if (!serialized) return {};

  try {
    const parsed = JSON.parse(serialized) as {
      version?: unknown;
      savedAt?: unknown;
      overrides?: unknown;
    };
    if (
      parsed.version !== 1 ||
      typeof parsed.savedAt !== "number" ||
      !Number.isFinite(parsed.savedAt) ||
      parsed.savedAt > now ||
      now - parsed.savedAt > CONFIRMED_RESTRICTIONS_MAX_AGE_MS ||
      !parsed.overrides ||
      typeof parsed.overrides !== "object" ||
      Array.isArray(parsed.overrides)
    ) {
      return {};
    }

    const overrides: ConfirmedRestrictionOverrides = {};
    for (const [key, candidate] of Object.entries(parsed.overrides)) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        return {};
      }
      const override = candidate as Partial<ConfirmedRestrictionOverride>;
      if (
        typeof override.countryCode !== "string" ||
        !/^[A-Z]{2}(-[A-Z0-9]{2,3})?$/.test(override.countryCode) ||
        typeof override.property !== "string" ||
        !RESTRICTION_PROPERTIES.has(
          override.property as RestrictionProperty,
        ) ||
        typeof override.revision !== "number" ||
        !Number.isSafeInteger(override.revision) ||
        override.revision < 0
      ) {
        return {};
      }

      const property = override.property as RestrictionProperty;
      const valueIsValid = ARRAY_RESTRICTION_PROPERTIES.has(property)
        ? Array.isArray(override.value) &&
          override.value.every((value) => typeof value === "string")
        : typeof override.value === "boolean";
      if (
        !valueIsValid ||
        key !== restrictionOverrideKey(override.countryCode, property)
      ) {
        return {};
      }

      overrides[key] = {
        countryCode: override.countryCode,
        property,
        value: Array.isArray(override.value)
          ? [...override.value]
          : override.value,
        revision: override.revision,
      } as ConfirmedRestrictionOverride;
    }
    return overrides;
  } catch {
    return {};
  }
}
