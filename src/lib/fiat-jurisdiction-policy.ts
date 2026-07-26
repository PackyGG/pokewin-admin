import type { CountryRestrictionRow } from "@/lib/queries/geo-blocking";

export const CREDIT_CARD_DEPOSIT_METHOD = "credit_card";
export const LEGACY_FIAT_DEPOSIT_METHOD = "fiat";

export const FIAT_JURISDICTION_POLICY = [
  {
    key: "prohibited_states",
    label: "Prohibited states",
    jurisdictions: [
      { code: "US-WA", name: "Washington" },
      { code: "US-NV", name: "Nevada" },
      { code: "US-MI", name: "Michigan" },
      { code: "US-ID", name: "Idaho" },
      { code: "US-NJ", name: "New Jersey" },
      { code: "US-MT", name: "Montana" },
      { code: "US-CT", name: "Connecticut" },
      { code: "US-CA", name: "California" },
      { code: "US-NY", name: "New York" },
    ],
  },
  {
    key: "enhanced_monitoring_states",
    label: "Enhanced monitoring states",
    jurisdictions: [
      { code: "US-MD", name: "Maryland" },
      { code: "US-LA", name: "Louisiana" },
      { code: "US-MS", name: "Mississippi" },
      { code: "US-DE", name: "Delaware" },
    ],
  },
  {
    key: "sanctions_restricted",
    label: "Sanctions / restricted jurisdictions",
    jurisdictions: [
      { code: "AF", name: "Afghanistan" },
      { code: "BY", name: "Belarus" },
      { code: "CU", name: "Cuba" },
      { code: "IR", name: "Iran" },
      { code: "KP", name: "North Korea" },
      { code: "RU", name: "Russia" },
      { code: "SY", name: "Syria" },
      { code: "VE", name: "Venezuela" },
      { code: "UA-43", name: "Crimea Region" },
      { code: "UA-14", name: "Donetsk Region" },
      { code: "UA-09", name: "Luhansk Region" },
      { code: "UA-40", name: "Sevastopol Region" },
    ],
  },
  {
    key: "high_risk",
    label: "High-risk jurisdictions",
    jurisdictions: [
      { code: "MM", name: "Myanmar" },
      { code: "YE", name: "Yemen" },
      { code: "SD", name: "Sudan" },
      { code: "SS", name: "South Sudan" },
      { code: "CD", name: "Democratic Republic of Congo" },
      { code: "HT", name: "Haiti" },
      { code: "SO", name: "Somalia" },
      { code: "LB", name: "Lebanon" },
    ],
  },
] as const;

export type MandatoryFiatJurisdiction = {
  code: string;
  name: string;
};

export const MANDATORY_FIAT_JURISDICTIONS =
  FIAT_JURISDICTION_POLICY.reduce<MandatoryFiatJurisdiction[]>(
    (all, group) => [...all, ...group.jurisdictions],
    [],
  );

export const MANDATORY_FIAT_JURISDICTION_CODES =
  MANDATORY_FIAT_JURISDICTIONS.map((jurisdiction) => jurisdiction.code);

const MANDATORY_CODE_SET = new Set<string>(
  MANDATORY_FIAT_JURISDICTION_CODES,
);

const JURISDICTION_NAME_BY_CODE = new Map<string, string>(
  MANDATORY_FIAT_JURISDICTIONS.map((jurisdiction) => [
    jurisdiction.code,
    jurisdiction.name,
  ]),
);

export function isMandatoryFiatJurisdiction(code: string): boolean {
  return MANDATORY_CODE_SET.has(code.toUpperCase());
}

export function fiatJurisdictionName(code: string): string | undefined {
  return JURISDICTION_NAME_BY_CODE.get(code.toUpperCase());
}

export function withoutCreditCardLock(methods: readonly string[]): string[] {
  return [
    ...new Set(
      methods.filter(
        (method) =>
          method !== CREDIT_CARD_DEPOSIT_METHOD &&
          method !== LEGACY_FIAT_DEPOSIT_METHOD,
      ),
    ),
  ];
}

export function withCreditCardLock(methods: readonly string[]): string[] {
  return [
    ...withoutCreditCardLock(methods),
    CREDIT_CARD_DEPOSIT_METHOD,
  ];
}

export function isCreditCardDepositLocked(
  methods: readonly string[],
): boolean {
  return (
    methods.includes(CREDIT_CARD_DEPOSIT_METHOD) ||
    methods.includes(LEGACY_FIAT_DEPOSIT_METHOD)
  );
}

export function applyGlobalFiatPolicy(
  rows: readonly CountryRestrictionRow[],
  allowed: boolean,
): CountryRestrictionRow[] {
  return rows.map((row) => ({
    ...row,
    lockedDepositsFiat:
      !allowed || isMandatoryFiatJurisdiction(row.countryCode)
        ? withCreditCardLock(row.lockedDepositsFiat)
        : withoutCreditCardLock(row.lockedDepositsFiat),
  }));
}

export function isGlobalFiatPolicyActive(
  siteLockedMethods: readonly string[],
  rows: readonly CountryRestrictionRow[],
): boolean {
  if (isCreditCardDepositLocked(siteLockedMethods)) return false;

  const rowsByCode = new Map(rows.map((row) => [row.countryCode, row]));
  if (
    MANDATORY_FIAT_JURISDICTION_CODES.some(
      (code) =>
        !rowsByCode.has(code) ||
        !isCreditCardDepositLocked(
          rowsByCode.get(code)?.lockedDepositsFiat ?? [],
        ),
    )
  ) {
    return false;
  }

  return rows.every(
    (row) =>
      isMandatoryFiatJurisdiction(row.countryCode) ||
      !isCreditCardDepositLocked(row.lockedDepositsFiat),
  );
}
