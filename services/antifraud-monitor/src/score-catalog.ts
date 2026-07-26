export const DEFAULT_SCORE_WEIGHTS = {
  shared_device_two_accounts: 70,
  shared_device_three_plus_accounts: 95,
  ip_velocity_10m: 50,
  ip_velocity_30m: 80,
  ipv6_subnet_velocity: 40,
  existing_alt_flag: 45,
  generated_username: 15,
  missing_email: 5,
  fingerprint_missing: 15,
  fingerprint_bad_bot: 80,
  fingerprint_vpn: 20,
  fingerprint_proxy: 35,
  fingerprint_tor: 65,
  fingerprint_incognito: 10,
  fingerprint_tampering: 70,
  fingerprint_virtual_machine: 25,
  fingerprint_high_activity: 45,
  fingerprint_suspect_score_maximum: 50,
  proxycheck_anonymous_lower_risk: 25,
  proxycheck_anonymous_high_risk: 55,
  proxycheck_risk_medium: 25,
  proxycheck_risk_high: 45,
  crypto_deposit: -20,
  fiat_deposit: 20,
  deposit_unclassified: 20,
  paid_pack_opened: -5,
  reward_opened: 20,
  bonus_received: 20,
} as const;

export type ScoreWeightKey = keyof typeof DEFAULT_SCORE_WEIGHTS;
export type ScoreWeights = Record<ScoreWeightKey, number>;

export const SCORE_WEIGHT_KEYS = Object.keys(
  DEFAULT_SCORE_WEIGHTS,
) as ScoreWeightKey[];

export function isScoreWeightKey(value: string): value is ScoreWeightKey {
  return Object.hasOwn(DEFAULT_SCORE_WEIGHTS, value);
}

export function defaultScoreWeights(): ScoreWeights {
  return { ...DEFAULT_SCORE_WEIGHTS };
}

export function scorePoints(weights: ScoreWeights = defaultScoreWeights()) {
  return {
    sharedDevice: {
      twoAccounts: weights.shared_device_two_accounts,
      threePlusAccounts: weights.shared_device_three_plus_accounts,
    },
    ipVelocity10m: weights.ip_velocity_10m,
    ipVelocity30m: weights.ip_velocity_30m,
    ipv6SubnetVelocity: weights.ipv6_subnet_velocity,
    existingAltFlag: weights.existing_alt_flag,
    generatedUsername: weights.generated_username,
    missingEmail: weights.missing_email,
    fingerprintMissing: weights.fingerprint_missing,
    fingerprintBadBot: weights.fingerprint_bad_bot,
    fingerprintVpn: weights.fingerprint_vpn,
    fingerprintProxy: weights.fingerprint_proxy,
    fingerprintTor: weights.fingerprint_tor,
    fingerprintIncognito: weights.fingerprint_incognito,
    fingerprintTampering: weights.fingerprint_tampering,
    fingerprintVirtualMachine: weights.fingerprint_virtual_machine,
    fingerprintHighActivity: weights.fingerprint_high_activity,
    fingerprintSuspectScore: {
      divisor: 2,
      threshold: 20,
      maximum: weights.fingerprint_suspect_score_maximum,
    },
    proxycheckAnonymous: {
      lowerRisk: weights.proxycheck_anonymous_lower_risk,
      torProxyCompromised: weights.proxycheck_anonymous_high_risk,
    },
    proxycheckRisk: {
      threshold: 51,
      highThreshold: 76,
      medium: weights.proxycheck_risk_medium,
      high: weights.proxycheck_risk_high,
    },
    cryptoDeposit: weights.crypto_deposit,
    fiatDeposit: weights.fiat_deposit,
    unclassifiedDeposit: weights.deposit_unclassified,
    paidPackOpened: weights.paid_pack_opened,
    rewardOpened: weights.reward_opened,
    bonusReceived: weights.bonus_received,
  };
}

/** Defaults retained for tests and callers that do not supply live weights. */
export const SCORE_POINTS = scorePoints();

export type ScoreOption = {
  key: ScoreWeightKey;
  label: string;
  points: number;
};

export type ScoreDefinition = {
  key: string;
  title: string;
  description: string;
  options: ScoreOption[];
};

export const SEVERITY_BANDS = [
  { key: "low", label: "Low", minimum: 0, maximum: 39 },
  { key: "medium", label: "Medium", minimum: 40, maximum: 79 },
  { key: "high", label: "High", minimum: 80, maximum: 119 },
  { key: "critical", label: "Critical", minimum: 120, maximum: null },
] as const;

function option(
  weights: ScoreWeights,
  key: ScoreWeightKey,
  label: string,
): ScoreOption {
  return { key, label, points: weights[key] };
}

export function signupScoreDefinitions(
  weights: ScoreWeights,
): ScoreDefinition[] {
  return [
    {
      key: "shared_device",
      title: "Shared device",
      description: "Accounts sharing the same Fingerprint visitor ID.",
      options: [
        option(weights, "shared_device_two_accounts", "2 accounts"),
        option(
          weights,
          "shared_device_three_plus_accounts",
          "3 or more accounts",
        ),
      ],
    },
    {
      key: "ip_velocity_10m",
      title: "Signup IP velocity",
      description: "At least 3 accounts use the same IP within 10 minutes.",
      options: [option(weights, "ip_velocity_10m", "Matched")],
    },
    {
      key: "ip_velocity_30m",
      title: "Sustained signup IP velocity",
      description: "At least 5 accounts use the same IP within 30 minutes.",
      options: [option(weights, "ip_velocity_30m", "Matched")],
    },
    {
      key: "ipv6_subnet_velocity",
      title: "IPv6 household velocity",
      description: "At least 3 accounts share an IPv6 /64 within 30 minutes.",
      options: [option(weights, "ipv6_subnet_velocity", "Matched")],
    },
    {
      key: "existing_alt_flag",
      title: "Existing alt-account flag",
      description:
        "Packy marked the account as a suspected alternate and no shared-device signal already applies.",
      options: [option(weights, "existing_alt_flag", "Matched")],
    },
    {
      key: "generated_username",
      title: "Generated-looking username",
      description: "The username resembles machine-generated account data.",
      options: [option(weights, "generated_username", "Matched")],
    },
    {
      key: "missing_email",
      title: "Missing email",
      description: "The signup has no stored email address.",
      options: [option(weights, "missing_email", "Matched")],
    },
  ];
}

export function providerScoreDefinitions(
  weights: ScoreWeights,
): ScoreDefinition[] {
  return [
    {
      key: "fingerprint_missing",
      title: "Fingerprint missing",
      description: "Signup completed without a stored Fingerprint event.",
      options: [option(weights, "fingerprint_missing", "Missing")],
    },
    {
      key: "fingerprint_bad_bot",
      title: "Bad bot detected",
      description: "Fingerprint identified automation or a malicious bot.",
      options: [option(weights, "fingerprint_bad_bot", "Detected")],
    },
    {
      key: "fingerprint_vpn",
      title: "VPN detected",
      description: "Fingerprint detected VPN use or a location mismatch.",
      options: [option(weights, "fingerprint_vpn", "Detected")],
    },
    {
      key: "fingerprint_proxy",
      title: "Proxy detected",
      description: "Fingerprint detected a public or residential proxy.",
      options: [option(weights, "fingerprint_proxy", "Detected")],
    },
    {
      key: "fingerprint_tor",
      title: "Tor detected",
      description: "Fingerprint identified a Tor exit node.",
      options: [option(weights, "fingerprint_tor", "Detected")],
    },
    {
      key: "fingerprint_incognito",
      title: "Private browsing",
      description: "The account was created in private/incognito mode.",
      options: [option(weights, "fingerprint_incognito", "Detected")],
    },
    {
      key: "fingerprint_tampering",
      title: "Browser tampering",
      description: "Fingerprint detected an anti-detect or tampered browser.",
      options: [option(weights, "fingerprint_tampering", "Detected")],
    },
    {
      key: "fingerprint_virtual_machine",
      title: "Virtual machine",
      description: "The signup browser appears to run in a virtual machine.",
      options: [option(weights, "fingerprint_virtual_machine", "Detected")],
    },
    {
      key: "fingerprint_high_activity",
      title: "High-activity device",
      description: "Fingerprint classifies the device as unusually active.",
      options: [option(weights, "fingerprint_high_activity", "Detected")],
    },
    {
      key: "fingerprint_suspect_score",
      title: "Fingerprint suspect score",
      description:
        "Applies from provider score 20: score / 2, rounded, capped at the configured maximum.",
      options: [
        option(
          weights,
          "fingerprint_suspect_score_maximum",
          "Formula maximum",
        ),
      ],
    },
    {
      key: "proxycheck_anonymous",
      title: "Proxy, VPN or anonymous IP",
      description:
        "proxycheck.io identifies a proxy, VPN, Tor exit, compromised IP, scraper or hosting network.",
      options: [
        option(
          weights,
          "proxycheck_anonymous_lower_risk",
          "VPN, hosting, scraper or anonymous",
        ),
        option(
          weights,
          "proxycheck_anonymous_high_risk",
          "Tor, proxy or compromised IP",
        ),
      ],
    },
    {
      key: "proxycheck_risk",
      title: "High-risk IP",
      description: "proxycheck.io risk score is at least 51.",
      options: [
        option(weights, "proxycheck_risk_medium", "Risk 51–75"),
        option(weights, "proxycheck_risk_high", "Risk 76+"),
      ],
    },
  ];
}

export function activityScoreDefinitions(
  weights: ScoreWeights,
): ScoreDefinition[] {
  return [
    {
      key: "crypto_deposit",
      title: "Crypto deposit",
      description:
        "An irreversible crypto deposit during monitoring is normal player behavior.",
      options: [option(weights, "crypto_deposit", "Recorded")],
    },
    {
      key: "fiat_deposit",
      title: "Fiat deposit",
      description:
        "A reversible fiat/card deposit by an already-monitored signup raises payment-risk attention.",
      options: [option(weights, "fiat_deposit", "Recorded")],
    },
    {
      key: "deposit_unclassified",
      title: "Unclassified deposit",
      description:
        "A deposit without a fiat-intent link or crypto settlement evidence is held for review.",
      options: [option(weights, "deposit_unclassified", "Recorded")],
    },
    {
      key: "paid_pack_opened",
      title: "Paid pack opened",
      description: "Normal paid play during monitoring slightly reduces risk.",
      options: [option(weights, "paid_pack_opened", "Recorded")],
    },
    {
      key: "reward_opened",
      title: "Reward opened",
      description: "A reward pack is consumed during monitoring.",
      options: [option(weights, "reward_opened", "Recorded")],
    },
    {
      key: "bonus_received",
      title: "Bonus received",
      description: "A bonus or reward credit is received during monitoring.",
      options: [option(weights, "bonus_received", "Recorded")],
    },
  ];
}

export const SIGNUP_SCORE_DEFINITIONS = signupScoreDefinitions(
  defaultScoreWeights(),
);
export const PROVIDER_SCORE_DEFINITIONS = providerScoreDefinitions(
  defaultScoreWeights(),
);
export const ACTIVITY_SCORE_DEFINITIONS = activityScoreDefinitions(
  defaultScoreWeights(),
);

export function activityScoreFor(
  eventType: string,
  weights: ScoreWeights = defaultScoreWeights(),
): number {
  return isScoreWeightKey(eventType) &&
      Object.hasOwn(
        {
          crypto_deposit: true,
          fiat_deposit: true,
          deposit_unclassified: true,
          paid_pack_opened: true,
          reward_opened: true,
          bonus_received: true,
        },
        eventType,
      )
    ? weights[eventType]
    : 0;
}
