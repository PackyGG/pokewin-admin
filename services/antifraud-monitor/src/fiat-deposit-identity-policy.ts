/**
 * Pure post-authorization Fiat deposit identity policy.
 *
 * IO-free and deterministic so the whole rule surface is unit-testable: the
 * service gathers evidence, this module decides. It answers one question —
 * *did the payer's identity drift from the one this account established on its
 * first authorized Fiat deposit?*
 *
 * Why this exists next to `fiat-eligibility-policy.ts` rather than inside it:
 * that module runs BEFORE the checkout and can only compare against signup.
 * The card last4 and the email the payer typed into Whop's checkout form do
 * not exist until the payment is authorized, so the strongest identity facts
 * we hold are only ever available here.
 *
 * Two classes of rule, and the distinction is the whole design:
 *
 *   • ABSOLUTE — the deposit is bad on its own evidence (blacklisted domain,
 *     operator blocklist hit, catch-all or undeliverable payer email). These
 *     apply to every deposit including the very first, and no amount of good
 *     history excuses them.
 *   • DRIFT — this deposit disagrees with the baseline the account set itself.
 *     Only computable from the second deposit onward, and only when BOTH sides
 *     of the comparison are actually known. Missing evidence never contains.
 */

/** Authorized, never-reversed deposits after which a new card is accepted. */
export const CARD_CHANGE_TRUST_DEPOSITS = 3;

/**
 * Rules that require KYC and lock the money rails.
 *
 * Mirrored as an allowlist in the dashboard's ingest route: the monitor
 * decides, the dashboard independently re-checks the reason it was given, so a
 * bug or a forged payload on this side cannot invent a new reason to lock an
 * account.
 */
export const FIAT_IDENTITY_CONTAINMENT_REASONS = [
  "checkout_email_domain_blacklisted",
  "checkout_ip_blocklisted",
  "checkout_fingerprint_blocklisted",
  "checkout_refunded_amount_cluster",
  "checkout_email_catchall",
  "checkout_email_undeliverable",
  "checkout_email_changed",
  "checkout_card_changed",
  "checkout_ip_and_device_changed",
] as const;

export type FiatIdentityContainmentReason =
  (typeof FIAT_IDENTITY_CONTAINMENT_REASONS)[number];

/**
 * Drift that is explainable on its own. Recorded and alerted, never locked.
 *
 * A single changed IP is a phone leaving wifi; a single changed device is a
 * laptop swapped for that phone. Either one alone is ordinary customer
 * behaviour, so locking on it would punish the honest majority. Together they
 * describe a different person at a different place, which is why the pair is a
 * containment reason and neither half is.
 */
export const FIAT_IDENTITY_WATCH_REASONS = [
  "checkout_known_vpn_ip",
  "checkout_ip_changed",
  "checkout_device_changed",
  "checkout_card_changed_trusted",
  "checkout_email_deliverability_unknown",
  "checkout_identity_evidence_missing",
] as const;

export type FiatIdentityWatchReason =
  (typeof FIAT_IDENTITY_WATCH_REASONS)[number];

/** The identity the account established on its first authorized deposit. */
export type FiatIdentityBaseline = {
  intentId: string;
  cardBrand: string | null;
  cardLast4: string | null;
  checkoutEmail: string | null;
  checkoutIp: string | null;
  checkoutVisitorId: string | null;
};

export type FiatIdentityBlocklistMatch = {
  id: string;
  kind: "ip" | "fingerprint";
  value: string;
  reason: string;
  effect: "block" | "known_vpn";
};

/**
 * Abstract's verdict on the CHECKOUT email. `null` means the provider was not
 * consulted or did not answer — never treated as a pass or a fail.
 */
export type FiatIdentityEmailReputation = {
  catchall: boolean | null;
  /** Abstract's `email_deliverability.status`, lowercased. */
  deliverability: string | null;
};

export type FiatIdentityObservation = {
  intentId: string;
  userId: string;
  occurredAt: Date;
  cardBrand: string | null;
  cardLast4: string | null;
  checkoutEmail: string | null;
  checkoutIp: string | null;
  checkoutVisitorId: string | null;
  email: FiatIdentityEmailReputation;
  /** Non-null when the payer email's domain is on the active blacklist. */
  blacklistedEmailDomain: string | null;
  /** Active global refund campaign for this exact currency and amount. */
  refundedAmountClusterReason: string | null;
  blocklistMatches: readonly FiatIdentityBlocklistMatch[];
  /** Authorized deposits before this one that never reversed. */
  priorCleanDeposits: number;
};

export type FiatIdentityPolicyInput = {
  observation: FiatIdentityObservation;
  /** Null when this deposit IS the account's first authorized one. */
  baseline: FiatIdentityBaseline | null;
};

export type FiatIdentitySignal = {
  key: FiatIdentityContainmentReason | FiatIdentityWatchReason;
  detail: string;
  containing: boolean;
};

export type FiatIdentityOutcome = {
  verdict: "clear" | "watch" | "contain";
  /** Containment rules that fired, in evaluation order. */
  reasonCodes: FiatIdentityContainmentReason[];
  /** Non-containing observations, in evaluation order. */
  watchCodes: FiatIdentityWatchReason[];
  signals: FiatIdentitySignal[];
};

/**
 * Card comparison is brand + last4: a *known* different brand is a different
 * card. Brand and last4 are discovered independently from webhook payloads, so
 * one side can carry a last4 with no brand at all. Treating that absence as a
 * mismatch turned the same physical card into a card change — and a card change
 * on an account with fewer than three clean deposits contains: KYC plus deposit
 * and withdrawal locks. A missing brand is missing evidence, not evidence of a
 * second card, so it does not contradict a matching last4.
 */
function sameCard(
  left: Pick<FiatIdentityBaseline, "cardBrand" | "cardLast4">,
  right: Pick<FiatIdentityBaseline, "cardBrand" | "cardLast4">,
): boolean {
  if (left.cardLast4 !== right.cardLast4) return false;
  if (left.cardBrand === null || right.cardBrand === null) return true;
  return left.cardBrand === right.cardBrand;
}

function normalizedEmail(value: string | null): string | null {
  const email = value?.trim().toLowerCase();
  return email ? email : null;
}

export function emailDomain(value: string | null): string | null {
  const email = normalizedEmail(value);
  const at = email?.lastIndexOf("@") ?? -1;
  if (!email || at <= 0 || at === email.length - 1) return null;
  return email.slice(at + 1);
}

/**
 * Evaluate one authorized deposit. Same input, same verdict, always.
 */
export function evaluateFiatDepositIdentity(
  input: FiatIdentityPolicyInput,
): FiatIdentityOutcome {
  const { observation: seen, baseline } = input;
  const signals: FiatIdentitySignal[] = [];
  const add = (
    hit: boolean,
    signal: FiatIdentitySignal,
  ): void => {
    if (hit) signals.push(signal);
  };

  // ── Absolute rules ───────────────────────────────────────────────────────
  // True of this deposit on its own evidence. They apply to the first deposit
  // as much as the tenth, and the trust grace never reaches them.
  add(seen.blacklistedEmailDomain !== null, {
    key: "checkout_email_domain_blacklisted",
    detail:
      "The payer email domain "
      + `${seen.blacklistedEmailDomain ?? ""} is on the active blacklist.`,
    containing: true,
  });

  add(seen.refundedAmountClusterReason !== null, {
    key: "checkout_refunded_amount_cluster",
    detail:
      "This exact payment amount is part of an active refunded-payment "
      + `campaign: ${seen.refundedAmountClusterReason ?? "unknown"}`,
    containing: true,
  });

  for (const match of seen.blocklistMatches) {
    if (match.effect === "known_vpn") {
      add(true, {
        key: "checkout_known_vpn_ip",
        detail: `The checkout IP matches a known shared VPN: ${match.reason}`,
        containing: false,
      });
      continue;
    }
    add(true, {
      key: match.kind === "ip"
        ? "checkout_ip_blocklisted"
        : "checkout_fingerprint_blocklisted",
      detail:
        `The checkout ${match.kind === "ip" ? "IP" : "device"} matches an `
        + `active operator blocklist rule: ${match.reason}`,
      containing: true,
    });
  }

  add(seen.email.catchall === true, {
    key: "checkout_email_catchall",
    detail:
      "Abstract confirmed the payer email sits on a catch-all domain, so the "
      + "address proves nothing about who controls it.",
    containing: true,
  });

  // Only an explicit "undeliverable" contains. "unknown" means the provider
  // could not decide, and a provider shrug is not evidence against a player.
  add(seen.email.deliverability === "undeliverable", {
    key: "checkout_email_undeliverable",
    detail: "Abstract reports the payer email as undeliverable.",
    containing: true,
  });
  add(
    seen.email.deliverability !== null
      && seen.email.deliverability !== "undeliverable"
      && seen.email.deliverability !== "deliverable",
    {
      key: "checkout_email_deliverability_unknown",
      detail:
        "Abstract could not confirm payer email deliverability "
        + `(${seen.email.deliverability ?? "unknown"}).`,
      containing: false,
    },
  );

  // ── Drift rules ──────────────────────────────────────────────────────────
  // Nothing below can fire on the account's first authorized deposit: there is
  // no baseline to disagree with yet.
  if (!baseline) {
    return finalize(signals);
  }

  const emailChanged =
    normalizedEmail(baseline.checkoutEmail) !== null
    && normalizedEmail(seen.checkoutEmail) !== null
    && normalizedEmail(baseline.checkoutEmail)
      !== normalizedEmail(seen.checkoutEmail);
  add(emailChanged, {
    key: "checkout_email_changed",
    detail:
      "The payer email differs from the one used on the account's first "
      + "authorized Fiat deposit.",
    containing: true,
  });

  const cardChanged =
    baseline.cardLast4 !== null
    && seen.cardLast4 !== null
    && !sameCard(baseline, seen);
  // The ONLY rule the trust grace applies to. A customer who has funded three
  // times without a single dispute or refund has earned the right to pay with
  // a different card; every other drift signal still contains.
  const cardTrusted = seen.priorCleanDeposits >= CARD_CHANGE_TRUST_DEPOSITS;
  add(cardChanged && !cardTrusted, {
    key: "checkout_card_changed",
    detail:
      `The card changed to ${seen.cardBrand ?? "unknown"} ••••`
      + `${seen.cardLast4 ?? "????"} after only ${seen.priorCleanDeposits} `
      + "clean authorized deposit(s).",
    containing: true,
  });
  add(cardChanged && cardTrusted, {
    key: "checkout_card_changed_trusted",
    detail:
      `The card changed to ${seen.cardBrand ?? "unknown"} ••••`
      + `${seen.cardLast4 ?? "????"}, accepted on ${seen.priorCleanDeposits} `
      + "clean authorized deposits.",
    containing: false,
  });

  const ipChanged =
    baseline.checkoutIp !== null
    && seen.checkoutIp !== null
    && baseline.checkoutIp !== seen.checkoutIp;
  const deviceChanged =
    baseline.checkoutVisitorId !== null
    && seen.checkoutVisitorId !== null
    && baseline.checkoutVisitorId !== seen.checkoutVisitorId;

  add(ipChanged && deviceChanged, {
    key: "checkout_ip_and_device_changed",
    detail:
      "Both the checkout IP and the checkout device differ from the account's "
      + "first authorized Fiat deposit.",
    containing: true,
  });
  add(ipChanged && !deviceChanged, {
    key: "checkout_ip_changed",
    detail: "The checkout IP differs from the first authorized deposit.",
    containing: false,
  });
  add(deviceChanged && !ipChanged, {
    key: "checkout_device_changed",
    detail: "The checkout device differs from the first authorized deposit.",
    containing: false,
  });

  // A baseline we cannot compare against is worth surfacing: it means the
  // checkout evidence for one of the two deposits never reached us, and the
  // drift rules above silently could not run.
  add(
    (baseline.checkoutIp === null || seen.checkoutIp === null)
      && (baseline.checkoutVisitorId === null
        || seen.checkoutVisitorId === null),
    {
      key: "checkout_identity_evidence_missing",
      detail:
        "No checkout IP or device evidence could be compared for this "
        + "deposit, so the drift rules did not run.",
      containing: false,
    },
  );

  return finalize(signals);
}

function finalize(signals: FiatIdentitySignal[]): FiatIdentityOutcome {
  // Highest severity per key wins, first occurrence keeps its position.
  const deduped = [
    ...new Map(signals.map((signal) => [signal.key, signal])).values(),
  ];
  const reasonCodes = deduped
    .filter((signal) => signal.containing)
    .map((signal) => signal.key as FiatIdentityContainmentReason);
  const watchCodes = deduped
    .filter((signal) => !signal.containing)
    .map((signal) => signal.key as FiatIdentityWatchReason);
  return {
    verdict:
      reasonCodes.length > 0
        ? "contain"
        : watchCodes.length > 0
          ? "watch"
          : "clear",
    reasonCodes,
    watchCodes,
    signals: deduped,
  };
}
