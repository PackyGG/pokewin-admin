import {
  extractDomain,
  isDisposableEmail,
} from "@visulima/disposable-email-domains";

import { discordAccountCreatedAt, signupAuthProvider, type Signal, type Signup } from "./types.js";
import {
  defaultScoreWeights,
  scorePoints,
  SEVERITY_BANDS,
  type ScoreWeights,
} from "./score-catalog.js";

export type SignupContext = {
  sameIp10m: number;
  sameIp30m: number;
  sameExactIp30d: number;
  sameIpv6Subnet30m: number;
  sameDeviceAllTime: number;
  sameDevice30d: number;
  sameDeviceDistinctIps30d: number;
  sameAffiliate30m: number;
  sameAffiliateIp30m: number;
  sameCountry15m: number;
  sameCountry2m: number;
  sameCountryNetwork2m: number;
  generatedSameCountry2m: number;
};

export function clampRiskScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function generatedLookingUsername(value: string | null): boolean {
  if (!value) return false;
  const text = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (text.length < 8) return false;
  const digits = (text.match(/\d/g) ?? []).length;
  const letters = text.replace(/[^a-z]/g, "");
  const vowels = (letters.match(/[aeiou]/g) ?? []).length;
  const consonantRatio =
    letters.length >= 6 ? (letters.length - vowels) / letters.length : 0;
  return (
    (digits >= 4 && text.length >= 10) ||
    consonantRatio >= 0.84 ||
    /^[a-f0-9]{12,}$/.test(text)
  );
}

export function disposableEmailDomain(value: string | null): string | null {
  if (!value || !isDisposableEmail(value)) return null;
  return extractDomain(value) ?? null;
}

export function baseSignupSignals(
  signup: Signup,
  context: SignupContext,
  weights: ScoreWeights = defaultScoreWeights(),
): Signal[] {
  const SCORE_POINTS = scorePoints(weights);
  const signals: Signal[] = [];
  const add = (hit: boolean, signal: Signal) => {
    if (hit) signals.push(signal);
  };

  add(context.sameDeviceAllTime >= 2, {
    key: "shared_device",
    title: "Shared device",
    detail: `${context.sameDeviceAllTime} accounts share this Fingerprint visitor ID.`,
    points:
      context.sameDeviceAllTime >= 25
        ? SCORE_POINTS.sharedDevice.twentyFivePlusAccounts
        : context.sameDeviceAllTime >= 10
          ? SCORE_POINTS.sharedDevice.tenPlusAccounts
          : context.sameDeviceAllTime >= 3
            ? SCORE_POINTS.sharedDevice.threePlusAccounts
            : SCORE_POINTS.sharedDevice.twoAccounts,
  });
  add(context.sameDevice30d >= 3, {
    key: "fingerprint_third_account_30d",
    title: "Third account on exact fingerprint",
    detail: `${context.sameDevice30d} accounts used this exact high-confidence fingerprint within 30 days.`,
    points: 100,
    payload: {
      accountCount: context.sameDevice30d,
      distinctIpCount: context.sameDeviceDistinctIps30d,
      windowDays: 30,
      containmentRequired: true,
    },
  });
  add(context.sameDevice30d < 3 && context.sameDeviceDistinctIps30d >= 3, {
    key: "fingerprint_changing_ip_30d",
    title: "Fingerprint reused across changing IPs",
    detail: `This fingerprint appeared from ${context.sameDeviceDistinctIps30d} exact IPs within 30 days.`,
    points: 50,
    payload: {
      accountCount: context.sameDevice30d,
      distinctIpCount: context.sameDeviceDistinctIps30d,
      windowDays: 30,
    },
  });
  add(context.sameExactIp30d >= 3, {
    key: "exact_ip_third_account_30d",
    title: "Third account on exact IP",
    detail: `${context.sameExactIp30d} accounts signed up from this exact IPv4 or IPv6 address within 30 days.`,
    points: 100,
    payload: {
      accountCount: context.sameExactIp30d,
      windowDays: 30,
      containmentRequired: true,
    },
  });
  add(context.sameIp10m >= 3, {
    key: "ip_velocity_10m",
    title: "Signup IP velocity",
    detail: `${context.sameIp10m} accounts used this IP within 10 minutes.`,
    points: SCORE_POINTS.ipVelocity10m,
  });
  add(context.sameIp30m >= 5, {
    key: "ip_velocity_30m",
    title: "Sustained signup IP velocity",
    detail: `${context.sameIp30m} accounts used this IP within 30 minutes.`,
    points:
      context.sameIp30m >= 25
        ? SCORE_POINTS.ipVelocity30m.twentyFivePlus
        : context.sameIp30m >= 10
          ? SCORE_POINTS.ipVelocity30m.tenPlus
          : SCORE_POINTS.ipVelocity30m.fivePlus,
  });
  add(context.sameIpv6Subnet30m >= 3, {
    key: "ipv6_subnet_velocity",
    title: "IPv6 household velocity",
    detail: `${context.sameIpv6Subnet30m} accounts share an IPv6 /64 within 30 minutes.`,
    points: SCORE_POINTS.ipv6SubnetVelocity,
  });
  add(signup.is_suspected_alt && context.sameDeviceAllTime < 2, {
    key: "existing_alt_flag",
    title: "Existing alt-account flag",
    detail: "Packy already marked this account as a suspected alternate account.",
    points: SCORE_POINTS.existingAltFlag,
  });
  const generatedUsername = generatedLookingUsername(signup.username);
  add(generatedUsername, {
    key: "generated_username",
    title: "Generated-looking username",
    detail: "The signup username resembles machine-generated account data.",
    points: SCORE_POINTS.generatedUsername,
  });
  if (signupAuthProvider(signup.auth_provider) === "discord") {
    const createdAt = discordAccountCreatedAt(signup.auth_account_id);
    const ageMs = createdAt
      ? signup.created_at.getTime() - createdAt.getTime()
      : Number.NaN;
    const ageDays = ageMs / 86_400_000;
    const validAge = Number.isFinite(ageDays) && ageDays >= 0;
    add(validAge && ageDays < 90, {
      key: "discord_account_age",
      title: "New Discord identity",
      detail: `The linked Discord account was created ${Math.max(0, Math.floor(ageDays))} days before signup.`,
      points:
        ageDays < 7
          ? SCORE_POINTS.discordAccountAge.under7d
          : ageDays < 30
            ? SCORE_POINTS.discordAccountAge.under30d
            : SCORE_POINTS.discordAccountAge.under90d,
      payload: {
        ageDays: Math.max(0, Math.floor(ageDays)),
        createdAt: createdAt?.toISOString(),
      },
    });
  }
  const disposableDomain = disposableEmailDomain(signup.email);
  add(disposableDomain !== null, {
    key: "disposable_email",
    title: "Disposable email",
    detail: `The signup uses the temporary email domain ${disposableDomain ?? "unknown"}.`,
    points: SCORE_POINTS.disposableEmail,
    payload: disposableDomain ? { domain: disposableDomain } : undefined,
  });
  add(context.sameAffiliateIp30m >= 3, {
    key: "affiliate_ip_chain",
    title: "Affiliate and IP chain",
    detail:
      `${context.sameAffiliateIp30m} accounts share this affiliate code and signup IP within 30 minutes.`,
    points:
      context.sameAffiliateIp30m >= 10
        ? SCORE_POINTS.affiliateIpChain.tenPlus
        : SCORE_POINTS.affiliateIpChain.threePlus,
    payload: {
      count: context.sameAffiliateIp30m,
      affiliateCode: signup.affiliate_code,
    },
  });
  add(context.sameAffiliate30m >= 3, {
    key: "affiliate_cluster",
    title: "Affiliate signup cluster",
    detail:
      `${context.sameAffiliate30m} accounts used this affiliate code within 30 minutes.`,
    points:
      context.sameAffiliate30m >= 10
        ? SCORE_POINTS.affiliateCluster.tenPlus
        : SCORE_POINTS.affiliateCluster.threePlus,
    payload: {
      count: context.sameAffiliate30m,
      affiliateCode: signup.affiliate_code,
    },
  });
  add(context.sameCountry15m >= 10, {
    key: "country_cluster",
    title: "Country signup burst",
    detail:
      `${context.sameCountry15m} accounts from ${signup.country_code ?? signup.country ?? "this country"} registered within 15 minutes.`,
    points:
      context.sameCountry15m >= 25
        ? SCORE_POINTS.countryCluster.twentyFivePlus
        : SCORE_POINTS.countryCluster.tenPlus,
    payload: {
      count: context.sameCountry15m,
      countryCode: signup.country_code,
    },
  });
  const networkCampaign = context.sameCountryNetwork2m >= 3;
  const generatedCampaign =
    generatedUsername
    && context.sameCountry2m >= 3
    && context.generatedSameCountry2m >= 2;
  add(networkCampaign || generatedCampaign, {
    key: "signup_campaign_burst",
    title: "Correlated signup campaign",
    detail: networkCampaign
      ? `${context.sameCountryNetwork2m} accounts from the same country and provider network registered within 2 minutes.`
      : `${context.generatedSameCountry2m} generated-looking accounts from the same country registered within 2 minutes.`,
    // Deliberately one bounded signal: network and username corroboration do
    // not stack, and campaign evidence alone can never reach containment.
    points: generatedCampaign
      ? SCORE_POINTS.signupCampaign.generatedCorroborated
      : SCORE_POINTS.signupCampaign.networkBurst,
    payload: {
      windowMinutes: 2,
      countryCode: signup.country_code,
      sameCountryCount: context.sameCountry2m,
      sameNetworkCount: context.sameCountryNetwork2m,
      generatedCount: context.generatedSameCountry2m,
      networkMatched: networkCampaign,
      generatedMatched: generatedCampaign,
    },
  });

  return signals;
}

export function severity(score: number): "low" | "medium" | "high" | "critical" {
  const band = [...SEVERITY_BANDS]
    .reverse()
    .find((candidate) => score >= candidate.minimum);
  return band?.key ?? "low";
}
