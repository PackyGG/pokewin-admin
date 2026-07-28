import {
  extractDomain,
  isDisposableEmail,
} from "@visulima/disposable-email-domains";

import type { Signal, Signup } from "./types.js";
import {
  defaultScoreWeights,
  scorePoints,
  SEVERITY_BANDS,
  type ScoreWeights,
} from "./score-catalog.js";

export type SignupContext = {
  sameIp10m: number;
  sameIp30m: number;
  sameIpv6Subnet30m: number;
  sameDeviceAllTime: number;
  sameAffiliate30m: number;
  sameAffiliateIp30m: number;
  sameCountry15m: number;
};

function generatedLooking(value: string | null): boolean {
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
  add(generatedLooking(signup.username), {
    key: "generated_username",
    title: "Generated-looking username",
    detail: "The signup username resembles machine-generated account data.",
    points: SCORE_POINTS.generatedUsername,
  });
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

  return signals;
}

export function severity(score: number): "low" | "medium" | "high" | "critical" {
  const band = [...SEVERITY_BANDS]
    .reverse()
    .find((candidate) => score >= candidate.minimum);
  return band?.key ?? "low";
}
