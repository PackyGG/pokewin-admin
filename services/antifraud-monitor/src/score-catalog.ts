export const DEFAULT_SCORE_WEIGHTS = {
  shared_device_two_accounts: 70,
  shared_device_three_plus_accounts: 95,
  shared_device_ten_plus_accounts: 140,
  shared_device_twenty_five_plus_accounts: 200,
  ip_velocity_10m: 60,
  ip_velocity_30m: 80,
  ip_velocity_30m_ten_plus: 120,
  ip_velocity_30m_twenty_five_plus: 200,
  ipv6_subnet_velocity: 40,
  existing_alt_flag: 45,
  generated_username: 25,
  disposable_email: 60,
  affiliate_ip_chain_three_plus: 50,
  affiliate_ip_chain_ten_plus: 100,
  affiliate_cluster_three_plus: 10,
  affiliate_cluster_ten_plus: 25,
  country_cluster_ten_plus: 25,
  country_cluster_twenty_five_plus: 50,
  risky_location: 15,
  fingerprint_missing: 15,
  fingerprint_event_replayed: 120,
  fingerprint_ip_mismatch: 90,
  fingerprint_linked_id_mismatch: 120,
  fingerprint_low_confidence: 10,
  fingerprint_bad_bot: 80,
  fingerprint_vpn: 20,
  fingerprint_proxy: 55,
  fingerprint_tor: 65,
  fingerprint_ip_attack_source: 80,
  fingerprint_ip_email_spam: 35,
  fingerprint_datacenter: 35,
  fingerprint_incognito: 10,
  fingerprint_tampering: 70,
  fingerprint_virtual_machine: 25,
  fingerprint_high_activity: 45,
  fingerprint_privacy_settings: 5,
  fingerprint_developer_tools: 10,
  fingerprint_rare_device: 20,
  fingerprint_velocity_ip_rotation: 45,
  fingerprint_velocity_country_hop: 50,
  fingerprint_velocity_multiple_accounts: 90,
  fingerprint_velocity_automation: 45,
  fingerprint_mobile_rooted: 70,
  fingerprint_mobile_emulator: 45,
  fingerprint_mobile_cloned_app: 70,
  fingerprint_mobile_jailbroken: 70,
  fingerprint_mobile_frida: 100,
  fingerprint_mobile_location_spoofing: 80,
  fingerprint_mobile_mitm: 100,
  fingerprint_mobile_recent_factory_reset: 20,
  fingerprint_proximity: 0,
  fingerprint_suspect_score_maximum: 50,
  proxycheck_anonymous_lower_risk: 25,
  proxycheck_anonymous_high_risk: 55,
  proxycheck_risk_medium: 40,
  proxycheck_risk_high: 80,
  abstract_ip_vpn: 20,
  abstract_ip_proxy: 55,
  abstract_ip_tor: 65,
  abstract_ip_hosting: 35,
  abstract_ip_relay: 25,
  abstract_ip_abuse: 80,
  abstract_ip_country_mismatch: 30,
  abstract_email_catchall: 100,
  abstract_email_undeliverable: 100,
  abstract_email_unknown_deliverability: 25,
  abstract_email_invalid_smtp: 70,
  abstract_email_disposable: 80,
  abstract_email_suspicious_username: 35,
  abstract_email_medium_risk: 40,
  abstract_email_high_risk: 80,
  abstract_email_risky_tld: 40,
  abstract_email_low_quality: 50,
  abstract_email_new_domain: 25,
  crypto_deposit: -20,
  fiat_deposit: -5,
  paid_pack_opened: -3,
  ledger_battle_bet: -3,
  ledger_battle_sponsorship: -3,
  ledger_upgrader_bet: -3,
  welcome_reward_opened: 0,
  level_one_reward_opened: 0,
  daily_reward_opened: -10,
  ledger_deposit_bonus: -10,
  ledger_rakeback_claim: -10,
  ledger_rain_win: 0,
  ledger_race_prize: -10,
  ledger_affiliate_leaderboard_prize: -10,
  ledger_challenge_prize: -10,
  ledger_creator_tip: 0,
  creator_sponsored_battle_received: 0,
  session_hopping: 50,
  dormant_device_switch: 60,
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
      tenPlusAccounts: weights.shared_device_ten_plus_accounts,
      twentyFivePlusAccounts: weights.shared_device_twenty_five_plus_accounts,
    },
    ipVelocity10m: weights.ip_velocity_10m,
    ipVelocity30m: {
      fivePlus: weights.ip_velocity_30m,
      tenPlus: weights.ip_velocity_30m_ten_plus,
      twentyFivePlus: weights.ip_velocity_30m_twenty_five_plus,
    },
    ipv6SubnetVelocity: weights.ipv6_subnet_velocity,
    existingAltFlag: weights.existing_alt_flag,
    generatedUsername: weights.generated_username,
    disposableEmail: weights.disposable_email,
    affiliateIpChain: {
      threePlus: weights.affiliate_ip_chain_three_plus,
      tenPlus: weights.affiliate_ip_chain_ten_plus,
    },
    affiliateCluster: {
      threePlus: weights.affiliate_cluster_three_plus,
      tenPlus: weights.affiliate_cluster_ten_plus,
    },
    countryCluster: {
      tenPlus: weights.country_cluster_ten_plus,
      twentyFivePlus: weights.country_cluster_twenty_five_plus,
    },
    riskyLocation: weights.risky_location,
    fingerprintMissing: weights.fingerprint_missing,
    fingerprintEventReplayed: weights.fingerprint_event_replayed,
    fingerprintIpMismatch: weights.fingerprint_ip_mismatch,
    fingerprintLinkedIdMismatch: weights.fingerprint_linked_id_mismatch,
    fingerprintLowConfidence: weights.fingerprint_low_confidence,
    fingerprintBadBot: weights.fingerprint_bad_bot,
    fingerprintVpn: weights.fingerprint_vpn,
    fingerprintProxy: weights.fingerprint_proxy,
    fingerprintTor: weights.fingerprint_tor,
    fingerprintIpAttackSource: weights.fingerprint_ip_attack_source,
    fingerprintIpEmailSpam: weights.fingerprint_ip_email_spam,
    fingerprintDatacenter: weights.fingerprint_datacenter,
    fingerprintIncognito: weights.fingerprint_incognito,
    fingerprintTampering: weights.fingerprint_tampering,
    fingerprintVirtualMachine: weights.fingerprint_virtual_machine,
    fingerprintHighActivity: weights.fingerprint_high_activity,
    fingerprintPrivacySettings: weights.fingerprint_privacy_settings,
    fingerprintDeveloperTools: weights.fingerprint_developer_tools,
    fingerprintRareDevice: weights.fingerprint_rare_device,
    fingerprintVelocityIpRotation:
      weights.fingerprint_velocity_ip_rotation,
    fingerprintVelocityCountryHop:
      weights.fingerprint_velocity_country_hop,
    fingerprintVelocityMultipleAccounts:
      weights.fingerprint_velocity_multiple_accounts,
    fingerprintVelocityAutomation:
      weights.fingerprint_velocity_automation,
    fingerprintMobileRooted: weights.fingerprint_mobile_rooted,
    fingerprintMobileEmulator: weights.fingerprint_mobile_emulator,
    fingerprintMobileClonedApp: weights.fingerprint_mobile_cloned_app,
    fingerprintMobileJailbroken: weights.fingerprint_mobile_jailbroken,
    fingerprintMobileFrida: weights.fingerprint_mobile_frida,
    fingerprintMobileLocationSpoofing:
      weights.fingerprint_mobile_location_spoofing,
    fingerprintMobileMitm: weights.fingerprint_mobile_mitm,
    fingerprintMobileRecentFactoryReset:
      weights.fingerprint_mobile_recent_factory_reset,
    fingerprintProximity: weights.fingerprint_proximity,
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
    abstractIp: {
      vpn: weights.abstract_ip_vpn,
      proxy: weights.abstract_ip_proxy,
      tor: weights.abstract_ip_tor,
      hosting: weights.abstract_ip_hosting,
      relay: weights.abstract_ip_relay,
      abuse: weights.abstract_ip_abuse,
      countryMismatch: weights.abstract_ip_country_mismatch,
    },
    abstractEmail: {
      catchall: weights.abstract_email_catchall,
      undeliverable: weights.abstract_email_undeliverable,
      unknownDeliverability: weights.abstract_email_unknown_deliverability,
      invalidSmtp: weights.abstract_email_invalid_smtp,
      disposable: weights.abstract_email_disposable,
      suspiciousUsername: weights.abstract_email_suspicious_username,
      mediumRisk: weights.abstract_email_medium_risk,
      highRisk: weights.abstract_email_high_risk,
      riskyTld: weights.abstract_email_risky_tld,
      lowQuality: weights.abstract_email_low_quality,
      newDomain: weights.abstract_email_new_domain,
    },
    cryptoDeposit: weights.crypto_deposit,
    fiatDeposit: weights.fiat_deposit,
    paidPackOpened: weights.paid_pack_opened,
    battleBet: weights.ledger_battle_bet,
    battleSponsorship: weights.ledger_battle_sponsorship,
    upgraderBet: weights.ledger_upgrader_bet,
    welcomeRewardOpened: weights.welcome_reward_opened,
    levelOneRewardOpened: weights.level_one_reward_opened,
    dailyRewardOpened: weights.daily_reward_opened,
    depositBonus: weights.ledger_deposit_bonus,
    rakebackClaim: weights.ledger_rakeback_claim,
    rainWin: weights.ledger_rain_win,
    racePrize: weights.ledger_race_prize,
    creatorLeaderboardPrize: weights.ledger_affiliate_leaderboard_prize,
    challengePrize: weights.ledger_challenge_prize,
    creatorTip: weights.ledger_creator_tip,
    creatorSponsoredBattle: weights.creator_sponsored_battle_received,
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
  { key: "low", label: "No risk", minimum: 0, maximum: 20 },
  { key: "medium", label: "Low risk", minimum: 21, maximum: 49 },
  { key: "high", label: "High risk", minimum: 50, maximum: 69 },
  { key: "critical", label: "Critical risk", minimum: 70, maximum: 100 },
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
          "3–9 accounts",
        ),
        option(
          weights,
          "shared_device_ten_plus_accounts",
          "10–24 accounts",
        ),
        option(
          weights,
          "shared_device_twenty_five_plus_accounts",
          "25 or more accounts",
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
      options: [
        option(weights, "ip_velocity_30m", "5–9 accounts"),
        option(weights, "ip_velocity_30m_ten_plus", "10–24 accounts"),
        option(
          weights,
          "ip_velocity_30m_twenty_five_plus",
          "25 or more accounts",
        ),
      ],
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
      key: "disposable_email",
      title: "Disposable email",
      description:
        "The signup email uses a known temporary or throwaway email domain.",
      options: [option(weights, "disposable_email", "Matched")],
    },
    {
      key: "affiliate_ip_chain",
      title: "Affiliate and IP chain",
      description:
        "Several accounts share both the same affiliate code and signup IP within 30 minutes.",
      options: [
        option(
          weights,
          "affiliate_ip_chain_three_plus",
          "3–9 accounts",
        ),
        option(weights, "affiliate_ip_chain_ten_plus", "10 or more accounts"),
      ],
    },
    {
      key: "affiliate_cluster",
      title: "Affiliate signup cluster",
      description:
        "Several accounts use the same affiliate code within 30 minutes. Kept low-weight because campaigns can create legitimate bursts.",
      options: [
        option(
          weights,
          "affiliate_cluster_three_plus",
          "3–9 accounts",
        ),
        option(weights, "affiliate_cluster_ten_plus", "10 or more accounts"),
      ],
    },
    {
      key: "country_cluster",
      title: "Country signup burst",
      description:
        "Many accounts from the same country register within 15 minutes.",
      options: [
        option(weights, "country_cluster_ten_plus", "10–24 accounts"),
        option(
          weights,
          "country_cluster_twenty_five_plus",
          "25 or more accounts",
        ),
      ],
    },
    {
      key: "risky_location",
      title: "Risky signup location",
      description:
        "The signup country is enabled in the managed Risky Locations policy.",
      options: [option(weights, "risky_location", "Matched")],
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
      key: "fingerprint_event_integrity",
      title: "Fingerprint event integrity",
      description:
        "Rejects replayed events and events whose IP or linked account conflicts with the signup evidence.",
      options: [
        option(weights, "fingerprint_event_replayed", "Payload replayed"),
        option(weights, "fingerprint_ip_mismatch", "IP mismatch"),
        option(
          weights,
          "fingerprint_linked_id_mismatch",
          "Linked account mismatch",
        ),
      ],
    },
    {
      key: "fingerprint_low_confidence",
      title: "Low identification confidence",
      description:
        "Fingerprint is less than 90% confident in the visitor identification.",
      options: [
        option(weights, "fingerprint_low_confidence", "Below 90%"),
      ],
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
      description:
        "Fingerprint detected VPN use. Low and medium confidence results receive a reduced share of this maximum.",
      options: [option(weights, "fingerprint_vpn", "High-confidence maximum")],
    },
    {
      key: "fingerprint_proxy",
      title: "Proxy detected",
      description:
        "Fingerprint detected a residential or datacenter proxy. Low and medium confidence results receive a reduced share of this maximum.",
      options: [
        option(weights, "fingerprint_proxy", "High-confidence maximum"),
      ],
    },
    {
      key: "fingerprint_tor",
      title: "Tor detected",
      description: "Fingerprint identified a Tor exit node.",
      options: [option(weights, "fingerprint_tor", "Detected")],
    },
    {
      key: "fingerprint_ip_blocklist",
      title: "Malicious IP history",
      description:
        "Fingerprint found the IP in recent network-attack or email-spam intelligence.",
      options: [
        option(
          weights,
          "fingerprint_ip_attack_source",
          "Network attack source",
        ),
        option(weights, "fingerprint_ip_email_spam", "Email spam source"),
      ],
    },
    {
      key: "fingerprint_datacenter",
      title: "Datacenter network",
      description:
        "Fingerprint identified the request IP as hosted in a datacenter rather than a normal access network.",
      options: [option(weights, "fingerprint_datacenter", "Detected")],
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
      description:
        "Fingerprint detected an anti-detect or anomalous browser. Low and medium confidence results receive a reduced share of this maximum.",
      options: [
        option(
          weights,
          "fingerprint_tampering",
          "High-confidence maximum",
        ),
      ],
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
      key: "fingerprint_browser_context",
      title: "Browser concealment and tooling",
      description:
        "Supporting browser evidence. Privacy settings or open developer tools are not treated as fraud on their own.",
      options: [
        option(
          weights,
          "fingerprint_privacy_settings",
          "Privacy-focused settings",
        ),
        option(
          weights,
          "fingerprint_developer_tools",
          "Developer tools or CDP",
        ),
        option(weights, "fingerprint_rare_device", "Rare device"),
      ],
    },
    {
      key: "fingerprint_velocity",
      title: "Fingerprint velocity",
      description:
        "Uses Fingerprint's 5-minute, 1-hour, and 24-hour device, account, country, and IP activity counters.",
      options: [
        option(
          weights,
          "fingerprint_velocity_ip_rotation",
          "Rapid IP rotation",
        ),
        option(
          weights,
          "fingerprint_velocity_country_hop",
          "Rapid country changes",
        ),
        option(
          weights,
          "fingerprint_velocity_multiple_accounts",
          "Multiple linked accounts/devices",
        ),
        option(
          weights,
          "fingerprint_velocity_automation",
          "Automation-like event velocity",
        ),
      ],
    },
    {
      key: "fingerprint_mobile_integrity",
      title: "Mobile device integrity",
      description:
        "Applies when a Fingerprint mobile SDK event is received; browser events do not produce these signals.",
      options: [
        option(weights, "fingerprint_mobile_rooted", "Root apps detected"),
        option(weights, "fingerprint_mobile_emulator", "Emulator detected"),
        option(
          weights,
          "fingerprint_mobile_cloned_app",
          "Cloned app detected",
        ),
        option(
          weights,
          "fingerprint_mobile_jailbroken",
          "Jailbreak detected",
        ),
        option(weights, "fingerprint_mobile_frida", "Frida detected"),
        option(
          weights,
          "fingerprint_mobile_location_spoofing",
          "Location spoofing",
        ),
        option(weights, "fingerprint_mobile_mitm", "MitM detected"),
        option(
          weights,
          "fingerprint_mobile_recent_factory_reset",
          "Factory reset within 30 days",
        ),
      ],
    },
    {
      key: "fingerprint_proximity",
      title: "Coarse proximity evidence",
      description:
        "Stores only a hashed coarse-zone identifier when the user already granted location permission. It does not add risk by default.",
      options: [option(weights, "fingerprint_proximity", "Evidence only")],
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
        "proxycheck.io identifies a proxy, VPN, Tor exit, compromised IP, scraper or hosting network. Current detections score fully at 90% confidence, at 75% weight from 85-89%, and remain evidence-only below 85%.",
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
    {
      key: "abstract_ip_security",
      title: "Abstract IP security",
      description:
        "Independent signup-IP evidence for VPN, proxy, Tor, hosting, relay, and abuse classifications.",
      options: [
        option(weights, "abstract_ip_vpn", "VPN"),
        option(weights, "abstract_ip_proxy", "Proxy"),
        option(weights, "abstract_ip_tor", "Tor"),
        option(weights, "abstract_ip_hosting", "Hosting"),
        option(weights, "abstract_ip_relay", "Relay"),
        option(weights, "abstract_ip_abuse", "Abuse history"),
        option(
          weights,
          "abstract_ip_country_mismatch",
          "Country mismatch",
        ),
      ],
    },
    {
      key: "abstract_email_deliverability",
      title: "Abstract email deliverability",
      description:
        "Mailbox, SMTP, MX, catch-all, disposable, username, quality, domain-age, TLD, and provider-risk checks for new signups.",
      options: [
        option(weights, "abstract_email_catchall", "Catch-all domain"),
        option(weights, "abstract_email_undeliverable", "Undeliverable"),
        option(
          weights,
          "abstract_email_unknown_deliverability",
          "Unknown deliverability",
        ),
        option(weights, "abstract_email_invalid_smtp", "SMTP or MX invalid"),
        option(weights, "abstract_email_disposable", "Disposable"),
        option(
          weights,
          "abstract_email_suspicious_username",
          "Suspicious username",
        ),
        option(weights, "abstract_email_medium_risk", "Medium provider risk"),
        option(weights, "abstract_email_high_risk", "High provider risk"),
        option(weights, "abstract_email_risky_tld", "Risky TLD"),
        option(weights, "abstract_email_low_quality", "Low quality"),
        option(weights, "abstract_email_new_domain", "New domain"),
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
        "A reversible fiat/card deposit by an already-monitored signup raises payment-risk attention. Apple Pay receives 20% less weight.",
      options: [option(weights, "fiat_deposit", "Recorded")],
    },
    {
      key: "paid_pack_opened",
      title: "Paid pack opened",
      description: "Normal paid play during monitoring slightly reduces risk.",
      options: [option(weights, "paid_pack_opened", "Recorded")],
    },
    {
      key: "ledger_battle_bet",
      title: "Battle bet",
      description: "The player pays their own battle entry.",
      options: [option(weights, "ledger_battle_bet", "Recorded")],
    },
    {
      key: "ledger_battle_sponsorship",
      title: "Battle sponsorship funded",
      description: "The player pays to sponsor a battle.",
      options: [option(weights, "ledger_battle_sponsorship", "Recorded")],
    },
    {
      key: "ledger_upgrader_bet",
      title: "Upgrader bet",
      description: "The player places a paid upgrader bet.",
      options: [option(weights, "ledger_upgrader_bet", "Recorded")],
    },
    {
      key: "welcome_reward_opened",
      title: "Welcome reward opened",
      description:
        "The account opens its one-time welcome reward containing three welcome-rewards packs.",
      options: [option(weights, "welcome_reward_opened", "Recorded")],
    },
    {
      key: "level_one_reward_opened",
      title: "Level 1 daily pack opened",
      description:
        "The account opens the level-0-unlocked daily reward named Level 1.",
      options: [option(weights, "level_one_reward_opened", "Recorded")],
    },
    {
      key: "daily_reward_opened",
      title: "Level 10–100 daily pack opened",
      description:
        "The player opens a daily pack that required an earned account level.",
      options: [option(weights, "daily_reward_opened", "Recorded")],
    },
    {
      key: "ledger_deposit_bonus",
      title: "Deposit bonus received",
      description: "A bonus tied to a completed deposit is credited.",
      options: [option(weights, "ledger_deposit_bonus", "Recorded")],
    },
    {
      key: "ledger_rakeback_claim",
      title: "Rakeback claimed",
      description: "The player claims rakeback earned from prior wagering.",
      options: [option(weights, "ledger_rakeback_claim", "Recorded")],
    },
    {
      key: "ledger_rain_win",
      title: "Rain payout received",
      description:
        "A level-gated rain payout is received; this stays neutral because prior tips can also unlock access.",
      options: [option(weights, "ledger_rain_win", "Recorded")],
    },
    {
      key: "ledger_race_prize",
      title: "On-site race prize",
      description: "A wager-based on-site race prize is credited.",
      options: [option(weights, "ledger_race_prize", "Recorded")],
    },
    {
      key: "ledger_affiliate_leaderboard_prize",
      title: "Creator leaderboard prize",
      description: "A creator leaderboard prize is credited.",
      options: [
        option(weights, "ledger_affiliate_leaderboard_prize", "Recorded"),
      ],
    },
    {
      key: "ledger_challenge_prize",
      title: "Challenge prize",
      description: "A pack-opening or upgrader challenge prize is credited.",
      options: [option(weights, "ledger_challenge_prize", "Recorded")],
    },
    {
      key: "ledger_creator_tip",
      title: "Creator tip received",
      description:
        "A tip is received; the no-deposit behavior flow decides whether it is suspicious.",
      options: [option(weights, "ledger_creator_tip", "Recorded")],
    },
    {
      key: "creator_sponsored_battle_received",
      title: "Sponsored battle received",
      description:
        "The account joins a sponsored battle; the no-deposit behavior flow decides whether it is suspicious.",
      options: [
        option(weights, "creator_sponsored_battle_received", "Recorded"),
      ],
    },
    {
      key: "session_hopping",
      title: "Session hopping",
      description:
        "Several device signatures plus exact IP or country changes occur within 30 minutes.",
      options: [option(weights, "session_hopping", "Recorded")],
    },
    {
      key: "dormant_device_switch",
      title: "Dormant activation on new device",
      description:
        "An account returns after at least 30 inactive days on a different device signature.",
      options: [option(weights, "dormant_device_switch", "Recorded")],
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
          paid_pack_opened: true,
          ledger_battle_bet: true,
          ledger_battle_sponsorship: true,
          ledger_upgrader_bet: true,
          welcome_reward_opened: true,
          level_one_reward_opened: true,
          daily_reward_opened: true,
          ledger_deposit_bonus: true,
          ledger_rakeback_claim: true,
          ledger_rain_win: true,
          ledger_race_prize: true,
          ledger_affiliate_leaderboard_prize: true,
          ledger_challenge_prize: true,
          ledger_creator_tip: true,
          creator_sponsored_battle_received: true,
          session_hopping: true,
          dormant_device_switch: true,
        },
        eventType,
      )
    ? weights[eventType]
    : 0;
}
