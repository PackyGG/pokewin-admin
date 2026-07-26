export type ScoreOption = {
  label: string;
  points: number;
};

export type ScoreDefinition = {
  key: string;
  title: string;
  description: string;
  options: ScoreOption[];
};

export const SCORE_POINTS = {
  sharedDevice: { twoAccounts: 70, threePlusAccounts: 95 },
  ipVelocity10m: 50,
  ipVelocity30m: 80,
  ipv6SubnetVelocity: 40,
  existingAltFlag: 45,
  generatedUsername: 15,
  missingEmail: 5,
  fingerprintMissing: 15,
  fingerprintBadBot: 80,
  fingerprintVpn: 20,
  fingerprintProxy: 35,
  fingerprintTor: 65,
  fingerprintIncognito: 10,
  fingerprintTampering: 70,
  fingerprintVirtualMachine: 25,
  fingerprintHighActivity: 45,
  fingerprintSuspectScore: { divisor: 2, threshold: 20, maximum: 50 },
  proxycheckAnonymous: { lowerRisk: 25, torProxyCompromised: 55 },
  proxycheckRisk: { threshold: 51, highThreshold: 76, medium: 25, high: 45 },
  deposit: -20,
  paidPackOpened: -5,
  rewardOpened: 20,
  bonusReceived: 20,
  rainJoined: 20,
} as const;

export const SEVERITY_BANDS = [
  { key: "low", label: "Low", minimum: 0, maximum: 39 },
  { key: "medium", label: "Medium", minimum: 40, maximum: 79 },
  { key: "high", label: "High", minimum: 80, maximum: 119 },
  { key: "critical", label: "Critical", minimum: 120, maximum: null },
] as const;

export const SIGNUP_SCORE_DEFINITIONS: ScoreDefinition[] = [
  {
    key: "shared_device",
    title: "Shared device",
    description: "Accounts sharing the same Fingerprint visitor ID.",
    options: [
      { label: "2 accounts", points: SCORE_POINTS.sharedDevice.twoAccounts },
      {
        label: "3 or more accounts",
        points: SCORE_POINTS.sharedDevice.threePlusAccounts,
      },
    ],
  },
  {
    key: "ip_velocity_10m",
    title: "Signup IP velocity",
    description: "At least 3 accounts use the same IP within 10 minutes.",
    options: [{ label: "Matched", points: SCORE_POINTS.ipVelocity10m }],
  },
  {
    key: "ip_velocity_30m",
    title: "Sustained signup IP velocity",
    description: "At least 5 accounts use the same IP within 30 minutes.",
    options: [{ label: "Matched", points: SCORE_POINTS.ipVelocity30m }],
  },
  {
    key: "ipv6_subnet_velocity",
    title: "IPv6 household velocity",
    description: "At least 3 accounts share an IPv6 /64 within 30 minutes.",
    options: [{ label: "Matched", points: SCORE_POINTS.ipv6SubnetVelocity }],
  },
  {
    key: "existing_alt_flag",
    title: "Existing alt-account flag",
    description:
      "Packy marked the account as a suspected alternate and no shared-device signal already applies.",
    options: [{ label: "Matched", points: SCORE_POINTS.existingAltFlag }],
  },
  {
    key: "generated_username",
    title: "Generated-looking username",
    description: "The username resembles machine-generated account data.",
    options: [{ label: "Matched", points: SCORE_POINTS.generatedUsername }],
  },
  {
    key: "missing_email",
    title: "Missing email",
    description: "The signup has no stored email address.",
    options: [{ label: "Matched", points: SCORE_POINTS.missingEmail }],
  },
];

export const PROVIDER_SCORE_DEFINITIONS: ScoreDefinition[] = [
  {
    key: "fingerprint_missing",
    title: "Fingerprint missing",
    description: "Signup completed without a stored Fingerprint event.",
    options: [{ label: "Missing", points: SCORE_POINTS.fingerprintMissing }],
  },
  {
    key: "fingerprint_bad_bot",
    title: "Bad bot detected",
    description: "Fingerprint identified automation or a malicious bot.",
    options: [{ label: "Detected", points: SCORE_POINTS.fingerprintBadBot }],
  },
  {
    key: "fingerprint_vpn",
    title: "VPN detected",
    description: "Fingerprint detected VPN use or a location mismatch.",
    options: [{ label: "Detected", points: SCORE_POINTS.fingerprintVpn }],
  },
  {
    key: "fingerprint_proxy",
    title: "Proxy detected",
    description: "Fingerprint detected a public or residential proxy.",
    options: [{ label: "Detected", points: SCORE_POINTS.fingerprintProxy }],
  },
  {
    key: "fingerprint_tor",
    title: "Tor detected",
    description: "Fingerprint identified a Tor exit node.",
    options: [{ label: "Detected", points: SCORE_POINTS.fingerprintTor }],
  },
  {
    key: "fingerprint_incognito",
    title: "Private browsing",
    description: "The account was created in private/incognito mode.",
    options: [{ label: "Detected", points: SCORE_POINTS.fingerprintIncognito }],
  },
  {
    key: "fingerprint_tampering",
    title: "Browser tampering",
    description: "Fingerprint detected an anti-detect or tampered browser.",
    options: [{ label: "Detected", points: SCORE_POINTS.fingerprintTampering }],
  },
  {
    key: "fingerprint_virtual_machine",
    title: "Virtual machine",
    description: "The signup browser appears to run in a virtual machine.",
    options: [
      { label: "Detected", points: SCORE_POINTS.fingerprintVirtualMachine },
    ],
  },
  {
    key: "fingerprint_high_activity",
    title: "High-activity device",
    description: "Fingerprint classifies the device as unusually active.",
    options: [
      { label: "Detected", points: SCORE_POINTS.fingerprintHighActivity },
    ],
  },
  {
    key: "fingerprint_suspect_score",
    title: "Fingerprint suspect score",
    description: "Applies from provider score 20: score / 2, rounded, capped at 50.",
    options: [
      {
        label: "Formula maximum",
        points: SCORE_POINTS.fingerprintSuspectScore.maximum,
      },
    ],
  },
  {
    key: "proxycheck_anonymous",
    title: "Anonymous IP",
    description: "proxycheck.io identifies anonymized traffic.",
    options: [
      {
        label: "VPN or anonymous",
        points: SCORE_POINTS.proxycheckAnonymous.lowerRisk,
      },
      {
        label: "Tor, proxy or compromised",
        points: SCORE_POINTS.proxycheckAnonymous.torProxyCompromised,
      },
    ],
  },
  {
    key: "proxycheck_risk",
    title: "High-risk IP",
    description: "proxycheck.io risk score is at least 51.",
    options: [
      { label: "Risk 51–75", points: SCORE_POINTS.proxycheckRisk.medium },
      { label: "Risk 76+", points: SCORE_POINTS.proxycheckRisk.high },
    ],
  },
];

export const ACTIVITY_SCORE_DEFINITIONS: ScoreDefinition[] = [
  {
    key: "deposit",
    title: "Deposit",
    description: "A deposit during the active monitoring window reduces risk.",
    options: [{ label: "Recorded", points: SCORE_POINTS.deposit }],
  },
  {
    key: "paid_pack_opened",
    title: "Paid pack opened",
    description: "Normal paid play during monitoring slightly reduces risk.",
    options: [{ label: "Recorded", points: SCORE_POINTS.paidPackOpened }],
  },
  {
    key: "reward_opened",
    title: "Reward opened",
    description: "A reward pack is consumed during monitoring.",
    options: [{ label: "Recorded", points: SCORE_POINTS.rewardOpened }],
  },
  {
    key: "bonus_received",
    title: "Bonus received",
    description: "A bonus or reward credit is received during monitoring.",
    options: [{ label: "Recorded", points: SCORE_POINTS.bonusReceived }],
  },
  {
    key: "rain_joined",
    title: "Rain joined",
    description: "The monitored account claims a rain reward.",
    options: [{ label: "Recorded", points: SCORE_POINTS.rainJoined }],
  },
];

export function activityScoreFor(eventType: string): number {
  switch (eventType) {
    case "deposit":
      return SCORE_POINTS.deposit;
    case "paid_pack_opened":
      return SCORE_POINTS.paidPackOpened;
    case "reward_opened":
      return SCORE_POINTS.rewardOpened;
    case "bonus_received":
      return SCORE_POINTS.bonusReceived;
    case "rain_joined":
      return SCORE_POINTS.rainJoined;
    default:
      return 0;
  }
}
