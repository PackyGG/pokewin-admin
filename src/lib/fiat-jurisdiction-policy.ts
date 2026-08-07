import type { CountryRestrictionRow } from "@/lib/queries/geo-blocking";

export const CREDIT_CARD_DEPOSIT_METHOD = "credit_card";
export const LEGACY_FIAT_DEPOSIT_METHOD = "fiat";
export const GEO_POLICY_SITE_CONFIG_KEYS = ["locked_deposits_fiat"] as const;
export const WHOP_FIAT_DEPOSIT_LOCK_TOKENS = [
  CREDIT_CARD_DEPOSIT_METHOD,
  "apple_pay",
  "google_pay",
  "cash_app",
  "cashapp",
] as const;

/**
 * Exact backend lock names used by deposit-address and withdrawal routes.
 * Keep these concrete instead of relying on the special `all` token: current
 * withdrawal routes understand `all`, while deposit-address filtering checks
 * concrete asset names.
 */
export const CRYPTO_RESTRICTION_TOKENS = [
  "bitcoin",
  "ethereum",
  "litecoin",
  "solana",
  "usdt_erc20",
  "usdt_trc20",
  "usdt_sol",
  "usdc_erc20",
  "usdc_sol",
  "doge",
  "xrp",
] as const;

const WHOP_FIAT_DEPOSIT_LOCK_SET = new Set<string>([
  LEGACY_FIAT_DEPOSIT_METHOD,
  ...WHOP_FIAT_DEPOSIT_LOCK_TOKENS,
]);

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

type MandatoryFiatJurisdiction = {
  code: string;
  name: string;
};

const MANDATORY_FIAT_JURISDICTIONS =
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

export function isWhopFiatDepositLockToken(method: string): boolean {
  return WHOP_FIAT_DEPOSIT_LOCK_SET.has(method);
}

export function withoutWhopFiatDepositLocks(
  methods: readonly string[],
): string[] {
  return [
    ...new Set(
      methods.filter((method) => !isWhopFiatDepositLockToken(method)),
    ),
  ];
}

export function withWhopFiatDepositLocks(
  methods: readonly string[],
): string[] {
  return [
    ...withoutWhopFiatDepositLocks(methods),
    ...WHOP_FIAT_DEPOSIT_LOCK_TOKENS,
  ];
}

function isCreditCardDepositLocked(
  methods: readonly string[],
): boolean {
  return (
    methods.includes(CREDIT_CARD_DEPOSIT_METHOD) ||
    methods.includes(LEGACY_FIAT_DEPOSIT_METHOD)
  );
}

export function hasAnyWhopFiatDepositLock(
  methods: readonly string[],
): boolean {
  return methods.some(isWhopFiatDepositLockToken);
}

export function hasAllWhopFiatDepositLocks(
  methods: readonly string[],
): boolean {
  const configured = new Set(methods);
  return WHOP_FIAT_DEPOSIT_LOCK_TOKENS.every((method) =>
    configured.has(method),
  );
}

function withRequiredTokens(
  methods: readonly string[],
  required: readonly string[],
): string[] {
  return [...new Set([...methods, ...required])];
}

function hasAllRequiredTokens(
  methods: readonly string[],
  required: readonly string[],
): boolean {
  const configured = new Set(methods);
  return required.every((method) => configured.has(method));
}

export function hasAllCryptoRestrictionTokens(
  methods: readonly string[],
): boolean {
  return hasAllRequiredTokens(methods, CRYPTO_RESTRICTION_TOKENS);
}

/**
 * A mandatory jurisdiction is a full legal exclusion, not only a landing-page
 * redirect. Keep every independently enforced backend capability closed so a
 * stale/missed frontend redirect cannot expose a direct money or code route.
 */
export function applyMandatoryJurisdictionPolicy(
  row: CountryRestrictionRow,
): CountryRestrictionRow {
  if (!isMandatoryFiatJurisdiction(row.countryCode)) return row;

  return {
    ...row,
    blocked: true,
    physicalWithdrawal: false,
    digitalWithdrawal: false,
    giftCardDeposit: false,
    promoCodeDeposit: false,
    lockedDepositsCrypto: withRequiredTokens(
      row.lockedDepositsCrypto,
      CRYPTO_RESTRICTION_TOKENS,
    ),
    lockedDepositsFiat: withWhopFiatDepositLocks(row.lockedDepositsFiat),
    lockedWithdrawalsCrypto: withRequiredTokens(
      row.lockedWithdrawalsCrypto,
      CRYPTO_RESTRICTION_TOKENS,
    ),
  };
}

export function isMandatoryJurisdictionPolicyEnforced(
  row: CountryRestrictionRow,
): boolean {
  return (
    isMandatoryFiatJurisdiction(row.countryCode) &&
    row.blocked &&
    !row.physicalWithdrawal &&
    !row.digitalWithdrawal &&
    !row.giftCardDeposit &&
    !row.promoCodeDeposit &&
    hasAllCryptoRestrictionTokens(row.lockedDepositsCrypto) &&
    hasAllWhopFiatDepositLocks(row.lockedDepositsFiat) &&
    hasAllCryptoRestrictionTokens(row.lockedWithdrawalsCrypto)
  );
}

function applyGlobalFiatPolicy(
  rows: readonly CountryRestrictionRow[],
  allowed: boolean,
): CountryRestrictionRow[] {
  return rows.map((row) => {
    const next = {
      ...row,
      lockedDepositsFiat:
        !allowed || isMandatoryFiatJurisdiction(row.countryCode)
          ? withWhopFiatDepositLocks(row.lockedDepositsFiat)
          : withoutWhopFiatDepositLocks(row.lockedDepositsFiat),
    };
    return applyMandatoryJurisdictionPolicy(next);
  });
}

export function isGlobalFiatPolicyActive(
  siteLockedMethods: readonly string[],
  _rows: readonly CountryRestrictionRow[],
): boolean {
  return !hasAnyWhopFiatDepositLock(siteLockedMethods);
}
