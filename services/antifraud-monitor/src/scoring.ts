import type { Signal, Signup } from "./types.js";

export type SignupContext = {
  sameIp10m: number;
  sameIp30m: number;
  sameIpv6Subnet30m: number;
  sameDeviceAllTime: number;
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

export function baseSignupSignals(
  signup: Signup,
  context: SignupContext,
): Signal[] {
  const signals: Signal[] = [];
  const add = (hit: boolean, signal: Signal) => {
    if (hit) signals.push(signal);
  };

  add(context.sameDeviceAllTime >= 2, {
    key: "shared_device",
    title: "Shared device",
    detail: `${context.sameDeviceAllTime} accounts share this Fingerprint visitor ID.`,
    points: context.sameDeviceAllTime >= 3 ? 95 : 70,
  });
  add(context.sameIp10m >= 3, {
    key: "ip_velocity_10m",
    title: "Signup IP velocity",
    detail: `${context.sameIp10m} accounts used this IP within 10 minutes.`,
    points: 50,
  });
  add(context.sameIp30m >= 5, {
    key: "ip_velocity_30m",
    title: "Sustained signup IP velocity",
    detail: `${context.sameIp30m} accounts used this IP within 30 minutes.`,
    points: 80,
  });
  add(context.sameIpv6Subnet30m >= 3, {
    key: "ipv6_subnet_velocity",
    title: "IPv6 household velocity",
    detail: `${context.sameIpv6Subnet30m} accounts share an IPv6 /64 within 30 minutes.`,
    points: 40,
  });
  add(signup.is_suspected_alt && context.sameDeviceAllTime < 2, {
    key: "existing_alt_flag",
    title: "Existing alt-account flag",
    detail: "Packy already marked this account as a suspected alternate account.",
    points: 45,
  });
  add(generatedLooking(signup.username), {
    key: "generated_username",
    title: "Generated-looking username",
    detail: "The signup username resembles machine-generated account data.",
    points: 15,
  });
  add(!signup.email, {
    key: "missing_email",
    title: "Missing email",
    detail: "The account has no email address.",
    points: 5,
  });

  return signals;
}

export function severity(score: number): "low" | "medium" | "high" | "critical" {
  if (score >= 120) return "critical";
  if (score >= 80) return "high";
  if (score >= 40) return "medium";
  return "low";
}
