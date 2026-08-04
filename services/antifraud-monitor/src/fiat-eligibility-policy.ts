/**
 * Pure automatic Fiat-checkout decision engine.
 *
 * Everything here is deterministic and IO-free so the whole policy surface is
 * unit-testable: the service layer gathers evidence, this module decides. Three
 * outputs, in strict precedence order:
 *
 *   1. `enforce`  — deny the checkout AND contain the account (fiat deposits
 *                   off + withdrawals locked). Reserved for evidence that a
 *                   human would not argue with.
 *   2. `deny`     — refuse this checkout, touch nothing. Account state that is
 *                   already correct (banned, KYC pending, country closed) and
 *                   every fail-closed condition land here.
 *   3. `allow`    — the scored band came in under the deny floor.
 *
 * A containment rule can never be out-scored: it does not add points, it sets
 * the outcome. Points only decide the grey zone in between.
 */

import type { EnrichmentResult } from "./enrichment.js";
import type { Signal } from "./types.js";

/** Allow decisions are valid for exactly this long. */
export const DECISION_TTL_MS = 60_000;
/** Backend request and Fingerprint event freshness ceiling. */
export const MAX_REQUEST_AGE_MS = 120_000;
/** Tolerated clock skew for a timestamp that is ahead of us. */
export const MAX_FUTURE_SKEW_MS = 30_000;
/** Scored-band deny floor. */
export const AUTOMATIC_DENY_SCORE = 50;

/** "New account" ceiling for the IP-change containment rule. */
export const IP_CHANGE_CONTAINMENT_AGE_DAYS = 7;
/** "New account" ceiling for the device-change containment rule, in hours. */
export const DEVICE_CHANGE_CONTAINMENT_AGE_HOURS = 36;
/** A second checkout this soon after a paid deposit is card testing. */
export const RECENT_PAID_FIAT_CONTAINMENT_MS = 60_000;
/** Account age at which the trust credits and lighter drift weights unlock. */
export const ESTABLISHED_ACCOUNT_DAYS = 7;
/** Account age treated as a long-standing customer for behaviour credit. */
export const LOYAL_ACCOUNT_DAYS = 30;
/** Crypto volume that counts as real skin in the game (USD). */
export const MEANINGFUL_CRYPTO_USD = 25;
/** Ceiling on every behaviour/history credit combined. */
export const MAX_TRUST_CREDIT = 30;

/**
 * Fingerprint signals that deny on their own. Provider booleans only — no
 * heuristics, no scores. Kept separate from the containment set below because
 * a Tor exit node or a rooted phone is a refusal, not proof of account abuse.
 */
export const HARD_FINGERPRINT_SIGNALS = new Set([
  "fingerprint_event_replayed",
  "fingerprint_linked_id_mismatch",
  "fingerprint_bad_bot",
  "fingerprint_tor",
  "fingerprint_ip_attack_source",
  "fingerprint_mobile_rooted",
  "fingerprint_mobile_cloned_app",
  "fingerprint_mobile_jailbroken",
  "fingerprint_mobile_frida",
  "fingerprint_mobile_location_spoofing",
  "fingerprint_mobile_mitm",
]);

/**
 * The subset of the above that also contains the account. Each one means the
 * request was forged or automated against this specific account — there is no
 * benign reading, so the account does not keep its deposit and withdrawal
 * rails while staff look at it.
 */
export const CONTAINING_FINGERPRINT_SIGNALS = new Set([
  "fingerprint_event_replayed",
  "fingerprint_linked_id_mismatch",
  "fingerprint_bad_bot",
]);

/** Provider signal keys that mark the checkout IP as bad. */
const BAD_IP_REPUTATION_KEYS = new Set([
  "fingerprint_vpn",
  "fingerprint_proxy",
  "fingerprint_tor",
  "fingerprint_datacenter",
  "fingerprint_ip_attack_source",
  "fingerprint_ip_email_spam",
  "proxycheck_anonymous",
  "abstract_ip_vpn",
  "abstract_ip_proxy",
  "abstract_ip_tor",
  "abstract_ip_hosting",
  "abstract_ip_relay",
  "abstract_ip_abuse",
  "opportify_ip_evidence",
]);

/** Provider signal keys that mark the checkout device as bad. */
const BAD_DEVICE_REPUTATION_KEYS = new Set([
  "fingerprint_bad_bot",
  "fingerprint_tampering",
  "fingerprint_virtual_machine",
  "fingerprint_high_activity",
  "fingerprint_velocity_ip_rotation",
  "fingerprint_velocity_country_hop",
  "fingerprint_velocity_multiple_accounts",
  "fingerprint_velocity_automation",
  "fingerprint_mobile_rooted",
  "fingerprint_mobile_emulator",
  "fingerprint_mobile_cloned_app",
  "fingerprint_mobile_jailbroken",
  "fingerprint_mobile_frida",
  "fingerprint_mobile_location_spoofing",
  "fingerprint_mobile_mitm",
  "fingerprint_suspect_score",
]);

/**
 * Live risk scores at or above which a provider counts as "bad" for the
 * combined IP+device containment rule, independent of any single boolean.
 */
const BAD_IP_SCORE_FLOOR = 51;
const BAD_DEVICE_SCORE_FLOOR = 40;

export type FiatEligibilitySignalSource =
  | "account"
  | "request"
  | "fingerprint"
  | "ip"
  | "network"
  | "history"
  | "behaviour"
  | "policy";

export type FiatEligibilitySignal = {
  key: string;
  detail: string;
  points: number;
  /** Denies on its own regardless of score. */
  blocking: boolean;
  /** Denies AND contains the account. Implies `blocking`. */
  containing: boolean;
  source: FiatEligibilitySignalSource;
};

export type FiatEligibilitySubject = {
  id: string;
  created_at: Date;
  signup_ip: string | null;
  visitor_id: string | null;
  is_suspected_alt: boolean;
  is_banned: boolean;
  is_locked: boolean;
  is_self_excluded: boolean;
  fiat_locked: boolean;
  country_blocked: boolean;
  country_fiat_locked: boolean;
  kyc_required: boolean;
  kyc_status: string;
  kyc_admin_decision: string;
  prior_paid_fiat: number;
};

/**
 * Deposit, play and reward history straight from the source mirror. All USD,
 * all completed rows only.
 */
export type FiatEligibilityBehaviour = {
  cryptoDeposits: number;
  cryptoDepositUsd: number;
  fiatDeposits: number;
  fiatDepositUsd: number;
  wagerUsd: number;
  gameEvents: number;
  rewardUsd: number;
  rainWins: number;
  withdrawalRequests: number;
  /** Milliseconds since the most recent PAID fiat deposit, null if none. */
  msSinceLastPaidFiat: number | null;
};

export type FiatEligibilityNetwork = {
  sharedCheckoutVisitorUsers: number;
  sharedCurrentIpUsers: number;
};

export type FiatEligibilityIdentity = {
  visitorId: string | null;
  linkedId: string | null;
  eventIp: string | null;
  eventTime: Date | null;
  replayed: boolean;
};

export type FiatEligibilityBlocklistMatch = {
  id: string;
  kind: "ip" | "fingerprint";
  value: string;
  reason: string;
  effect: "block" | "known_vpn";
};

export type FiatEligibilityPolicyInput = {
  now: Date;
  requestCreatedAt: Date;
  requestIp: string;
  subject: FiatEligibilitySubject;
  identity: FiatEligibilityIdentity;
  providers: readonly EnrichmentResult[];
  behaviour: FiatEligibilityBehaviour;
  network: FiatEligibilityNetwork;
  blocklistMatches: readonly FiatEligibilityBlocklistMatch[];
  signupRiskScore: number;
  activeCaseSeverity: string | null;
  attempts10m: number;
  deniedAttempts24h: number;
};

export type FiatEligibilityPolicyOutcome = {
  decision: "allow" | "deny";
  /** Deny plus account containment. False for every allow. */
  enforce: boolean;
  riskScore: number;
  signals: FiatEligibilitySignal[];
  /** Keys of the containment rules that fired, in evaluation order. */
  enforcementReasons: string[];
};

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function accountAgeDays(createdAt: Date, now: Date): number {
  const age = (now.getTime() - createdAt.getTime()) / 86_400_000;
  return Number.isFinite(age) ? Math.max(0, age) : 0;
}

/** Providers that answered successfully, by name. */
function successfulProviders(
  providers: readonly EnrichmentResult[],
): Map<string, EnrichmentResult> {
  return new Map(
    providers
      .filter((provider) => provider.status === "success")
      .map((provider) => [provider.provider, provider]),
  );
}

function providerSignalKeys(
  providers: readonly EnrichmentResult[],
): Set<string> {
  const keys = new Set<string>();
  for (const provider of providers) {
    if (provider.status !== "success") continue;
    for (const signal of provider.signals) {
      if (signal.points > 0) keys.add(signal.key);
    }
  }
  return keys;
}

/**
 * Reputation verdict for the address the checkout is coming from. True when any
 * anonymising/hosting/abuse boolean fired, or when a provider's own live risk
 * score crosses its floor. Deliberately generous: it is only ever combined with
 * a device change AND an IP change before it contains anything.
 */
export function badIpReputation(
  providers: readonly EnrichmentResult[],
): boolean {
  const keys = providerSignalKeys(providers);
  for (const key of BAD_IP_REPUTATION_KEYS) {
    if (keys.has(key)) return true;
  }
  const successful = successfulProviders(providers);
  for (const name of ["proxycheck", "abstract_ip", "opportify"]) {
    const score = successful.get(name)?.score;
    if (typeof score === "number" && score >= BAD_IP_SCORE_FLOOR) return true;
  }
  return false;
}

/** Reputation verdict for the device the checkout is coming from. */
export function badDeviceReputation(
  providers: readonly EnrichmentResult[],
): boolean {
  const keys = providerSignalKeys(providers);
  for (const key of BAD_DEVICE_REPUTATION_KEYS) {
    if (keys.has(key)) return true;
  }
  const fingerprintScore = successfulProviders(providers).get(
    "fingerprint",
  )?.score;
  return (
    typeof fingerprintScore === "number"
    && fingerprintScore >= BAD_DEVICE_SCORE_FLOOR
  );
}

/**
 * Behaviour credit and penalty. Older, self-funded, actually-playing accounts
 * buy headroom; reward-farmed accounts that never funded anything lose it.
 *
 * Credits are capped as a group (`MAX_TRUST_CREDIT`) so history can soften the
 * scored band without ever neutralising it, and the caller drops the whole
 * credit block when any blocking signal fired.
 */
export function behaviourSignals(input: {
  ageDays: number;
  behaviour: FiatEligibilityBehaviour;
}): FiatEligibilitySignal[] {
  const { behaviour } = input;
  const signals: FiatEligibilitySignal[] = [];
  const credit = (
    key: string,
    detail: string,
    points: number,
  ): void => {
    signals.push({
      key,
      detail,
      points: -points,
      blocking: false,
      containing: false,
      source: "behaviour",
    });
  };

  if (input.ageDays >= LOYAL_ACCOUNT_DAYS) {
    credit(
      "behaviour_account_established",
      `The account is ${Math.floor(input.ageDays)} days old.`,
      10,
    );
  } else if (input.ageDays >= ESTABLISHED_ACCOUNT_DAYS) {
    credit(
      "behaviour_account_seasoned",
      `The account is ${Math.floor(input.ageDays)} days old.`,
      5,
    );
  }

  if (behaviour.cryptoDepositUsd >= MEANINGFUL_CRYPTO_USD) {
    // Self-funded crypto history is the strongest good-faith evidence we hold:
    // it is irreversible money the account already committed.
    const volumeCredit = behaviour.cryptoDepositUsd >= 500
      ? 20
      : behaviour.cryptoDepositUsd >= 100
        ? 14
        : 8;
    credit(
      "behaviour_crypto_funding_history",
      `The account completed ${behaviour.cryptoDeposits} crypto deposit(s) `
        + `worth $${behaviour.cryptoDepositUsd.toFixed(2)}.`,
      volumeCredit,
    );
  }

  if (behaviour.fiatDeposits > 0) {
    credit(
      "behaviour_fiat_funding_history",
      `The account completed ${behaviour.fiatDeposits} Fiat deposit(s) `
        + `worth $${behaviour.fiatDepositUsd.toFixed(2)}.`,
      Math.min(10, 4 + behaviour.fiatDeposits),
    );
  }

  const fundedUsd = behaviour.cryptoDepositUsd + behaviour.fiatDepositUsd;
  if (behaviour.gameEvents >= 25 && fundedUsd > 0) {
    credit(
      "behaviour_normal_play",
      `The account has ${behaviour.gameEvents} paid game events and `
        + `$${behaviour.wagerUsd.toFixed(2)} wagered.`,
      behaviour.gameEvents >= 200 ? 10 : 6,
    );
  }

  // Reward-only accounts: value came from rain, promos and claims, never from
  // the account's own money. A card showing up on one of those is the classic
  // farm-then-launder shape, so it pays points instead of earning them.
  if (fundedUsd <= 0 && behaviour.rewardUsd > 0) {
    signals.push({
      key: "behaviour_reward_farmed_never_funded",
      detail:
        `The account collected $${behaviour.rewardUsd.toFixed(2)} in rewards `
        + `across ${behaviour.rainWins} rain win(s) without any completed `
        + "deposit.",
      points: behaviour.rewardUsd >= 25 ? 35 : 20,
      blocking: false,
      containing: false,
      source: "behaviour",
    });
  }

  if (fundedUsd <= 0 && behaviour.withdrawalRequests > 0) {
    signals.push({
      key: "behaviour_withdrawing_without_funding",
      detail:
        `The account requested ${behaviour.withdrawalRequests} withdrawal(s) `
        + "without any completed deposit.",
      points: 25,
      blocking: false,
      containing: false,
      source: "behaviour",
    });
  }

  if (behaviour.gameEvents === 0 && fundedUsd > 0) {
    signals.push({
      key: "behaviour_funding_without_play",
      detail: "The account funded before but has never played a paid game.",
      points: 15,
      blocking: false,
      containing: false,
      source: "behaviour",
    });
  }

  return signals;
}

/**
 * Evaluate one checkout. Deterministic: same input, same verdict.
 */
export function evaluateFiatEligibility(
  input: FiatEligibilityPolicyInput,
): FiatEligibilityPolicyOutcome {
  const signals: FiatEligibilitySignal[] = [];
  const add = (
    hit: boolean,
    signal: Omit<FiatEligibilitySignal, "blocking" | "containing"> & {
      blocking?: boolean;
      containing?: boolean;
    },
  ): void => {
    if (!hit) return;
    const containing = signal.containing ?? false;
    signals.push({
      ...signal,
      containing,
      blocking: containing || (signal.blocking ?? false),
    });
  };

  const ageDays = accountAgeDays(input.subject.created_at, input.now);
  const established = ageDays >= ESTABLISHED_ACCOUNT_DAYS;
  const ageHours = ageDays * 24;

  // ── Account state ────────────────────────────────────────────────────────
  // Already-correct states. Deny, never contain: re-locking an account staff
  // already handled would overwrite their reason and re-stamp the timestamps.
  add(input.subject.is_banned, {
    key: "account_banned",
    detail: "The account is banned.",
    points: 100,
    blocking: true,
    source: "account",
  });
  add(input.subject.is_locked, {
    key: "account_locked",
    detail: "The account is locked.",
    points: 100,
    blocking: true,
    source: "account",
  });
  add(input.subject.is_self_excluded, {
    key: "account_self_excluded",
    detail: "The account is self-excluded.",
    points: 100,
    blocking: true,
    source: "account",
  });
  add(input.subject.fiat_locked, {
    key: "fiat_disabled_for_user",
    detail: "Fiat deposits are disabled by the per-user controller.",
    points: 100,
    blocking: true,
    source: "account",
  });
  add(input.subject.country_blocked || input.subject.country_fiat_locked, {
    key: "fiat_disabled_for_country",
    detail: "Fiat deposits are unavailable for the account country.",
    points: 100,
    blocking: true,
    source: "account",
  });
  add(
    input.subject.kyc_required
      && (
        input.subject.kyc_status !== "approved"
        || input.subject.kyc_admin_decision === "rejected"
      ),
    {
      key: "kyc_not_cleared",
      detail: "Required KYC has not been approved.",
      points: 100,
      blocking: true,
      source: "account",
    },
  );

  // ── Request integrity ────────────────────────────────────────────────────
  const requestAge = input.now.getTime() - input.requestCreatedAt.getTime();
  add(
    !Number.isFinite(requestAge)
      || requestAge > MAX_REQUEST_AGE_MS
      || requestAge < -MAX_FUTURE_SKEW_MS,
    {
      key: "stale_request",
      detail: "The backend request timestamp is outside the accepted window.",
      points: 100,
      blocking: true,
      source: "request",
    },
  );

  // ── Fail closed on provider gaps ─────────────────────────────────────────
  // Fingerprint and proxycheck are mandatory: the identity binding and the
  // independent IP opinion come from them. Abstract and Opportify are
  // corroborating, so a failure there costs points instead of the checkout.
  const byName = new Map(
    input.providers.map((provider) => [provider.provider, provider]),
  );
  const fingerprint = byName.get("fingerprint");
  const proxycheck = byName.get("proxycheck");
  add(fingerprint?.status !== "success", {
    key: "fingerprint_check_unavailable",
    detail: "The full Fingerprint event check did not succeed.",
    points: 100,
    blocking: true,
    source: "fingerprint",
  });
  add(proxycheck?.status !== "success", {
    key: "ip_check_unavailable",
    detail: "The full independent IP check did not succeed.",
    points: 100,
    blocking: true,
    source: "ip",
  });
  for (const name of ["abstract_ip", "opportify"] as const) {
    const provider = byName.get(name);
    add(provider !== undefined && provider.status === "failed", {
      key: `${name}_check_degraded`,
      detail: `The corroborating ${name} check did not succeed.`,
      points: 10,
      source: "ip",
    });
  }

  // ── Fingerprint identity binding ─────────────────────────────────────────
  const identity = input.identity;
  if (fingerprint?.status === "success") {
    add(identity.linkedId !== input.subject.id, {
      key: identity.linkedId
        ? "fingerprint_linked_id_mismatch"
        : "fingerprint_linked_id_missing",
      detail: identity.linkedId
        ? "The Fingerprint event is linked to another user."
        : "The Fingerprint event is not linked to the requested user.",
      points: 100,
      // A live event proving ANOTHER account's device drove this checkout is
      // forgery. A missing link is usually a broken integration, so it only
      // denies.
      blocking: true,
      containing: Boolean(identity.linkedId),
      source: "fingerprint",
    });
    add(identity.eventIp !== input.requestIp, {
      key: "fingerprint_ip_mismatch",
      detail: "The Fingerprint event IP differs from the backend-captured IP.",
      points: 100,
      blocking: true,
      source: "fingerprint",
    });
    const eventAge = identity.eventTime
      ? input.now.getTime() - identity.eventTime.getTime()
      : Number.POSITIVE_INFINITY;
    add(eventAge > MAX_REQUEST_AGE_MS || eventAge < -MAX_FUTURE_SKEW_MS, {
      key: "fingerprint_event_stale",
      detail: "The Fingerprint event is missing a fresh trusted timestamp.",
      points: 100,
      blocking: true,
      source: "fingerprint",
    });
    add(identity.replayed, {
      key: "fingerprint_event_replayed",
      detail: "Fingerprint marked the event as replayed.",
      points: 100,
      blocking: true,
      containing: true,
      source: "fingerprint",
    });
  }

  // ── Operator blocklists ──────────────────────────────────────────────────
  for (const match of input.blocklistMatches) {
    if (match.effect === "known_vpn") {
      add(true, {
        key: "known_vpn_ip_match",
        detail: `The checkout IP matches a known shared VPN: ${match.reason}`,
        points: 15,
        containing: false,
        source: "policy",
      });
      continue;
    }
    add(true, {
      key: `blocklist_${match.kind}_match`,
      detail:
        `The checkout ${match.kind === "ip" ? "IP" : "device"} matches an `
        + `active operator blocklist rule: ${match.reason}`,
      points: 100,
      containing: true,
      source: "policy",
    });
  }

  // ── Drift from signup, and the hard rules built on it ────────────────────
  const ipChanged = Boolean(
    input.subject.signup_ip
    && input.subject.signup_ip !== input.requestIp,
  );
  const deviceChanged = Boolean(
    input.subject.visitor_id
    && identity.visitorId
    && input.subject.visitor_id !== identity.visitorId,
  );

  add(
    ipChanged && ageDays < IP_CHANGE_CONTAINMENT_AGE_DAYS,
    {
      key: "new_account_checkout_ip_changed",
      detail:
        `The account is ${ageDays.toFixed(2)} days old and is checking out `
        + "from a different IP than signup.",
      points: 100,
      containing: true,
      source: "policy",
    },
  );
  add(
    deviceChanged && ageHours < DEVICE_CHANGE_CONTAINMENT_AGE_HOURS,
    {
      key: "new_account_checkout_device_changed",
      detail:
        `The account is ${ageHours.toFixed(1)} hours old and is checking out `
        + "from a different device than signup.",
      points: 100,
      containing: true,
      source: "policy",
    },
  );
  const badIp = badIpReputation(input.providers);
  const badDevice = badDeviceReputation(input.providers);
  add(
    ipChanged && deviceChanged && (badIp || badDevice),
    {
      key: "checkout_identity_changed_with_bad_reputation",
      detail:
        "Both the checkout IP and device differ from signup and the "
        + `${badIp && badDevice ? "IP and device" : badIp ? "IP" : "device"} `
        + "carries a bad provider reputation.",
      points: 100,
      containing: true,
      source: "policy",
    },
  );

  // Card testing: a paid deposit landed seconds ago and another checkout is
  // already being opened.
  add(
    input.behaviour.msSinceLastPaidFiat !== null
      && input.behaviour.msSinceLastPaidFiat >= 0
      && input.behaviour.msSinceLastPaidFiat
        < RECENT_PAID_FIAT_CONTAINMENT_MS,
    {
      key: "repeat_fiat_within_sixty_seconds",
      detail:
        "A Fiat deposit for this account was paid "
        + `${Math.round((input.behaviour.msSinceLastPaidFiat ?? 0) / 1000)}s `
        + "ago and another checkout was requested.",
      points: 100,
      containing: true,
      source: "policy",
    },
  );

  // Scored drift, for accounts the hard rules did not catch.
  add(ipChanged, {
    key: "signup_ip_changed",
    detail: "The checkout IP differs from the signup IP.",
    points: established ? 10 : 25,
    source: "network",
  });
  add(deviceChanged, {
    key: "signup_fingerprint_changed",
    detail: "The checkout device differs from the signup device.",
    points: established ? 20 : 35,
    source: "fingerprint",
  });

  // ── Account and account-age scoring ──────────────────────────────────────
  add(input.subject.is_suspected_alt, {
    key: "suspected_alt_account",
    detail: "The account is marked as a suspected alternate account.",
    points: 55,
    source: "account",
  });
  add(ageDays < 1, {
    key: "account_younger_than_one_day",
    detail: "The account is less than one day old.",
    points: 30,
    source: "account",
  });
  add(ageDays >= 1 && ageDays < ESTABLISHED_ACCOUNT_DAYS, {
    key: "account_younger_than_seven_days",
    detail: "The account is less than seven days old.",
    points: 15,
    source: "account",
  });

  // ── Provider signals ─────────────────────────────────────────────────────
  for (const provider of input.providers) {
    if (provider.status !== "success") continue;
    const source: FiatEligibilitySignalSource =
      provider.provider === "fingerprint" ? "fingerprint" : "ip";
    for (const providerSignal of provider.signals as Signal[]) {
      add(providerSignal.points > 0, {
        key: providerSignal.key,
        detail: providerSignal.detail,
        points: providerSignal.points,
        blocking: HARD_FINGERPRINT_SIGNALS.has(providerSignal.key),
        containing: CONTAINING_FINGERPRINT_SIGNALS.has(providerSignal.key),
        source,
      });
    }
  }

  // ── Shared network and history ───────────────────────────────────────────
  add(input.network.sharedCheckoutVisitorUsers > 0, {
    key: "checkout_device_shared",
    detail:
      `${input.network.sharedCheckoutVisitorUsers} other account(s) use the `
      + "checkout device.",
    points: input.network.sharedCheckoutVisitorUsers >= 3 ? 70 : 40,
    source: "network",
  });
  add(input.network.sharedCurrentIpUsers >= 3, {
    key: "checkout_ip_shared",
    detail:
      `${input.network.sharedCurrentIpUsers} other account(s) signed up from `
      + "the checkout IP.",
    points: input.network.sharedCurrentIpUsers >= 10 ? 40 : 15,
    source: "network",
  });
  add(input.signupRiskScore >= 25, {
    key: "signup_risk_history",
    detail: `The signup assessment score is ${input.signupRiskScore}.`,
    points: input.signupRiskScore >= 60 ? 45 : 20,
    source: "history",
  });
  add(
    input.activeCaseSeverity === "high"
      || input.activeCaseSeverity === "critical",
    {
      key: "active_high_risk_case",
      detail:
        `The account has an active ${input.activeCaseSeverity} Antifraud case.`,
      points: 60,
      source: "history",
    },
  );
  add(input.attempts10m >= 5, {
    key: "fiat_eligibility_velocity",
    detail:
      `${input.attempts10m} Fiat eligibility attempts were made in ten `
      + "minutes.",
    points: input.attempts10m >= 10 ? 70 : 35,
    source: "history",
  });
  add(input.deniedAttempts24h >= 3, {
    key: "repeated_fiat_denials",
    detail:
      `${input.deniedAttempts24h} Fiat eligibility attempts were denied in 24 `
      + "hours.",
    points: input.deniedAttempts24h >= 6 ? 60 : 25,
    source: "history",
  });

  // ── Behaviour ────────────────────────────────────────────────────────────
  const behaviour = behaviourSignals({ ageDays, behaviour: input.behaviour });
  signals.push(...behaviour.filter((signal) => signal.points > 0));

  // Highest points wins per key; a key that is blocking or containing anywhere
  // stays that way.
  const deduped = [...new Map(
    signals.map((signal) => {
      const sameKey = signals.filter(
        (candidate) => candidate.key === signal.key,
      );
      return [signal.key, {
        ...signal,
        points: Math.max(...sameKey.map((candidate) => candidate.points)),
        blocking: sameKey.some((candidate) => candidate.blocking),
        containing: sameKey.some((candidate) => candidate.containing),
      }];
    }),
  ).values()];

  const blocked = deduped.some((signal) => signal.blocking);
  if (!blocked) {
    // Credits are earned by clean accounts only, and capped as a group.
    let remaining = MAX_TRUST_CREDIT;
    for (const signal of behaviour) {
      if (signal.points >= 0 || remaining <= 0) continue;
      const granted = Math.max(signal.points, -remaining);
      remaining += granted;
      deduped.push({ ...signal, points: granted });
    }
  }

  const riskScore = clampScore(
    deduped.reduce((total, signal) => total + signal.points, 0),
  );
  const enforcementReasons = deduped
    .filter((signal) => signal.containing)
    .map((signal) => signal.key);
  const decision =
    blocked || riskScore >= AUTOMATIC_DENY_SCORE ? "deny" : "allow";

  return {
    decision,
    enforce: enforcementReasons.length > 0,
    riskScore,
    signals: deduped,
    enforcementReasons,
  };
}
