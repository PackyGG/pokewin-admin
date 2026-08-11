/**
 * Pure post-authorization Fiat deposit identity policy.
 *
 * IO-free and deterministic so the whole rule surface is unit-testable: the
 * service gathers evidence, this module decides. It answers one question —
 * *did the payer's identity drift from its immediately previous authorized
 * Fiat deposit?*
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

/** A card swap this soon after the previous payment locks withdrawals. */
export const CARD_CHANGE_LOCK_WINDOW_MS = 2 * 60 * 60 * 1000;
/** A same-day card swap still opens review, but does not lock the account. */
export const CARD_CHANGE_REVIEW_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Rules that lock an approved subset of the money rails and open review.
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
  "checkout_card_changed_recent",
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
  "checkout_card_changed_late",
  "checkout_email_deliverability_unknown",
  "checkout_identity_evidence_missing",
] as const;

export type FiatIdentityWatchReason =
  (typeof FIAT_IDENTITY_WATCH_REASONS)[number];

export const FIAT_IDENTITY_REVIEW_REASONS = [
  "checkout_refunded_amount_cluster",
  "checkout_email_catchall",
  "checkout_email_undeliverable",
  "checkout_email_changed",
  "checkout_card_changed_same_day",
] as const;

export type FiatIdentityReviewReason =
  (typeof FIAT_IDENTITY_REVIEW_REASONS)[number];

export type FiatIdentityContainmentAction =
  | "withdrawals"
  | "fiat_and_withdrawals";

/** The identity observed on the immediately previous authorized deposit. */
export type FiatIdentityBaseline = {
  intentId: string;
  occurredAt: Date;
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
  /** Null when this deposit has no previous authorized Fiat payment. */
  baseline: FiatIdentityBaseline | null;
};

export type FiatIdentitySignal = {
  key:
    | FiatIdentityContainmentReason
    | FiatIdentityReviewReason
    | FiatIdentityWatchReason;
  detail: string;
  action: "watch" | "review" | FiatIdentityContainmentAction;
};

export type FiatIdentityOutcome = {
  verdict: "clear" | "watch" | "review" | "contain";
  /** Containment rules that fired, in evaluation order. */
  reasonCodes: FiatIdentityContainmentReason[];
  reviewCodes: FiatIdentityReviewReason[];
  /** Non-containing observations, in evaluation order. */
  watchCodes: FiatIdentityWatchReason[];
  containmentAction: FiatIdentityContainmentAction | null;
  signals: FiatIdentitySignal[];
};

/**
 * Card comparison is brand + last4: a *known* different brand is a different
 * card. Brand and last4 are discovered independently from webhook payloads, so
 * one side can carry a last4 with no brand at all. Treating that absence as a
 * mismatch turned the same physical card into a card change and an unnecessary
 * withdrawal lock. A missing brand is missing evidence, not evidence of a
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
    action: "withdrawals",
  });

  add(seen.refundedAmountClusterReason !== null, {
    key: "checkout_refunded_amount_cluster",
    detail:
      "This exact payment amount is part of an active refunded-payment "
      + `campaign: ${seen.refundedAmountClusterReason ?? "unknown"}`,
    action: "review",
  });

  for (const match of seen.blocklistMatches) {
    if (match.effect === "known_vpn") {
      add(true, {
        key: "checkout_known_vpn_ip",
        detail: `The checkout IP matches a known shared VPN: ${match.reason}`,
        action: "watch",
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
      action: "fiat_and_withdrawals",
    });
  }

  add(seen.email.catchall === true, {
    key: "checkout_email_catchall",
    detail:
      "Abstract confirmed the payer email sits on a catch-all domain, so the "
      + "address proves nothing about who controls it.",
    action: "review",
  });

  // Only an explicit "undeliverable" opens review. "unknown" means the
  // provider could not decide, and a provider shrug is not evidence against a
  // player.
  add(seen.email.deliverability === "undeliverable", {
    key: "checkout_email_undeliverable",
    detail: "Abstract reports the payer email as undeliverable.",
    action: "review",
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
      action: "watch",
    },
  );

  // ── Drift rules ──────────────────────────────────────────────────────────
  // Nothing below can fire without a previous authorized deposit.
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
      "The payer email differs from the immediately previous authorized "
      + "Fiat deposit.",
    action: "review",
  });

  const cardChanged =
    baseline.cardLast4 !== null
    && seen.cardLast4 !== null
    && !sameCard(baseline, seen);
  const cardChangeAgeMs = Math.max(
    0,
    seen.occurredAt.getTime() - baseline.occurredAt.getTime(),
  );
  add(cardChanged && cardChangeAgeMs < CARD_CHANGE_LOCK_WINDOW_MS, {
    key: "checkout_card_changed_recent",
    detail:
      `The card changed to ${seen.cardBrand ?? "unknown"} ••••`
      + `${seen.cardLast4 ?? "????"} within two hours of the previous `
      + "authorized deposit.",
    action: "withdrawals",
  });
  add(
    cardChanged
      && cardChangeAgeMs >= CARD_CHANGE_LOCK_WINDOW_MS
      && cardChangeAgeMs < CARD_CHANGE_REVIEW_WINDOW_MS,
    {
      key: "checkout_card_changed_same_day",
      detail:
        `The card changed to ${seen.cardBrand ?? "unknown"} ••••`
        + `${seen.cardLast4 ?? "????"} within 24 hours of the previous `
        + "authorized deposit.",
      action: "review",
    },
  );
  add(cardChanged && cardChangeAgeMs >= CARD_CHANGE_REVIEW_WINDOW_MS, {
    key: "checkout_card_changed_late",
    detail:
      `The card changed to ${seen.cardBrand ?? "unknown"} ••••`
      + `${seen.cardLast4 ?? "????"} more than 24 hours after the previous `
      + "authorized deposit.",
    action: "watch",
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
      + "previous authorized Fiat deposit.",
    action: "fiat_and_withdrawals",
  });
  add(ipChanged && !deviceChanged, {
    key: "checkout_ip_changed",
    detail: "The checkout IP differs from the previous authorized deposit.",
    action: "watch",
  });
  add(deviceChanged && !ipChanged, {
    key: "checkout_device_changed",
    detail: "The checkout device differs from the previous authorized deposit.",
    action: "watch",
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
      action: "watch",
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
    .filter(
      (signal) => signal.action === "withdrawals"
        || signal.action === "fiat_and_withdrawals",
    )
    .map((signal) => signal.key as FiatIdentityContainmentReason);
  const reviewCodes = deduped
    .filter((signal) => signal.action === "review")
    .map((signal) => signal.key as FiatIdentityReviewReason);
  const watchCodes = deduped
    .filter((signal) => signal.action === "watch")
    .map((signal) => signal.key as FiatIdentityWatchReason);
  const containmentAction = deduped.some(
    (signal) => signal.action === "fiat_and_withdrawals",
  )
    ? "fiat_and_withdrawals"
    : deduped.some((signal) => signal.action === "withdrawals")
      ? "withdrawals"
      : null;
  return {
    verdict:
      reasonCodes.length > 0
        ? "contain"
        : reviewCodes.length > 0
          ? "review"
        : watchCodes.length > 0
          ? "watch"
          : "clear",
    reasonCodes,
    reviewCodes,
    watchCodes,
    containmentAction,
    signals: deduped,
  };
}
