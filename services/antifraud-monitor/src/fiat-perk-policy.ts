import {
  badDeviceReputation,
  badIpReputation,
} from "./fiat-eligibility-policy.js";
import type { EnrichmentResult } from "./enrichment.js";

/**
 * Fiat perk screening policy — "should this ACCOUNT be allowed to reach a card
 * checkout at all", evaluated once against everything we already know, not per
 * checkout.
 *
 * Deliberately a different question from `fiat-eligibility-policy.ts`. That one
 * runs inside a live checkout with a fresh Fingerprint event and has 60 seconds
 * of validity; this one runs in a batch sweep, judges the account's history and
 * standing, and its output is a durable allowlist entry a human confirms.
 *
 * Pure and deterministic: same evidence in, same verdict out. Every rule states
 * its own evidence so the reviewer sees WHY, not just a number.
 */

export const DEFAULT_MIN_ACCOUNT_AGE_DAYS = 14;

/** Other accounts on the same signup IP before it stops being a coincidence. */
const SHARED_IP_WARN_USERS = 3;
const SHARED_IP_FAIL_USERS = 10;

/** Reward value an unfunded account can hold before it reads as farming. */
const FARMED_REWARD_FAIL_USD = 25;
const RAIN_FARM_WIN_COUNT = 10;

/** Signup assessment score bands inherited from the signup engine. */
const SIGNUP_RISK_WARN = 25;
const SIGNUP_RISK_FAIL = 60;

export type FiatPerkCheckStatus = "pass" | "warn" | "fail";

export type FiatPerkCheckCategory =
  | "account"
  | "blacklist"
  | "network"
  | "device"
  | "behaviour"
  | "history"
  | "maxmind";

export type FiatPerkCheck = {
  key: string;
  label: string;
  category: FiatPerkCheckCategory;
  status: FiatPerkCheckStatus;
  detail: string;
  points: number;
};

export type FiatPerkVerdict = "pass" | "review" | "fail";

export type FiatPerkSubject = {
  id: string;
  username: string | null;
  email: string | null;
  countryCode: string | null;
  createdAt: Date;
  isBanned: boolean;
  isLocked: boolean;
  isSelfExcluded: boolean;
  isSuspectedAlt: boolean;
  fiatLocked: boolean;
  withdrawalsLocked: boolean;
  lockReason: string | null;
  countryBlocked: boolean;
  countryFiatLocked: boolean;
  kycRequired: boolean;
  kycStatus: string;
  kycAdminDecision: string;
};

export type FiatPerkBehaviour = {
  cryptoDeposits: number;
  cryptoDepositUsd: number;
  fiatDeposits: number;
  fiatDepositUsd: number;
  disputedFiat: number;
  refundedFiat: number;
  wagerUsd: number;
  gameEvents: number;
  rewardUsd: number;
  rainWins: number;
  withdrawalRequests: number;
  withdrawalUsd: number;
};

export type FiatPerkNetwork = {
  sharedDeviceUsers: number;
  sharedSignupIpUsers: number;
  signupIp: string | null;
  visitorId: string | null;
};

export type FiatPerkBlocklistHit = {
  kind: "ip" | "fingerprint" | "email_domain";
  value: string;
  reason: string;
};

export type FiatPerkHistory = {
  signupRiskScore: number;
  openCaseSeverity: string | null;
};

export type FiatPerkPolicyInput = {
  now: Date;
  minAccountAgeDays: number;
  subject: FiatPerkSubject;
  behaviour: FiatPerkBehaviour;
  network: FiatPerkNetwork;
  blocklistHits: readonly FiatPerkBlocklistHit[];
  history: FiatPerkHistory;
  /**
   * Live provider answers for the account's most recent known IP and device.
   * Empty when the account failed a cheap check first — screening never spends
   * a provider call on an account it has already rejected.
   */
  providers: readonly EnrichmentResult[];
  providersChecked: boolean;
};

export type FiatPerkEvaluation = {
  verdict: FiatPerkVerdict;
  riskScore: number;
  checks: FiatPerkCheck[];
  blockingReasons: string[];
};

export type FiatPerkMaxMindReason = {
  code: string;
  reason: string | null;
  multiplier: number | null;
};

export type FiatPerkMaxMindEvidence = {
  status: "success" | "failed" | "skipped" | "not_checked";
  riskScore: number | null;
  ipRisk: number | null;
  disposition: string | null;
  reasons: FiatPerkMaxMindReason[];
  factors: Record<string, number>;
  warnings: string[];
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Normalise the additive MaxMind response into stable, filterable evidence. */
export function perkMaxMindEvidence(
  providers: readonly EnrichmentResult[],
): FiatPerkMaxMindEvidence {
  const provider = providers.find((entry) => entry.provider === "maxmind");
  if (!provider) {
    return {
      status: "not_checked",
      riskScore: null,
      ipRisk: null,
      disposition: null,
      reasons: [],
      factors: {},
      warnings: [],
    };
  }
  const response = record(provider.response);
  const ip = record(response.ip_address);
  const disposition = record(response.disposition);
  const subscores = record(response.subscores);
  const factors = Object.fromEntries(
    Object.entries(subscores)
      .map(([key, value]) => [key, finiteNumber(value)] as const)
      .filter((entry): entry is readonly [string, number] => entry[1] !== null),
  );
  const reasons = (Array.isArray(response.risk_score_reasons)
    ? response.risk_score_reasons
    : []).flatMap((group) => {
      const node = record(group);
      const multiplier = finiteNumber(node.multiplier);
      return (Array.isArray(node.reasons) ? node.reasons : [])
        .map((reason) => {
          const value = record(reason);
          const code = text(value.code);
          return code
            ? { code, reason: text(value.reason), multiplier }
            : null;
        })
        .filter((reason): reason is FiatPerkMaxMindReason => reason !== null);
    }).slice(0, 50);
  const warnings = (Array.isArray(response.warnings) ? response.warnings : [])
    .map((warning) => text(record(warning).code))
    .filter((warning): warning is string => warning !== null)
    .slice(0, 25);
  return {
    status: provider.status,
    riskScore: provider.nativeScore ?? provider.score ?? finiteNumber(response.risk_score),
    ipRisk: finiteNumber(ip.risk),
    disposition: text(disposition.action),
    reasons,
    factors,
    warnings,
  };
}

export function perkAccountAgeDays(createdAt: Date, now: Date): number {
  const age = (now.getTime() - createdAt.getTime()) / 86_400_000;
  return Number.isFinite(age) ? Math.max(0, age) : 0;
}

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

/**
 * Cheap checks only — everything answerable from the databases we already
 * queried. Screening runs these first and only pays for provider calls on the
 * accounts that survive, so a sweep over a large scope stays affordable.
 */
export function evaluatePerkDataChecks(
  input: Omit<FiatPerkPolicyInput, "providers" | "providersChecked">,
): FiatPerkCheck[] {
  const checks: FiatPerkCheck[] = [];
  const { subject, behaviour, network, history } = input;
  const ageDays = perkAccountAgeDays(subject.createdAt, input.now);
  const fundedUsd = behaviour.cryptoDepositUsd + behaviour.fiatDepositUsd;

  const add = (check: FiatPerkCheck): void => {
    checks.push(check);
  };

  // ── Account standing ───────────────────────────────────────────────────────
  const restricted = subject.isBanned || subject.isLocked
    || subject.isSelfExcluded;
  add({
    key: "account_standing",
    label: "Account standing",
    category: "account",
    status: restricted ? "fail" : "pass",
    detail: restricted
      ? `The account is ${[
        subject.isBanned ? "banned" : null,
        subject.isLocked ? "locked" : null,
        subject.isSelfExcluded ? "self-excluded" : null,
      ].filter(Boolean).join(", ")}.`
      : "The account is not banned, locked or self-excluded.",
    points: restricted ? 100 : 0,
  });

  add({
    key: "suspected_alt",
    label: "Alternate account",
    category: "account",
    status: subject.isSuspectedAlt ? "fail" : "pass",
    detail: subject.isSuspectedAlt
      ? "The account is already marked as a suspected alt."
      : "The account is not marked as a suspected alt.",
    points: subject.isSuspectedAlt ? 100 : 0,
  });

  const oldEnough = ageDays >= input.minAccountAgeDays;
  add({
    key: "account_age",
    label: "Account age",
    category: "account",
    status: oldEnough ? "pass" : "fail",
    detail: `The account is ${ageDays.toFixed(1)} days old; the scope requires `
      + `${input.minAccountAgeDays}.`,
    points: oldEnough ? 0 : 100,
  });

  const countryRestricted = subject.countryBlocked || subject.countryFiatLocked;
  add({
    key: "country_policy",
    label: "Country policy",
    category: "account",
    status: countryRestricted ? "fail" : "pass",
    detail: countryRestricted
      ? `Fiat is unavailable for ${subject.countryCode ?? "the account country"}.`
      : `Fiat is available for ${subject.countryCode ?? "the account country"}.`,
    points: countryRestricted ? 100 : 0,
  });

  const kycRejected = subject.kycStatus === "rejected"
    || subject.kycAdminDecision === "rejected";
  const kycIncomplete = subject.kycRequired && subject.kycStatus !== "approved";
  add({
    key: "kyc",
    label: "Identity verification",
    category: "account",
    status: kycRejected || kycIncomplete ? "fail" : "pass",
    detail: kycRejected
      ? "The account's KYC record is rejected."
      : kycIncomplete
        ? "KYC is required for this account and is not approved."
        : subject.kycStatus === "approved"
          ? "KYC is approved."
          : "KYC is not required for this account.",
    points: kycRejected ? 100 : kycIncomplete ? 100 : 0,
  });

  // An existing fraud lock is the backend's own verdict after a refund or a
  // chargeback. Screening never overrides it — staff clear it on the user page.
  const locked = subject.fiatLocked || subject.withdrawalsLocked;
  add({
    key: "existing_fraud_lock",
    label: "Existing fraud lock",
    category: "account",
    status: locked ? "fail" : "pass",
    detail: locked
      ? `The account carries a fraud lock${
        subject.lockReason ? `: ${subject.lockReason}` : "."
      }`
      : "No deposit or withdrawal fraud lock is set.",
    points: locked ? 100 : 0,
  });

  // ── Blacklists ─────────────────────────────────────────────────────────────
  for (const kind of ["email_domain", "ip", "fingerprint"] as const) {
    const hits = input.blocklistHits.filter((hit) => hit.kind === kind);
    const label = kind === "email_domain"
      ? "Email domain blacklist"
      : kind === "ip"
        ? "IP blacklist"
        : "Fingerprint blacklist";
    add({
      key: `blacklist_${kind}`,
      label,
      category: "blacklist",
      status: hits.length > 0 ? "fail" : "pass",
      detail: hits.length > 0
        ? `${hits.map((hit) => hit.value).join(", ")} — ${
          hits[0]?.reason ?? "blacklisted"
        }`
        : "No active blacklist rule matches this account.",
      points: hits.length > 0 ? 100 : 0,
    });
  }

  // ── Shared identity ────────────────────────────────────────────────────────
  add({
    key: "shared_device",
    label: "Device sharing",
    category: "device",
    status: network.sharedDeviceUsers > 0 ? "fail" : "pass",
    detail: network.sharedDeviceUsers > 0
      ? `${network.sharedDeviceUsers} other account(s) used the same device.`
      : network.visitorId
        ? "The account's device is not shared with another account."
        : "No device identity is stored for this account.",
    points: network.sharedDeviceUsers > 0 ? 100 : 0,
  });

  const sharedIpStatus: FiatPerkCheckStatus =
    network.sharedSignupIpUsers >= SHARED_IP_FAIL_USERS
      ? "fail"
      : network.sharedSignupIpUsers >= SHARED_IP_WARN_USERS
        ? "warn"
        : "pass";
  add({
    key: "shared_signup_ip",
    label: "IP sharing",
    category: "network",
    status: sharedIpStatus,
    detail: network.sharedSignupIpUsers > 0
      ? `${network.sharedSignupIpUsers} other account(s) signed up from the same IP.`
      : "The signup IP is not shared with another account.",
    points: sharedIpStatus === "fail" ? 100 : sharedIpStatus === "warn" ? 25 : 0,
  });

  // ── Money movement ─────────────────────────────────────────────────────────
  const priorBadPayments = behaviour.disputedFiat + behaviour.refundedFiat;
  add({
    key: "payment_history",
    label: "Card payment history",
    category: "history",
    status: priorBadPayments > 0 ? "fail" : "pass",
    detail: priorBadPayments > 0
      ? `${behaviour.disputedFiat} disputed and ${behaviour.refundedFiat} `
        + "refunded card deposit(s) are on record."
      : behaviour.fiatDeposits > 0
        ? `${behaviour.fiatDeposits} clean card deposit(s) worth `
          + `${usd(behaviour.fiatDepositUsd)}.`
        : "The account has never completed a card deposit.",
    points: priorBadPayments > 0 ? 100 : 0,
  });

  add({
    key: "funding_history",
    label: "Funding history",
    category: "history",
    status: "pass",
    detail: fundedUsd > 0
      ? `${behaviour.cryptoDeposits} crypto and ${behaviour.fiatDeposits} card `
        + `deposit(s) worth ${usd(fundedUsd)}.`
      : "The account has never funded itself.",
    points: 0,
  });

  // Reward-only accounts: every dollar came from rain, promos and claims, never
  // from the account's own money. That is the farm-then-cash-out shape, and it
  // is exactly what a card must not reach.
  const farmedFail = fundedUsd <= 0
    && behaviour.rewardUsd >= FARMED_REWARD_FAIL_USD;
  const farmedWarn = fundedUsd <= 0 && behaviour.rewardUsd > 0;
  add({
    key: "reward_farming",
    label: "Reward farming",
    category: "behaviour",
    status: farmedFail ? "fail" : farmedWarn ? "warn" : "pass",
    detail: fundedUsd <= 0 && behaviour.rewardUsd > 0
      ? `The account collected ${usd(behaviour.rewardUsd)} in rewards across `
        + `${behaviour.rainWins} rain win(s) without ever funding itself.`
      : "The account's value did not come from rewards alone.",
    points: farmedFail ? 100 : farmedWarn ? 30 : 0,
  });

  const rainFarming = fundedUsd <= 0
    && behaviour.rainWins >= RAIN_FARM_WIN_COUNT
    && behaviour.wagerUsd < behaviour.rewardUsd;
  add({
    key: "rain_extraction",
    label: "Rain extraction",
    category: "behaviour",
    status: rainFarming ? "fail" : "pass",
    detail: rainFarming
      ? `${behaviour.rainWins} rain wins with only ${usd(behaviour.wagerUsd)} `
        + "wagered and no deposit."
      : `${behaviour.rainWins} rain win(s) against ${usd(behaviour.wagerUsd)} wagered.`,
    points: rainFarming ? 100 : 0,
  });

  const cashOutWithoutFunding = fundedUsd <= 0
    && behaviour.withdrawalRequests > 0;
  add({
    key: "cashout_without_funding",
    label: "Cash-out without funding",
    category: "behaviour",
    status: cashOutWithoutFunding ? "fail" : "pass",
    detail: cashOutWithoutFunding
      ? `${behaviour.withdrawalRequests} withdrawal request(s) worth `
        + `${usd(behaviour.withdrawalUsd)} without a single deposit.`
      : "No withdrawals were requested without funding.",
    points: cashOutWithoutFunding ? 100 : 0,
  });

  add({
    key: "play_history",
    label: "Play history",
    category: "behaviour",
    status: behaviour.gameEvents === 0 ? "warn" : "pass",
    detail: behaviour.gameEvents === 0
      ? "The account has never played a paid game, so there is no behaviour to judge."
      : `${behaviour.gameEvents} paid game events and ${usd(behaviour.wagerUsd)} wagered.`,
    points: behaviour.gameEvents === 0 ? 15 : 0,
  });

  // ── Fraud history ──────────────────────────────────────────────────────────
  const severeCase = history.openCaseSeverity === "high"
    || history.openCaseSeverity === "critical";
  add({
    key: "open_case",
    label: "Open fraud case",
    category: "history",
    status: severeCase
      ? "fail"
      : history.openCaseSeverity
        ? "warn"
        : "pass",
    detail: history.openCaseSeverity
      ? `An open ${history.openCaseSeverity} fraud case exists for this account.`
      : "No open fraud case exists for this account.",
    points: severeCase ? 100 : history.openCaseSeverity ? 20 : 0,
  });

  const signupRiskStatus: FiatPerkCheckStatus =
    history.signupRiskScore >= SIGNUP_RISK_FAIL
      ? "fail"
      : history.signupRiskScore >= SIGNUP_RISK_WARN
        ? "warn"
        : "pass";
  add({
    key: "signup_risk",
    label: "Signup risk score",
    category: "history",
    status: signupRiskStatus,
    detail: `The signup assessment scored ${history.signupRiskScore}/100.`,
    points: signupRiskStatus === "fail"
      ? 100
      : signupRiskStatus === "warn"
        ? 20
        : 0,
  });

  return checks;
}

/**
 * Live IP and device opinions for the account. Only ever called for accounts
 * that already cleared `evaluatePerkDataChecks`.
 */
export function evaluatePerkProviderChecks(
  providers: readonly EnrichmentResult[],
): FiatPerkCheck[] {
  const byName = new Map(
    providers.map((provider) => [provider.provider, provider]),
  );
  const fingerprint = byName.get("fingerprint");
  const proxycheck = byName.get("proxycheck");
  const badIp = badIpReputation(providers);
  const badDevice = badDeviceReputation(providers);
  const checks: FiatPerkCheck[] = [];

  // An unanswered provider is not a pass. Screening grants standing access, so
  // "we could not verify" holds the account for a human instead of clearing it.
  const ipAnswered = proxycheck?.status === "success";
  checks.push({
    key: "provider_ip_reputation",
    label: "IP reputation",
    category: "network",
    status: !ipAnswered ? "warn" : badIp ? "fail" : "pass",
    detail: !ipAnswered
      ? `The independent IP check did not answer (${
        proxycheck?.errorCode ?? "not run"
      }).`
      : badIp
        ? "The account's last known IP is flagged as proxy, VPN, hosting or abusive."
        : "The account's last known IP carries no anonymising or abuse signal.",
    points: !ipAnswered ? 20 : badIp ? 100 : 0,
  });

  const deviceAnswered = fingerprint?.status === "success";
  checks.push({
    key: "provider_device_reputation",
    label: "Device reputation",
    category: "device",
    status: !deviceAnswered ? "warn" : badDevice ? "fail" : "pass",
    detail: !deviceAnswered
      ? `The Fingerprint event check did not answer (${
        fingerprint?.errorCode ?? "not run"
      }).`
      : badDevice
        ? "The account's device shows tampering, emulation or bot signals."
        : "The account's device carries no tampering or automation signal.",
    points: !deviceAnswered ? 20 : badDevice ? 100 : 0,
  });

  for (const name of ["abstract_ip", "opportify"] as const) {
    const provider = byName.get(name);
    if (!provider || provider.status === "skipped") continue;
    const failed = provider.status === "failed";
    checks.push({
      key: `provider_${name}`,
      label: name === "abstract_ip" ? "Abstract IP" : "Opportify",
      category: "network",
      status: failed ? "warn" : "pass",
      detail: failed
        ? `The corroborating ${name} check did not answer.`
        : `The corroborating ${name} check answered with score ${
          provider.score ?? 0
        }.`,
      points: failed ? 10 : 0,
    });
  }

  const maxmind = perkMaxMindEvidence(providers);
  const maxMindStatus: FiatPerkCheckStatus = maxmind.status !== "success"
    ? "warn"
    : (maxmind.riskScore ?? 0) >= 75
      ? "fail"
      : (maxmind.riskScore ?? 0) >= 25
        ? "warn"
        : "pass";
  checks.push({
    key: "maxmind_risk",
    label: "MaxMind overall risk",
    category: "maxmind",
    status: maxMindStatus,
    detail: maxmind.status !== "success"
      ? `MaxMind Factors did not answer (${byName.get("maxmind")?.errorCode ?? "not run"}).`
      : `MaxMind Factors scored this identity ${maxmind.riskScore?.toFixed(2) ?? "unknown"}/100${
        maxmind.reasons.length > 0
          ? ` with ${maxmind.reasons.length} material reason(s)`
          : ""
      }.`,
    points: maxMindStatus === "fail" ? 100 : maxMindStatus === "warn" ? 25 : 0,
  });

  if (maxmind.status === "success" && maxmind.ipRisk !== null) {
    const status: FiatPerkCheckStatus = maxmind.ipRisk >= 75
      ? "fail"
      : maxmind.ipRisk >= 25
        ? "warn"
        : "pass";
    checks.push({
      key: "maxmind_ip_risk",
      label: "MaxMind IP risk",
      category: "maxmind",
      status,
      detail: `MaxMind scored the last known IP ${maxmind.ipRisk.toFixed(2)}/100.`,
      points: status === "fail" ? 100 : status === "warn" ? 20 : 0,
    });
  }

  if (maxmind.status === "success" && maxmind.disposition) {
    const status: FiatPerkCheckStatus = maxmind.disposition === "reject"
      ? "fail"
      : maxmind.disposition === "manual_review"
        ? "warn"
        : "pass";
    checks.push({
      key: "maxmind_disposition",
      label: "MaxMind rule disposition",
      category: "maxmind",
      status,
      detail: `The configured MaxMind rule action is ${maxmind.disposition}.`,
      points: status === "fail" ? 100 : status === "warn" ? 25 : 0,
    });
  }

  return checks;
}

export function summarisePerkChecks(
  checks: readonly FiatPerkCheck[],
): FiatPerkEvaluation {
  const failed = checks.filter((check) => check.status === "fail");
  const warned = checks.filter((check) => check.status === "warn");
  const riskScore = Math.max(
    0,
    Math.min(
      100,
      Math.round(checks.reduce((total, check) => total + check.points, 0)),
    ),
  );
  return {
    verdict: failed.length > 0 ? "fail" : warned.length > 0 ? "review" : "pass",
    riskScore,
    checks: [...checks],
    blockingReasons: failed.map((check) => check.key),
  };
}

/** Whole-account verdict from every piece of evidence. */
export function evaluateFiatPerkCandidate(
  input: FiatPerkPolicyInput,
): FiatPerkEvaluation {
  const checks = evaluatePerkDataChecks(input);
  if (input.providersChecked) {
    checks.push(...evaluatePerkProviderChecks(input.providers));
  }
  return summarisePerkChecks(checks);
}
