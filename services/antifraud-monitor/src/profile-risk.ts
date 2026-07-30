import { isIP } from "node:net";

import type {
  ProviderCompleteness,
  ProviderFailureKind,
} from "./provider-contracts.js";
import type { Signal } from "./types.js";

export const PROFILE_ASSESSMENT_VERSION = "signup-v2";

export type RiskCategory =
  | "identity"
  | "network"
  | "behavior"
  | "funding"
  | "relationship"
  | "provider"
  | "account";

export type ProviderOutcome =
  | "success"
  | "failed"
  | "skipped"
  | "not_applicable"
  | "unknown";

export type ProviderCoverage = {
  provider: string;
  outcome: ProviderOutcome;
  required: boolean;
  completeness?: ProviderCompleteness;
  failureKind?: ProviderFailureKind;
};

export type ProfileSignal = Signal & {
  category: RiskCategory;
  observedAt: Date;
  halfLifeHours?: number;
  hardPolicy?: string;
  evidenceOnly?: boolean;
  creatorExemptible?: boolean;
};

export type ProfileAssessment = {
  version: typeof PROFILE_ASSESSMENT_VERSION;
  rawScore: number;
  score: number;
  severity: "low" | "medium" | "high" | "critical";
  outcome: "clear" | "monitor" | "review_required" | "incomplete";
  completeness: "complete" | "partial" | "unknown";
  confidence: number;
  providerStatus: Record<string, ProviderCoverage>;
  policyMatches: string[];
  recommendedActions: Array<
    | "monitor"
    | "notify_standard"
    | "notify_priority"
    | "review"
    | "lock_withdrawals"
    | "ban"
    | "block_domain"
    | "block_ip"
    | "block_fingerprint"
  >;
  monitorDurationSeconds: number;
  explanation: {
    categoryTotals: Record<RiskCategory, number>;
    positivePoints: number;
    trustCredit: number;
    cappedAt: number;
    notes: string[];
  };
  signals: Array<ProfileSignal & {
    effectivePoints: number;
    suppressedReason?: string;
  }>;
};

const CATEGORY_CAPS: Record<RiskCategory, number> = {
  identity: 100,
  network: 80,
  behavior: 60,
  funding: 80,
  relationship: 100,
  provider: 100,
  account: 100,
};

const HARD_POLICIES: Record<string, string> = {
  abstract_email_catchall: "email.catchall",
  active_email_domain_blocklist: "blocklist.email_domain",
  active_ip_blocklist: "blocklist.ip",
  active_fingerprint_blocklist: "blocklist.fingerprint",
  fingerprint_third_account_30d: "cluster.fingerprint_third_account",
  exact_ip_third_account_30d: "cluster.exact_ip_third_account",
  fresh_account_third_promo_redemption: "promotion.third_redemption",
  fingerprint_tor: "network.tor",
  abstract_ip_tor: "network.tor",
  fingerprint_virtual_machine: "device.confirmed_vm",
  fingerprint_event_replayed: "fingerprint.replayed",
  fingerprint_linked_id_mismatch: "fingerprint.identity_mismatch",
  fingerprint_bad_bot: "fingerprint.automation",
  restricted_downstream_funds_active_use: "funds.restricted_downstream_active_use",
};

const CREATOR_EXEMPTIBLE = new Set([
  "affiliate_cluster",
  "creator_sponsored_funding",
  "creator_sponsored_battle_received",
  "ledger_creator_tip",
]);

export function categoryForSignal(key: string): RiskCategory {
  if (/fingerprint|email|username|alt_flag/.test(key)) return "identity";
  if (/ip|ipv6|proxy|vpn|tor|country|device|network|session_hop/.test(key)) {
    return "network";
  }
  if (/fund|deposit|withdraw|creator_tip|sponsor/.test(key)) return "funding";
  if (/relationship|affiliate|shared_account/.test(key)) return "relationship";
  if (/provider|opportify|abstract/.test(key)) return "provider";
  if (/lock|kyc|ban|restricted/.test(key)) return "account";
  return "behavior";
}

export function normalizeSignupSignals(
  signals: Signal[],
  observedAt: Date,
): ProfileSignal[] {
  return signals.map((signal) => ({
    ...signal,
    category: categoryForSignal(signal.key),
    observedAt,
    hardPolicy: HARD_POLICIES[signal.key],
    creatorExemptible: CREATOR_EXEMPTIBLE.has(signal.key),
  }));
}

function factFamily(key: string): string | null {
  if (/vpn|proxy|tor|anonymous|datacenter|hosting/.test(key)) {
    return "anonymous_network";
  }
  if (/country_mismatch|country_hop/.test(key)) return "geographic_mismatch";
  if (/disposable_email/.test(key)) return "disposable_email";
  if (/bad_bot|automation|anti.?detect/.test(key)) return "automation";
  return null;
}

function decayedPoints(signal: ProfileSignal, assessedAt: Date): number {
  if (!signal.halfLifeHours || signal.halfLifeHours <= 0) return signal.points;
  const ageHours = Math.max(
    0,
    (assessedAt.getTime() - signal.observedAt.getTime()) / 3_600_000,
  );
  return Math.round(signal.points * 2 ** (-ageHours / signal.halfLifeHours));
}

function profileSeverity(score: number): ProfileAssessment["severity"] {
  if (score >= 100) return "critical";
  if (score >= 80) return "high";
  if (score >= 40) return "medium";
  return "low";
}

export function assessProfile(input: {
  signals: ProfileSignal[];
  providers: ProviderCoverage[];
  assessedAt: Date;
  isCreator: boolean;
  oauthSignup: boolean;
  hasFingerprint: boolean;
}): ProfileAssessment {
  const notes: string[] = [];
  const providers = [...input.providers].sort((a, b) =>
    a.provider.localeCompare(b.provider),
  );
  const failedRequired = providers.filter(
    (provider) => provider.required && provider.outcome === "failed",
  );
  const unknownRequired = providers.filter(
    (provider) =>
      provider.required
      && (
        provider.outcome === "unknown"
        || provider.outcome === "skipped"
        || provider.completeness === "partial"
        || provider.completeness === "unknown"
      ),
  );
  const providerStatus = Object.fromEntries(
    providers.map((provider) => [provider.provider, provider]),
  );

  const normalized = [...input.signals];
  if (!input.hasFingerprint) {
    normalized.push({
      key: input.oauthSignup ? "oauth_fingerprint_unknown" : "fingerprint_missing",
      title: input.oauthSignup
        ? "OAuth signup fingerprint unknown"
        : "Missing signup fingerprint",
      detail: input.oauthSignup
        ? "The OAuth flow did not produce the required browser fingerprint; this remains unknown evidence and adds limited risk."
        : "A password or email signup did not produce the required browser fingerprint.",
      points: input.oauthSignup ? 10 : 15,
      category: "identity",
      observedAt: input.assessedAt,
    });
  }

  const categoryTotals: Record<RiskCategory, number> = {
    identity: 0,
    network: 0,
    behavior: 0,
    funding: 0,
    relationship: 0,
    provider: 0,
    account: 0,
  };
  let trustCredit = 0;
  let uncappedPositivePoints = 0;
  const strongestByFact = new Map<string, number>();
  normalized.forEach((signal, index) => {
    const family = factFamily(signal.key);
    if (!family || signal.points <= 0) return;
    const priorIndex = strongestByFact.get(family);
    if (
      priorIndex === undefined
      || normalized[priorIndex]!.points < signal.points
    ) {
      strongestByFact.set(family, index);
    }
  });
  const assessedSignals = normalized.map((signal, index) => {
    let effectivePoints = signal.evidenceOnly
      ? 0
      : decayedPoints(signal, input.assessedAt);
    let suppressedReason: string | undefined;
    const family = factFamily(signal.key);
    if (
      family
      && effectivePoints > 0
      && strongestByFact.get(family) !== index
    ) {
      effectivePoints = 0;
      suppressedReason = `duplicate_fact:${family}`;
    }
    if (input.isCreator && signal.creatorExemptible) {
      effectivePoints = 0;
      suppressedReason = "expected_creator_activity";
    }
    if (effectivePoints < 0) {
      trustCredit += effectivePoints;
    } else {
      uncappedPositivePoints += effectivePoints;
      const remaining =
        CATEGORY_CAPS[signal.category] - categoryTotals[signal.category];
      effectivePoints = Math.max(0, Math.min(effectivePoints, remaining));
      categoryTotals[signal.category] += effectivePoints;
    }
    return { ...signal, effectivePoints, suppressedReason };
  });

  trustCredit = Math.max(-30, trustCredit);
  const positivePoints = Object.values(categoryTotals).reduce(
    (sum, points) => sum + points,
    0,
  );
  const rawScore = uncappedPositivePoints + trustCredit;
  const policyMatches = [
    ...new Set(
      normalized
        .filter(
          (signal) =>
            signal.points > 0
            && signal.hardPolicy
            && !(input.isCreator && signal.creatorExemptible),
        )
        .map((signal) => signal.hardPolicy!),
    ),
  ].sort();
  const cappedScoreBase = positivePoints + trustCredit;
  const score =
    policyMatches.length > 0
      ? 100
      : Math.max(0, Math.min(100, Math.round(cappedScoreBase)));
  let remainingDisplayedRisk = Math.max(0, score - Math.max(-30, trustCredit));
  for (const signal of assessedSignals) {
    if (signal.effectivePoints <= 0) continue;
    const displayed = Math.min(signal.effectivePoints, remainingDisplayedRisk);
    signal.effectivePoints = displayed;
    remainingDisplayedRisk -= displayed;
  }

  if (failedRequired.length > 0) {
    notes.push(
      `Required provider failure: ${failedRequired.map((provider) => provider.provider).join(", ")}.`,
    );
  }
  if (unknownRequired.length > 0) {
    notes.push(
      `Historical provider coverage unknown: ${unknownRequired.map((provider) => provider.provider).join(", ")}.`,
    );
  }
  if (input.oauthSignup && !input.hasFingerprint) {
    notes.push("OAuth fingerprint absence remains unknown and adds limited risk.");
  }
  if (input.isCreator) {
    notes.push("Expected creator funding and affiliate activity is evidence-only.");
  }
  if (rawScore > 100) notes.push("The displayed signup score is capped at 100.");

  const requiredCount = providers.filter((provider) => provider.required).length;
  const successfulRequired = providers.filter(
    (provider) =>
      provider.required
      && provider.outcome === "success"
      && provider.completeness !== "partial"
      && provider.completeness !== "unknown",
  ).length;
  const confidence =
    requiredCount === 0
      ? 0
      : Math.round((successfulRequired / requiredCount) * 100);
  const completeness: ProfileAssessment["completeness"] =
    failedRequired.length > 0
      ? "partial"
      : unknownRequired.length > 0
        ? "unknown"
        : "complete";
  const outcome: ProfileAssessment["outcome"] =
    failedRequired.length > 0 || unknownRequired.length > 0
      ? "incomplete"
      : policyMatches.length > 0 || score >= 50
        ? "review_required"
        : score >= 21
          ? "monitor"
          : "clear";
  const deterministicBan = policyMatches.some((policy) =>
    policy === "email.catchall" || policy === "blocklist.email_domain",
  );
  const priorityLock = policyMatches.some((policy) =>
    [
      "blocklist.ip",
      "blocklist.fingerprint",
      "cluster.fingerprint_third_account",
      "cluster.exact_ip_third_account",
      "promotion.third_redemption",
      "network.tor",
      "device.confirmed_vm",
      "fingerprint.replayed",
      "fingerprint.identity_mismatch",
      "fingerprint.automation",
      "funds.restricted_downstream_active_use",
    ].includes(policy),
  );
  const recommendedActions = new Set<ProfileAssessment["recommendedActions"][number]>();
  let monitorDurationSeconds = 0;
  if (score >= 21) {
    recommendedActions.add("monitor");
    monitorDurationSeconds = score >= 50 ? 900 : 450;
  }
  if (score >= 50) {
    recommendedActions.add("notify_standard");
    recommendedActions.add("review");
  }
  if (score >= 70 || priorityLock || deterministicBan) {
    recommendedActions.delete("notify_standard");
    recommendedActions.add("notify_priority");
    recommendedActions.add("review");
    recommendedActions.add("lock_withdrawals");
    monitorDurationSeconds = Math.max(monitorDurationSeconds, 900);
  }
  if (deterministicBan) {
    recommendedActions.add("ban");
  }
  if (policyMatches.includes("email.catchall")) {
    recommendedActions.add("block_domain");
    recommendedActions.add("block_ip");
    recommendedActions.add("block_fingerprint");
  }

  return {
    version: PROFILE_ASSESSMENT_VERSION,
    rawScore,
    score,
    severity: profileSeverity(score),
    outcome,
    completeness,
    confidence,
    providerStatus,
    policyMatches,
    recommendedActions: [...recommendedActions],
    monitorDurationSeconds,
    explanation: {
      categoryTotals,
      positivePoints,
      trustCredit,
      cappedAt: 100,
      notes,
    },
    signals: assessedSignals,
  };
}

function expandIpv6(value: string): string[] | null {
  const address = value.split("%", 1)[0]?.toLowerCase();
  if (!address || isIP(address) !== 6) return null;
  const [head = "", tail = ""] = address.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const missing = 8 - left.length - right.length;
  return [
    ...left,
    ...Array.from({ length: Math.max(0, missing) }, () => "0"),
    ...right,
  ].map((part) => part.padStart(4, "0"));
}

export function networkClusterKeys(ip: string | null): {
  exact: string | null;
  subnet: string | null;
  evidenceSubnet: string | null;
  baselineSubnet: string | null;
  family: 4 | 6 | null;
} {
  if (!ip) {
    return {
      exact: null,
      subnet: null,
      evidenceSubnet: null,
      baselineSubnet: null,
      family: null,
    };
  }
  const trimmed = ip.trim();
  const family = isIP(trimmed);
  if (family === 4) {
    const octets = trimmed.split(".").map(Number);
    return {
      exact: octets.join("."),
      subnet: `${octets.slice(0, 3).join(".")}.0/24`,
      evidenceSubnet: null,
      baselineSubnet: null,
      family: 4,
    };
  }
  if (family === 6) {
    const groups = expandIpv6(trimmed);
    if (!groups) {
      return {
        exact: null,
        subnet: null,
        evidenceSubnet: null,
        baselineSubnet: null,
        family: null,
      };
    }
    const fifth = Number.parseInt(groups[4]!, 16);
    const subnet56Fifth = (fifth & 0xff00).toString(16).padStart(4, "0");
    return {
      exact: groups.join(":"),
      subnet: `${groups.slice(0, 4).join(":")}::/64`,
      evidenceSubnet: `${[...groups.slice(0, 4), subnet56Fifth].join(":")}::/56`,
      baselineSubnet: `${groups.slice(0, 3).join(":")}::/48`,
      family: 6,
    };
  }
  return {
    exact: null,
    subnet: null,
    evidenceSubnet: null,
    baselineSubnet: null,
    family: null,
  };
}

export function detectSessionHopping(
  events: Array<{
    occurredAt: Date;
    deviceId: string | null;
    ip: string | null;
    countryCode: string | null;
  }>,
  windowMinutes = 30,
): ProfileSignal | null {
  if (events.length < 2) return null;
  const sorted = [...events].sort(
    (left, right) => left.occurredAt.getTime() - right.occurredAt.getTime(),
  );
  const last = sorted.at(-1)!;
  const cutoff = last.occurredAt.getTime() - windowMinutes * 60_000;
  const window = sorted.filter((event) => event.occurredAt.getTime() >= cutoff);
  const devices = new Set(window.map((event) => event.deviceId).filter(Boolean));
  const ips = new Set(
    window
      .map((event) => networkClusterKeys(event.ip).exact)
      .filter(Boolean),
  );
  const countries = new Set(
    window
      .map((event) => event.countryCode?.toUpperCase())
      .filter(Boolean),
  );
  if (devices.size < 3 && ips.size < 4 && countries.size < 2) return null;
  const points = Math.min(
    90,
    20 + Math.max(0, devices.size - 1) * 15
      + Math.max(0, ips.size - 1) * 10
      + Math.max(0, countries.size - 1) * 20,
  );
  return {
    key: "session_hopping",
    title: "Rapid session hopping",
    detail: `${window.length} sessions used ${devices.size} devices, ${ips.size} IPs, and ${countries.size} countries within ${windowMinutes} minutes.`,
    points,
    category: "network",
    observedAt: last.occurredAt,
    halfLifeHours: 24,
    payload: {
      sessionCount: window.length,
      deviceCount: devices.size,
      ipCount: ips.size,
      countryCount: countries.size,
      windowMinutes,
    },
  };
}

export function traceRestrictedFunds(input: {
  rootUserId: string;
  edges: Array<{
    id: string;
    fromUserId: string;
    toUserId: string;
    amountUsd: string;
    occurredAt: Date;
    sourceType: string;
  }>;
  restrictedUserIds: ReadonlySet<string>;
  creatorUserIds?: ReadonlySet<string>;
  maxDepth?: number;
  maxEdges?: number;
}): {
  matched: boolean;
  truncated: boolean;
  paths: Array<{ edgeIds: string[]; originUserId: string; amountUsd: string }>;
} {
  const maxDepth = Math.min(6, Math.max(1, input.maxDepth ?? 4));
  const maxEdges = Math.min(2_000, Math.max(1, input.maxEdges ?? 500));
  const incoming = new Map<string, typeof input.edges>();
  for (const edge of input.edges.slice(0, maxEdges)) {
    const rows = incoming.get(edge.toUserId) ?? [];
    rows.push(edge);
    incoming.set(edge.toUserId, rows);
  }
  const paths: Array<{
    edgeIds: string[];
    originUserId: string;
    amountUsd: string;
  }> = [];
  const queue = [{ userId: input.rootUserId, depth: 0, edgeIds: [] as string[] }];
  const visited = new Set<string>();
  while (queue.length > 0 && paths.length < 100) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;
    for (const edge of incoming.get(current.userId) ?? []) {
      const path = [...current.edgeIds, edge.id];
      const expectedCreatorTransfer =
        input.creatorUserIds?.has(edge.fromUserId)
        && /creator_tip|sponsor|battle/i.test(edge.sourceType);
      if (input.restrictedUserIds.has(edge.fromUserId) && !expectedCreatorTransfer) {
        paths.push({
          edgeIds: path,
          originUserId: edge.fromUserId,
          amountUsd: edge.amountUsd,
        });
      }
      const visitKey = `${edge.fromUserId}:${current.depth + 1}`;
      if (!visited.has(visitKey)) {
        visited.add(visitKey);
        queue.push({
          userId: edge.fromUserId,
          depth: current.depth + 1,
          edgeIds: path,
        });
      }
    }
  }
  return {
    matched: paths.length > 0,
    truncated: input.edges.length > maxEdges || queue.length > 0,
    paths,
  };
}
