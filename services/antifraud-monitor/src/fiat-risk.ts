import type { Pool } from "pg";

import type { Databases } from "./db.js";
import { whopPaymentMethodFromPayload } from "./whop-payment-method.js";

export type FiatVerdict = "good" | "review" | "bad";
export type FiatRiskCategory =
  | "provider"
  | "funding"
  | "velocity"
  | "account"
  | "network"
  | "behavior";

export type FiatSignal = {
  key: string;
  label: string;
  detail: string;
  points: number;
  tone: "good" | "neutral" | "warning" | "bad";
  category: FiatRiskCategory;
};

export type FiatScoreBreakdown = Record<FiatRiskCategory, number>;

export type FiatFlowCheck = {
  key: FiatRiskCategory;
  label: string;
  description: string;
  status: "pass" | "review" | "block";
  score: number;
  evidence: string[];
};

export type WhopRiskSignal = {
  key: string;
  category: string;
  label: string;
  value: string | number | boolean | null;
};

export type FiatProviderEvidence = {
  eventType: string | null;
  eventReceivedAt: string | null;
  checkoutEmail: string | null;
  threeDsVerified: boolean | null;
  riskScore: number | null;
  riskSignals: WhopRiskSignal[];
  disputeCount: number;
  refundCount: number;
  autoRefunded: boolean;
  billingCountry: string | null;
  paymentMethodType: string | null;
};

export type FiatFundingEvidence = {
  priorCryptoDeposits: number;
  priorCryptoUsd: number;
  priorFiatDeposits: number;
  priorFiatUsd: number;
  priorDepositAverageUsd: number;
  currentVsAverageRatio: number | null;
};

export type FiatBehaviorEvidence = {
  observedHours: number;
  gameWagerUsd: number;
  gamePayoutUsd: number;
  rewardsUsd: number;
  gameEvents: number;
  withdrawalRequests: number;
  withdrawalUsd: number;
  minutesToFirstWithdrawal: number | null;
  playthroughRatio: number;
};

export type FiatAccountEvidence = {
  accountAgeDays: number;
  countryCode: string | null;
  kycRequired: boolean;
  kycStatus: string;
  kycAdminDecision: string;
  isBanned: boolean;
  isLocked: boolean;
  isSuspectedAlt: boolean;
  sharedDeviceUsers: number;
  sharedSignupIpUsers: number;
  fiatAttempts1h: number;
  fiatAttempts24h: number;
  failedFiatAttempts24h: number;
  priorDisputedFiat: number;
  priorRefundedFiat: number;
};

export type FiatScoreInput = {
  status: string;
  amountUsd: number;
  provider: FiatProviderEvidence;
  funding: FiatFundingEvidence;
  behavior: FiatBehaviorEvidence;
  account: FiatAccountEvidence;
};

export type FiatTimelineEvent = {
  id: string;
  type: string;
  label: string;
  detail: string | null;
  amountUsd: number;
  occurredAt: string;
  category:
    | "crypto_deposit"
    | "fiat_deposit"
    | "play"
    | "win"
    | "reward"
    | "withdrawal"
    | "account";
  tone: "good" | "neutral" | "warning" | "bad";
  isCurrent: boolean;
};

export type BlacklistedCheckoutEmail = {
  deposit_intent_id: string;
  checkout_email: string;
  domain: string;
  match_type: "blacklisted_domain" | "gmail_dot_fragmentation";
  lock_delivered_at: Date | null;
};

const GAME_WAGER_TYPES = [
  "pack_opening",
  "battle_bet",
  "battle_sponsorship",
  "keno_bet",
  "upgrader_bet",
];
const GAME_PAYOUT_TYPES = [
  "battle_refund",
  "battle_excess_to_voucher",
  "keno_payout",
  "upgrader_payout",
];
const REWARD_TYPES = [
  "deposit_bonus",
  "rakeback_claim",
  "gift_card_redeemed",
  "promo_code_redeemed",
  "race_prize",
  "rain_win",
  "waitlist_prize",
  "balance_reward_claim",
  "affiliate_claim",
  "affiliate_leaderboard_prize",
];

function addSignal(
  signals: FiatSignal[],
  signal: FiatSignal,
): void {
  if (!signals.some((entry) => entry.key === signal.key)) signals.push(signal);
}

function rounded(value: number): number {
  return Number(Math.max(0, value).toFixed(2));
}

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

const SAFE_WHOP_SIGNALS = new Set([
  "account_age_days",
  "fraud_decline_rate",
  "merch_txns_1h",
  "prior_dispute_count",
  "prior_fraud_declines",
  "prior_purchase_count",
  "prior_refund_count",
  "user_cards_7d",
  "user_payment_methods",
  "user_high_risk_sessions",
  "merch_decline_rate_1h",
  "proxy_level",
]);

function safePrimitive(value: unknown): string | number | boolean | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.slice(0, 80);
  return null;
}

export function parseWhopEvidence(
  payload: unknown,
  eventType: string | null,
  receivedAt: string | null,
): FiatProviderEvidence {
  const data = record(record(payload).data);
  const checkoutUser = record(data.user);
  const checkoutEmail =
    typeof checkoutUser.email === "string" &&
    checkoutUser.email.trim().length > 0 &&
    checkoutUser.email.trim().length <= 320 &&
    checkoutUser.email.includes("@")
      ? checkoutUser.email.trim()
      : null;
  const riskSignals = record(data.risk_signals);
  const signals = array(riskSignals.signals)
    .map((raw): WhopRiskSignal | null => {
      const item = record(raw);
      const key = typeof item.key === "string" ? item.key : "";
      if (!SAFE_WHOP_SIGNALS.has(key)) return null;
      return {
        key,
        category:
          typeof item.category === "string"
            ? item.category.slice(0, 40)
            : "provider",
        label:
          typeof item.label === "string"
            ? item.label.slice(0, 100)
            : key.replaceAll("_", " "),
        value: safePrimitive(item.value),
      };
    })
    .filter((item): item is WhopRiskSignal => item !== null);
  return {
    eventType,
    eventReceivedAt: receivedAt,
    checkoutEmail,
    threeDsVerified:
      typeof data.three_ds_verified === "boolean"
        ? data.three_ds_verified
        : null,
    riskScore: finiteNumber(data.risk_score),
    riskSignals: signals,
    disputeCount: array(data.disputes).length,
    refundCount: array(data.refunds).length,
    autoRefunded: data.auto_refunded === true,
    billingCountry:
      typeof record(data.billing_address).country === "string"
        ? String(record(data.billing_address).country).slice(0, 8)
        : null,
    paymentMethodType: whopPaymentMethodFromPayload(payload),
  };
}

function whopSignalNumber(
  provider: FiatProviderEvidence,
  key: string,
): number {
  return finiteNumber(
    provider.riskSignals.find((signal) => signal.key === key)?.value,
  ) ?? 0;
}

function whopSignalString(
  provider: FiatProviderEvidence,
  key: string,
): string {
  const value = provider.riskSignals.find((signal) => signal.key === key)?.value;
  return typeof value === "string" ? value.toLowerCase() : "";
}

export function scoreFiatDeposit(input: FiatScoreInput): {
  riskScore: number;
  verdict: FiatVerdict;
  recommendation: string;
  summary: string;
  signals: FiatSignal[];
  scoreBreakdown: FiatScoreBreakdown;
  flowChecks: FiatFlowCheck[];
} {
  const signals: FiatSignal[] = [];
  const paymentSucceeded = [
    "completed",
    "partially_refunded",
    "refunded",
    "disputed",
    "paid_unreconciled",
  ].includes(input.status);

  if (input.status === "paid_unreconciled") {
    addSignal(signals, {
      key: "payment_reconciliation_failed",
      label: "Paid but not reconciled",
      detail:
        "Whop confirmed this payment, but MAIN did not complete or credit the linked deposit intent.",
      points: 40,
      tone: "warning",
      category: "provider",
    });
  }

  if (input.status === "disputed" || input.provider.disputeCount > 0) {
    addSignal(signals, {
      key: "payment_disputed",
      label: "Dispute recorded",
      detail: "Whop reports a chargeback or payment dispute for this deposit.",
      points: 70,
      tone: "bad",
      category: "provider",
    });
  } else if (input.provider.autoRefunded) {
    addSignal(signals, {
      key: "auto_refunded",
      label: "Automatically refunded",
      detail: "Whop automatically refunded the payment after provider review.",
      points: 55,
      tone: "bad",
      category: "provider",
    });
  } else if (
    input.status === "refunded" ||
    input.status === "partially_refunded" ||
    input.provider.refundCount > 0
  ) {
    addSignal(signals, {
      key: "payment_refunded",
      label: "Refund activity",
      detail: "The payment has a full or partial refund in its Whop history.",
      points: 25,
      tone: "warning",
      category: "provider",
    });
  }

  if (input.provider.threeDsVerified === true) {
    addSignal(signals, {
      key: "three_ds_verified",
      label: "3DS verified",
      detail: "Whop confirms the cardholder completed 3D Secure.",
      points: 0,
      tone: "good",
      category: "provider",
    });
  } else if (paymentSucceeded && input.provider.threeDsVerified === false) {
    addSignal(signals, {
      key: "three_ds_failed",
      label: "3DS not verified",
      detail: "The completed payment does not have a successful 3DS result.",
      points: 25,
      tone: "bad",
      category: "provider",
    });
  }

  if (input.provider.riskScore !== null) {
    const score = Math.max(0, Math.min(100, input.provider.riskScore));
    const points = score >= 80 ? 30 : score >= 60 ? 20 : score >= 40 ? 10 : 0;
    addSignal(signals, {
      key: "whop_risk_score",
      label: "Whop risk score",
      detail: `Whop returned ${score}/100 for this payment.`,
      points,
      tone: points >= 30 ? "bad" : points > 0 ? "warning" : "good",
      category: "provider",
    });
  } else if (paymentSucceeded) {
    addSignal(signals, {
      key: "provider_evidence_missing",
      label: "Provider evidence missing",
      detail:
        "The payment completed, but no stored Whop risk score is linked to it.",
      points: 15,
      tone: "warning",
      category: "provider",
    });
  }

  const priorDisputes = Math.max(
    input.account.priorDisputedFiat,
    whopSignalNumber(input.provider, "prior_dispute_count"),
  );
  const priorFraudDeclines = whopSignalNumber(
    input.provider,
    "prior_fraud_declines",
  );
  const highRiskSessions = whopSignalNumber(
    input.provider,
    "user_high_risk_sessions",
  );
  if (priorDisputes > 0 || priorFraudDeclines > 0 || highRiskSessions > 0) {
    addSignal(signals, {
      key: "provider_history_risk",
      label: "Risky payment history",
      detail: `${priorDisputes} prior disputes, ${priorFraudDeclines} fraud declines, and ${highRiskSessions} high-risk sessions are reported.`,
      points: 15,
      tone: "warning",
      category: "provider",
    });
  }
  const proxyLevel = whopSignalString(input.provider, "proxy_level");
  if (proxyLevel && !["low", "none", "0"].includes(proxyLevel)) {
    addSignal(signals, {
      key: "provider_proxy_risk",
      label: "Proxy or VPN signal",
      detail: `Whop reports ${proxyLevel} proxy/VPN risk for the payment session.`,
      points: proxyLevel === "high" ? 15 : 8,
      tone: proxyLevel === "high" ? "bad" : "warning",
      category: "provider",
    });
  }

  const hasFundingHistory =
    input.funding.priorCryptoDeposits + input.funding.priorFiatDeposits > 0;
  if (input.funding.priorCryptoDeposits > 0) {
    addSignal(signals, {
      key: "known_crypto_history",
      label: "Known crypto funding",
      detail: `${input.funding.priorCryptoDeposits} earlier crypto deposits totaling $${input.funding.priorCryptoUsd.toFixed(2)} were found.`,
      points: 0,
      tone: "good",
      category: "funding",
    });
  }
  if (!hasFundingHistory) {
    addSignal(signals, {
      key: "first_funding_event",
      label: "First funding event",
      detail: "No earlier completed crypto or fiat deposit was found.",
      points: 8,
      tone: "neutral",
      category: "funding",
    });
  }
  if (
    input.amountUsd >= 100 &&
    input.funding.currentVsAverageRatio !== null &&
    input.funding.currentVsAverageRatio >= 4
  ) {
    addSignal(signals, {
      key: "deposit_size_spike",
      label: "Deposit size spike",
      detail: `This deposit is ${input.funding.currentVsAverageRatio.toFixed(1)}× the user's earlier average.`,
      points: 15,
      tone: "warning",
      category: "funding",
    });
  }

  if (input.account.fiatAttempts1h >= 4) {
    addSignal(signals, {
      key: "hourly_payment_velocity",
      label: "High hourly velocity",
      detail: `${input.account.fiatAttempts1h} fiat payment attempts were created within one hour.`,
      points: 20,
      tone: "bad",
      category: "velocity",
    });
  } else if (input.account.fiatAttempts24h >= 6) {
    addSignal(signals, {
      key: "daily_payment_velocity",
      label: "High daily velocity",
      detail: `${input.account.fiatAttempts24h} fiat payment attempts were created within 24 hours.`,
      points: 15,
      tone: "warning",
      category: "velocity",
    });
  }
  if (input.account.failedFiatAttempts24h >= 3) {
    addSignal(signals, {
      key: "repeated_failed_payments",
      label: "Repeated failures",
      detail: `${input.account.failedFiatAttempts24h} failed or cancelled fiat attempts occurred within 24 hours.`,
      points: 20,
      tone: "bad",
      category: "velocity",
    });
  }

  if (input.account.isBanned || input.account.isLocked) {
    addSignal(signals, {
      key: "restricted_account",
      label: "Restricted account",
      detail: "The customer account is currently banned or locked.",
      points: 50,
      tone: "bad",
      category: "account",
    });
  }
  if (input.account.isSuspectedAlt) {
    addSignal(signals, {
      key: "suspected_alt",
      label: "Suspected alternate account",
      detail: "The customer account is already marked as a suspected alt.",
      points: 25,
      tone: "bad",
      category: "account",
    });
  }
  if (input.account.accountAgeDays < 1) {
    addSignal(signals, {
      key: "new_account",
      label: "New account",
      detail: "The fiat attempt happened less than one day after signup.",
      points: 25,
      tone: "bad",
      category: "account",
    });
  } else if (input.account.accountAgeDays < 7) {
    addSignal(signals, {
      key: "young_account",
      label: "Young account",
      detail: "The fiat attempt happened during the first seven account days.",
      points: 12,
      tone: "warning",
      category: "account",
    });
  }
  if (
    input.account.kycStatus === "rejected" ||
    input.account.kycAdminDecision === "rejected"
  ) {
    addSignal(signals, {
      key: "kyc_rejected",
      label: "KYC rejected",
      detail: "The active KYC record is rejected.",
      points: 40,
      tone: "bad",
      category: "account",
    });
  } else if (
    input.account.kycRequired &&
    !["approved"].includes(input.account.kycStatus)
  ) {
    addSignal(signals, {
      key: "kyc_incomplete",
      label: "KYC incomplete",
      detail: "Verification is required but not provider-approved yet.",
      points: 15,
      tone: "warning",
      category: "account",
    });
  } else if (input.account.kycStatus === "approved") {
    addSignal(signals, {
      key: "kyc_approved",
      label: "KYC approved",
      detail: "The identity provider approved the current verification record.",
      points: 0,
      tone: "good",
      category: "account",
    });
  }

  if (input.account.sharedDeviceUsers > 0) {
    addSignal(signals, {
      key: "shared_device",
      label: "Device reused across accounts",
      detail: `${input.account.sharedDeviceUsers} other customer accounts share a known device.`,
      points: Math.min(70, 45 + input.account.sharedDeviceUsers * 10),
      tone: "bad",
      category: "network",
    });
  }
  if (input.account.sharedSignupIpUsers >= 3) {
    addSignal(signals, {
      key: "shared_signup_ip",
      label: "Shared signup IP",
      detail: `${input.account.sharedSignupIpUsers} other customer accounts used the same signup IP.`,
      points: Math.min(30, 15 + input.account.sharedSignupIpUsers * 2),
      tone: "warning",
      category: "network",
    });
  }

  if (
    input.behavior.withdrawalRequests > 0 &&
    input.behavior.minutesToFirstWithdrawal !== null &&
    input.behavior.minutesToFirstWithdrawal < 60 &&
    input.behavior.playthroughRatio < 0.1
  ) {
    addSignal(signals, {
      key: "rapid_fiat_cashout",
      label: "Rapid fiat cash-out",
      detail:
        "A withdrawal followed within one hour with less than 10% play-through.",
      points: 45,
      tone: "bad",
      category: "behavior",
    });
  } else if (
    input.behavior.withdrawalRequests > 0 &&
    input.behavior.minutesToFirstWithdrawal !== null &&
    input.behavior.minutesToFirstWithdrawal < 1_440 &&
    input.behavior.playthroughRatio < 0.25
  ) {
    addSignal(signals, {
      key: "low_playthrough_cashout",
      label: "Low play-through cash-out",
      detail:
        "A withdrawal followed within 24 hours with less than 25% play-through.",
      points: 25,
      tone: "warning",
      category: "behavior",
    });
  } else if (input.behavior.playthroughRatio >= 1) {
    addSignal(signals, {
      key: "full_playthrough",
      label: "Full play-through",
      detail: "Recorded wagers meet or exceed the credited fiat amount.",
      points: 0,
      tone: "good",
      category: "behavior",
    });
  }

  const scoreBreakdown: FiatScoreBreakdown = {
    provider: 0,
    funding: 0,
    velocity: 0,
    account: 0,
    network: 0,
    behavior: 0,
  };
  for (const signal of signals) {
    scoreBreakdown[signal.category] = Math.min(
      100,
      scoreBreakdown[signal.category] + signal.points,
    );
  }
  const riskScore = Math.min(
    100,
    Object.values(scoreBreakdown).reduce((total, value) => total + value, 0),
  );
  const verdict: FiatVerdict =
    riskScore >= 60 ? "bad" : riskScore >= 30 ? "review" : "good";
  const definitions: Array<{
    key: FiatRiskCategory;
    label: string;
    description: string;
  }> = [
    {
      key: "provider",
      label: "Whop checks",
      description: "Review Whop risk, 3DS, refunds, and disputes.",
    },
    {
      key: "funding",
      label: "Funding history",
      description: "Compare this deposit with earlier crypto and fiat funding.",
    },
    {
      key: "velocity",
      label: "Payment velocity",
      description: "Check repeated attempts and failures.",
    },
    {
      key: "account",
      label: "Account trust",
      description: "Check account age, restrictions, and KYC.",
    },
    {
      key: "network",
      label: "Network links",
      description: "Check shared devices and signup IPs.",
    },
    {
      key: "behavior",
      label: "Money movement",
      description: "Check play-through and cash-out behavior after funding.",
    },
  ];
  const flowChecks = definitions.map((definition): FiatFlowCheck => {
    const categorySignals = signals.filter(
      (signal) => signal.category === definition.key,
    );
    const score = scoreBreakdown[definition.key];
    return {
      ...definition,
      status: score >= 40 ? "block" : score > 0 ? "review" : "pass",
      score,
      evidence:
        categorySignals.length > 0
          ? categorySignals.map((signal) => signal.detail)
          : ["No risk signal triggered for this check."],
    };
  });
  const primary = [...signals]
    .filter((signal) => signal.points > 0)
    .sort((a, b) => b.points - a.points)[0];
  const summary =
    primary?.detail ??
    "Whop, funding history, account trust, and post-deposit behavior are consistent.";
  const recommendation =
    input.status === "paid_unreconciled"
      ? "Reconcile the successful Whop payment before closing this review."
      : verdict === "bad"
      ? "Hold withdrawals and complete an analyst review."
      : verdict === "review"
        ? "Review before allowing value to leave the account."
        : paymentSucceeded
          ? "No fraud hold recommended."
          : "Wait for final Whop payment evidence.";
  return {
    riskScore,
    verdict,
    recommendation,
    summary,
    signals,
    scoreBreakdown,
    flowChecks,
  };
}

export function applyBlacklistedCheckoutEmail(
  scored: ReturnType<typeof scoreFiatDeposit>,
  match: BlacklistedCheckoutEmail,
): ReturnType<typeof scoreFiatDeposit> {
  const patternMatch = match.match_type === "gmail_dot_fragmentation";
  const signal: FiatSignal = {
    key: patternMatch
      ? "suspicious_checkout_email_pattern"
      : "blacklisted_checkout_email_domain",
    label: patternMatch
      ? "Suspicious checkout email"
      : "Blacklisted checkout email",
    detail: patternMatch
      ? `Whop checkout used ${match.checkout_email}; its Gmail local part is heavily dot-fragmented.`
      : `Whop checkout used ${match.checkout_email}; ${match.domain} is on the active email-domain blacklist.`,
    points: 100,
    tone: "bad",
    category: "provider",
  };
  return {
    ...scored,
    riskScore: 100,
    verdict: "bad",
    recommendation:
      "Keep crypto and item withdrawals locked and review the checkout identity.",
    summary: patternMatch
      ? "Critical: the Whop checkout email matched the dot-fragmentation fraud pattern."
      : "Critical: the Whop checkout email matched an active blocked domain.",
    signals: [
      signal,
      ...scored.signals.filter((entry) => entry.key !== signal.key),
    ],
    scoreBreakdown: {
      ...scored.scoreBreakdown,
      provider: 100,
    },
    flowChecks: scored.flowChecks.map((check) =>
      check.key === "provider"
        ? {
            ...check,
            status: "block" as const,
            score: 100,
            evidence: [
              patternMatch
                ? "Blocked checkout pattern: dot-fragmented Gmail"
                : `Blocked checkout domain: ${match.domain}`,
              match.lock_delivered_at
                ? "Crypto and item withdrawal lock confirmed"
                : "Automatic withdrawal lock is pending confirmation",
              ...check.evidence,
            ],
          }
        : check,
    ),
  };
}

async function loadBlacklistedCheckoutEmails(
  antifraud: Pool,
  intentIds: string[],
): Promise<Map<string, BlacklistedCheckoutEmail>> {
  if (intentIds.length === 0) return new Map();
  const result = await antifraud.query<BlacklistedCheckoutEmail>(
    `
      SELECT DISTINCT ON (deposit_intent_id)
        deposit_intent_id,
        checkout_email,
        domain,
        match_type,
        lock_delivered_at
      FROM fiat_email_domain_matches
      WHERE deposit_intent_id = ANY($1::text[])
      ORDER BY deposit_intent_id, occurred_at DESC
    `,
    [intentIds],
  );
  return new Map(result.rows.map((row) => [row.deposit_intent_id, row]));
}

type SourceFiatIntent = {
  id: string;
  user_id: string;
  username: string | null;
  email: string | null;
  image: string | null;
  account_created_at: string;
  country_code: string | null;
  is_banned: boolean;
  is_locked: boolean;
  is_suspected_alt: boolean;
  kyc_required: boolean;
  kyc_status: string;
  kyc_admin_decision: string;
  provider: string;
  currency: string;
  requested_amount_cents: number;
  credited_amount_cents: number;
  actual_customer_total_cents: number | null;
  provider_net_amount_cents: number | null;
  status: string;
  provider_payment_status: string | null;
  provider_checkout_id: string | null;
  provider_payment_id: string | null;
  completed_ledger_id: string | null;
  paid_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

type ContextRow = {
  intent_id: string;
  prior_crypto_deposits: number;
  prior_crypto_usd: string;
  prior_fiat_deposits: number;
  prior_fiat_usd: string;
  prior_deposit_average_usd: string;
  fiat_attempts_1h: number;
  fiat_attempts_24h: number;
  failed_fiat_attempts_24h: number;
  prior_disputed_fiat: number;
  prior_refunded_fiat: number;
  game_wager_usd: string;
  game_payout_usd: string;
  rewards_usd: string;
  game_events: number;
  withdrawal_requests: number;
  withdrawal_usd: string;
  first_withdrawal_at: string | null;
};

type NetworkRow = {
  user_id: string;
  shared_device_users: number;
  shared_signup_ip_users: number;
};

type WebhookRow = {
  provider_resource_id: string;
  event_type: string;
  payload: unknown;
  received_at: string;
};

function intentTime(intent: SourceFiatIntent): Date {
  return new Date(
    intent.completed_at ??
      intent.paid_at ??
      intent.created_at,
  );
}

async function loadContexts(
  source: Pool,
  intents: SourceFiatIntent[],
): Promise<Map<string, ContextRow>> {
  if (intents.length === 0) return new Map();
  const result = await source.query<ContextRow>(
    `
      WITH targets AS (
        SELECT *
        FROM unnest(
          $1::uuid[],
          $2::text[],
          $3::timestamptz[],
          $4::timestamptz[]
        ) AS t(intent_id, user_id, occurred_at, created_at)
      )
      SELECT
        t.intent_id::text,
        COALESCE(prior.prior_crypto_deposits, 0)::int AS prior_crypto_deposits,
        COALESCE(prior.prior_crypto_usd, 0)::text AS prior_crypto_usd,
        COALESCE(prior.prior_fiat_deposits, 0)::int AS prior_fiat_deposits,
        COALESCE(prior.prior_fiat_usd, 0)::text AS prior_fiat_usd,
        COALESCE(prior.prior_deposit_average_usd, 0)::text
          AS prior_deposit_average_usd,
        COALESCE(velocity.fiat_attempts_1h, 0)::int AS fiat_attempts_1h,
        COALESCE(velocity.fiat_attempts_24h, 0)::int AS fiat_attempts_24h,
        COALESCE(velocity.failed_fiat_attempts_24h, 0)::int
          AS failed_fiat_attempts_24h,
        COALESCE(velocity.prior_disputed_fiat, 0)::int AS prior_disputed_fiat,
        COALESCE(velocity.prior_refunded_fiat, 0)::int AS prior_refunded_fiat,
        COALESCE(activity.game_wager_usd, 0)::text AS game_wager_usd,
        COALESCE(activity.game_payout_usd, 0)::text AS game_payout_usd,
        COALESCE(activity.rewards_usd, 0)::text AS rewards_usd,
        COALESCE(activity.game_events, 0)::int AS game_events,
        COALESCE(cashout.withdrawal_requests, 0)::int AS withdrawal_requests,
        COALESCE(cashout.withdrawal_usd, 0)::text AS withdrawal_usd,
        cashout.first_withdrawal_at
      FROM targets t
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) FILTER (
            WHERE prior_fiat.id IS NULL
              AND (
                lt.crypto_asset IS NOT NULL
                OR lt.blockchain_tx_hash IS NOT NULL
                OR lt.fireblocks_tx_id IS NOT NULL
              )
          ) AS prior_crypto_deposits,
          COALESCE(SUM(ABS(lt.amount::numeric)) FILTER (
            WHERE prior_fiat.id IS NULL
              AND (
                lt.crypto_asset IS NOT NULL
                OR lt.blockchain_tx_hash IS NOT NULL
                OR lt.fireblocks_tx_id IS NOT NULL
              )
          ), 0) AS prior_crypto_usd,
          COUNT(*) FILTER (WHERE prior_fiat.id IS NOT NULL)
            AS prior_fiat_deposits,
          COALESCE(SUM(ABS(lt.amount::numeric)) FILTER (
            WHERE prior_fiat.id IS NOT NULL
          ), 0) AS prior_fiat_usd,
          COALESCE(AVG(ABS(lt.amount::numeric)), 0)
            AS prior_deposit_average_usd
        FROM ledger_transactions lt
        LEFT JOIN fiat_deposit_intents prior_fiat
          ON prior_fiat.completed_ledger_id=lt.id
        WHERE lt.user_id=t.user_id
          AND lt.type='deposit'
          AND lt.status='completed'
          AND lt.created_at<t.occurred_at
      ) prior ON TRUE
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) FILTER (
            WHERE f.created_at>=t.created_at-interval '1 hour'
          ) AS fiat_attempts_1h,
          COUNT(*) FILTER (
            WHERE f.created_at>=t.created_at-interval '24 hours'
          ) AS fiat_attempts_24h,
          COUNT(*) FILTER (
            WHERE f.created_at>=t.created_at-interval '24 hours'
              AND f.status IN ('failed','canceled')
          ) AS failed_fiat_attempts_24h,
          COUNT(*) FILTER (
            WHERE f.created_at<t.created_at AND f.status='disputed'
          ) AS prior_disputed_fiat,
          COUNT(*) FILTER (
            WHERE f.created_at<t.created_at
              AND f.status IN ('refunded','partially_refunded')
          ) AS prior_refunded_fiat
        FROM fiat_deposit_intents f
        WHERE f.user_id=t.user_id
          AND f.created_at<=t.created_at
      ) velocity ON TRUE
      LEFT JOIN LATERAL (
        SELECT
          COALESCE(SUM(ABS(lt.amount::numeric)) FILTER (
            WHERE lt.type::text=ANY($5::text[])
          ), 0) AS game_wager_usd,
          COALESCE(SUM(ABS(lt.amount::numeric)) FILTER (
            WHERE lt.type::text=ANY($6::text[])
          ), 0) AS game_payout_usd,
          COALESCE(SUM(ABS(lt.amount::numeric)) FILTER (
            WHERE lt.type::text=ANY($7::text[])
          ), 0) AS rewards_usd,
          COUNT(*) FILTER (
            WHERE lt.type::text=ANY($5::text[])
               OR lt.type::text=ANY($6::text[])
          ) AS game_events
        FROM ledger_transactions lt
        WHERE lt.user_id=t.user_id
          AND lt.status='completed'
          AND lt.created_at>=t.occurred_at
          AND (
            lt.type::text=ANY($5::text[])
            OR lt.type::text=ANY($6::text[])
            OR lt.type::text=ANY($7::text[])
          )
      ) activity ON TRUE
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) AS withdrawal_requests,
          COALESCE(SUM(total_value_usd::numeric), 0) AS withdrawal_usd,
          MIN(requested_at) AS first_withdrawal_at
        FROM card_withdrawal_requests cwr
        WHERE cwr.user_id=t.user_id
          AND cwr.requested_at>=t.occurred_at
      ) cashout ON TRUE
    `,
    [
      intents.map((intent) => intent.id),
      intents.map((intent) => intent.user_id),
      intents.map((intent) => intentTime(intent).toISOString()),
      intents.map((intent) => new Date(intent.created_at).toISOString()),
      GAME_WAGER_TYPES,
      GAME_PAYOUT_TYPES,
      REWARD_TYPES,
    ],
  );
  return new Map(result.rows.map((row) => [row.intent_id, row]));
}

async function loadNetworks(
  source: Pool,
  userIds: string[],
): Promise<Map<string, NetworkRow>> {
  if (userIds.length === 0) return new Map();
  const result = await source.query<NetworkRow>(
    `
      SELECT
        u.id AS user_id,
        (
          SELECT COUNT(DISTINCT other.user_id)::int
          FROM fingerprints mine
          JOIN fingerprints other
            ON other.visitor_id=mine.visitor_id
           AND other.user_id IS NOT NULL
           AND other.user_id<>mine.user_id
          WHERE mine.user_id=u.id
        ) AS shared_device_users,
        CASE
          WHEN NULLIF(u.signup_ip, '') IS NULL THEN 0
          ELSE (
            SELECT GREATEST(COUNT(DISTINCT peer.id)-1, 0)::int
            FROM "user" peer
            WHERE peer.signup_ip=u.signup_ip
          )
        END AS shared_signup_ip_users
      FROM "user" u
      WHERE u.id=ANY($1::text[])
    `,
    [[...new Set(userIds)]],
  );
  return new Map(result.rows.map((row) => [row.user_id, row]));
}

async function loadProviderEvidence(
  source: Pool,
  intents: SourceFiatIntent[],
): Promise<Map<string, FiatProviderEvidence>> {
  const resourceToIntent = new Map<string, string>();
  for (const intent of intents) {
    if (intent.provider_checkout_id) {
      resourceToIntent.set(intent.provider_checkout_id, intent.id);
    }
    if (intent.provider_payment_id) {
      resourceToIntent.set(intent.provider_payment_id, intent.id);
    }
  }
  const resourceIds = [...resourceToIntent.keys()];
  if (resourceIds.length === 0) return new Map();
  const result = await source.query<WebhookRow>(
    `
      SELECT provider_resource_id, event_type, payload, received_at
      FROM payment_webhook_events
      WHERE provider='whop'
        AND provider_resource_id=ANY($1::text[])
      ORDER BY received_at DESC, id DESC
    `,
    [resourceIds],
  );
  const byIntent = new Map<string, WebhookRow[]>();
  for (const row of result.rows) {
    const intentId = resourceToIntent.get(row.provider_resource_id);
    if (!intentId) continue;
    const rows = byIntent.get(intentId) ?? [];
    rows.push(row);
    byIntent.set(intentId, rows);
  }
  const output = new Map<string, FiatProviderEvidence>();
  for (const [intentId, rows] of byIntent) {
    const selected =
      rows.find((row) => row.event_type === "payment.succeeded") ?? rows[0];
    if (!selected) continue;
    const evidence = parseWhopEvidence(
      selected.payload,
      selected.event_type,
      new Date(selected.received_at).toISOString(),
    );
    evidence.checkoutEmail ??= rows
      .map((row) =>
        parseWhopEvidence(
          row.payload,
          row.event_type,
          new Date(row.received_at).toISOString(),
        ),
      )
      .find((candidate) => candidate.checkoutEmail !== null)
      ?.checkoutEmail ?? null;
    output.set(intentId, evidence);
  }
  return output;
}

const EMPTY_PROVIDER: FiatProviderEvidence = {
  eventType: null,
  eventReceivedAt: null,
  checkoutEmail: null,
  threeDsVerified: null,
  riskScore: null,
  riskSignals: [],
  disputeCount: 0,
  refundCount: 0,
  autoRefunded: false,
  billingCountry: null,
  paymentMethodType: null,
};

function contextFunding(
  context: ContextRow | undefined,
  amountUsd: number,
): FiatFundingEvidence {
  const average = finiteNumber(context?.prior_deposit_average_usd) ?? 0;
  return {
    priorCryptoDeposits: context?.prior_crypto_deposits ?? 0,
    priorCryptoUsd: rounded(finiteNumber(context?.prior_crypto_usd) ?? 0),
    priorFiatDeposits: context?.prior_fiat_deposits ?? 0,
    priorFiatUsd: rounded(finiteNumber(context?.prior_fiat_usd) ?? 0),
    priorDepositAverageUsd: rounded(average),
    currentVsAverageRatio:
      average > 0 ? Number((amountUsd / average).toFixed(2)) : null,
  };
}

function contextBehavior(
  context: ContextRow | undefined,
  amountUsd: number,
  occurredAt: Date,
): FiatBehaviorEvidence {
  const gameWagerUsd = rounded(
    finiteNumber(context?.game_wager_usd) ?? 0,
  );
  const firstWithdrawalAt = context?.first_withdrawal_at
    ? new Date(context.first_withdrawal_at)
    : null;
  return {
    observedHours: Number(
      (Math.max(0, Date.now() - occurredAt.getTime()) / 3_600_000).toFixed(1),
    ),
    gameWagerUsd,
    gamePayoutUsd: rounded(
      finiteNumber(context?.game_payout_usd) ?? 0,
    ),
    rewardsUsd: rounded(finiteNumber(context?.rewards_usd) ?? 0),
    gameEvents: context?.game_events ?? 0,
    withdrawalRequests: context?.withdrawal_requests ?? 0,
    withdrawalUsd: rounded(
      finiteNumber(context?.withdrawal_usd) ?? 0,
    ),
    minutesToFirstWithdrawal: firstWithdrawalAt
      ? Math.max(
          0,
          Number(
            (
              (firstWithdrawalAt.getTime() - occurredAt.getTime()) /
              60_000
            ).toFixed(1),
          ),
        )
      : null,
    playthroughRatio:
      amountUsd > 0 ? Number((gameWagerUsd / amountUsd).toFixed(3)) : 0,
  };
}

export const FIAT_ASSESSMENT_STATUSES = [
  "completed",
  "partially_refunded",
  "refunded",
  "disputed",
  "paid_unreconciled",
] as const;

type FiatAssessmentStatus = (typeof FIAT_ASSESSMENT_STATUSES)[number];

export class FiatRiskService {
  constructor(private readonly db: Databases) {}

  async refresh(input: {
    status?: FiatAssessmentStatus;
    search?: string;
    excludedUserIds?: string[];
    limit?: number;
  }): Promise<{ ids: string[] }> {
    const settledStatuses = FIAT_ASSESSMENT_STATUSES.slice(0, -1);
    const values: unknown[] = [settledStatuses];
    const conditions = [
      `COALESCE(u.role::text,'')<>'creator'`,
      `'creator'<>ALL(COALESCE(u.roles::text[], ARRAY[]::text[]))`,
    ];
    if (input.excludedUserIds?.length) {
      values.push(input.excludedUserIds);
      conditions.push(`fdi.user_id<>ALL($${values.length}::text[])`);
    }
    if (input.status === "paid_unreconciled") {
      conditions.push(
        `paid.provider_resource_id IS NOT NULL
         AND fdi.status::text<>ALL($1::text[])`,
      );
    } else if (input.status) {
      values.push(input.status);
      conditions.push(`fdi.status::text=$${values.length}`);
    } else {
      conditions.push(
        `(fdi.status::text=ANY($1::text[])
          OR paid.provider_resource_id IS NOT NULL)`,
      );
    }
    if (input.search) {
      values.push(`%${input.search.toLowerCase()}%`);
      conditions.push(`(
        lower(fdi.id::text) LIKE $${values.length}
        OR lower(fdi.user_id) LIKE $${values.length}
        OR lower(COALESCE(u.username,'')) LIKE $${values.length}
        OR lower(COALESCE(u.email,'')) LIKE $${values.length}
        OR lower(COALESCE(fdi.provider_payment_id,'')) LIKE $${values.length}
      )`);
    }
    values.push(Math.min(100, Math.max(1, input.limit ?? 100)));
    const result = await this.db.source.query<SourceFiatIntent>(
      `
        WITH paid_unreconciled AS (
          SELECT DISTINCT ON (
            payload#>>'{data,metadata,deposit_intent_id}'
          )
            payload#>>'{data,metadata,deposit_intent_id}' AS intent_id,
            provider_resource_id,
            payload,
            received_at
          FROM payment_webhook_events
          WHERE provider='whop'
            AND event_type='payment.succeeded'
            AND processing_status='failed'
            AND received_at >=
              (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '30 days'
            AND COALESCE(
              payload#>>'{data,metadata,deposit_intent_id}',
              ''
            ) <> ''
          ORDER BY
            payload#>>'{data,metadata,deposit_intent_id}',
            received_at DESC,
            id DESC
        )
        SELECT
          fdi.id::text, fdi.user_id, u.username, u.email, u.image,
          u.created_at AS account_created_at, u.country_code,
          u.is_banned, u.is_locked, u.is_suspected_alt,
          COALESCE(kyc.kyc_required, false) AS kyc_required,
          COALESCE(kyc.status::text, 'none') AS kyc_status,
          COALESCE(kyc.admin_decision::text, 'pending')
            AS kyc_admin_decision,
          fdi.provider, fdi.currency, fdi.requested_amount_cents,
          fdi.credited_amount_cents, fdi.actual_customer_total_cents,
          fdi.provider_net_amount_cents,
          CASE
            WHEN paid.provider_resource_id IS NOT NULL
              AND fdi.status::text<>ALL($1::text[])
              THEN 'paid_unreconciled'
            ELSE fdi.status::text
          END AS status,
          CASE
            WHEN paid.provider_resource_id IS NOT NULL
              AND fdi.status::text<>ALL($1::text[])
              THEN COALESCE(
                paid.payload#>>'{data,status}',
                'paid'
              )
            ELSE fdi.provider_payment_status
          END AS provider_payment_status,
          fdi.provider_checkout_id,
          CASE
            WHEN paid.provider_resource_id IS NOT NULL
              AND fdi.status::text<>ALL($1::text[])
              THEN paid.provider_resource_id
            ELSE fdi.provider_payment_id
          END AS provider_payment_id,
          fdi.completed_ledger_id::text,
          CASE
            WHEN paid.provider_resource_id IS NOT NULL
              AND fdi.status::text<>ALL($1::text[])
              -- Keep the source-native timestamp convention used by the
              -- intent lifecycle columns so mixed rows sort consistently.
              THEN paid.received_at
            ELSE fdi.paid_at
          END AS paid_at,
          fdi.completed_at,
          fdi.created_at,
          GREATEST(fdi.updated_at, paid.received_at) AS updated_at
        FROM fiat_deposit_intents fdi
        JOIN "user" u ON u.id=fdi.user_id
        LEFT JOIN user_kyc kyc ON kyc.user_id=fdi.user_id
        LEFT JOIN paid_unreconciled paid ON paid.intent_id=fdi.id::text
        WHERE ${conditions.join(" AND ")}
        ORDER BY fdi.created_at DESC, fdi.id DESC
        LIMIT $${values.length}
      `,
      values,
    );
    const intents = result.rows;
    if (intents.length === 0) return { ids: [] };
    // Keep this refresh on one mirror connection at a time. The read-only
    // fraud role has a deliberately small connection budget shared with the
    // live monitor, so a page load must not fan out three new sessions.
    const contexts = await loadContexts(this.db.source, intents);
    const networks = await loadNetworks(
      this.db.source,
      intents.map((intent) => intent.user_id),
    );
    const providers = await loadProviderEvidence(this.db.source, intents);
    const blacklistedCheckoutEmails = await loadBlacklistedCheckoutEmails(
      this.db.antifraud,
      intents.map((intent) => intent.id),
    );

    const assessments = intents.map((intent) => {
      const amountUsd = intent.credited_amount_cents / 100;
      const occurredAt = intentTime(intent);
      const context = contexts.get(intent.id);
      const network = networks.get(intent.user_id);
      const provider = providers.get(intent.id) ?? EMPTY_PROVIDER;
      const funding = contextFunding(context, amountUsd);
      const behavior = contextBehavior(
        context,
        amountUsd,
        occurredAt,
      );
      const account: FiatAccountEvidence = {
        accountAgeDays: Math.max(
          0,
          Number(
            (
              (occurredAt.getTime() -
                new Date(intent.account_created_at).getTime()) /
              86_400_000
            ).toFixed(1),
          ),
        ),
        countryCode: intent.country_code,
        kycRequired: intent.kyc_required,
        kycStatus: intent.kyc_status,
        kycAdminDecision: intent.kyc_admin_decision,
        isBanned: intent.is_banned,
        isLocked: intent.is_locked,
        isSuspectedAlt: intent.is_suspected_alt,
        sharedDeviceUsers: network?.shared_device_users ?? 0,
        sharedSignupIpUsers: network?.shared_signup_ip_users ?? 0,
        fiatAttempts1h: context?.fiat_attempts_1h ?? 0,
        fiatAttempts24h: context?.fiat_attempts_24h ?? 0,
        failedFiatAttempts24h:
          context?.failed_fiat_attempts_24h ?? 0,
        priorDisputedFiat: context?.prior_disputed_fiat ?? 0,
        priorRefundedFiat: context?.prior_refunded_fiat ?? 0,
      };
      const baseScore = scoreFiatDeposit({
        status: intent.status,
        amountUsd,
        provider,
        funding,
        behavior,
        account,
      });
      const blacklistedCheckoutEmail = blacklistedCheckoutEmails.get(intent.id);
      const scored = blacklistedCheckoutEmail
        ? applyBlacklistedCheckoutEmail(baseScore, blacklistedCheckoutEmail)
        : baseScore;
      return {
        intent,
        occurredAt,
        provider,
        funding,
        behavior,
        account,
        ...scored,
      };
    });

    const client = await this.db.antifraud.connect();
    try {
      await client.query("BEGIN");
      for (const assessment of assessments) {
        const { intent } = assessment;
        await client.query(
          `
            INSERT INTO fiat_deposit_assessments(
              deposit_intent_id, user_id, username, email, avatar_url,
              provider, provider_payment_status, status, currency,
              requested_amount_usd, credited_amount_usd, customer_total_usd,
              provider_net_usd, occurred_at, source_updated_at,
              provider_risk_score, three_ds_verified, risk_score, verdict,
              recommendation, summary, signals, provider_evidence,
              funding_evidence, behavior_evidence, account_evidence,
              score_breakdown, flow_checks, score_version, assessed_at
            ) VALUES (
              $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
              $16,$17,$18,$19,$20,$21,$22::jsonb,$23::jsonb,$24::jsonb,
              $25::jsonb,$26::jsonb,$27::jsonb,$28::jsonb,'fiat-v1',now()
            )
            ON CONFLICT (deposit_intent_id) DO UPDATE SET
              user_id=EXCLUDED.user_id,
              username=EXCLUDED.username,
              email=EXCLUDED.email,
              avatar_url=EXCLUDED.avatar_url,
              provider=EXCLUDED.provider,
              provider_payment_status=EXCLUDED.provider_payment_status,
              status=EXCLUDED.status,
              currency=EXCLUDED.currency,
              requested_amount_usd=EXCLUDED.requested_amount_usd,
              credited_amount_usd=EXCLUDED.credited_amount_usd,
              customer_total_usd=EXCLUDED.customer_total_usd,
              provider_net_usd=EXCLUDED.provider_net_usd,
              occurred_at=EXCLUDED.occurred_at,
              source_updated_at=EXCLUDED.source_updated_at,
              provider_risk_score=EXCLUDED.provider_risk_score,
              three_ds_verified=EXCLUDED.three_ds_verified,
              risk_score=EXCLUDED.risk_score,
              verdict=EXCLUDED.verdict,
              recommendation=EXCLUDED.recommendation,
              summary=EXCLUDED.summary,
              signals=EXCLUDED.signals,
              provider_evidence=EXCLUDED.provider_evidence,
              funding_evidence=EXCLUDED.funding_evidence,
              behavior_evidence=EXCLUDED.behavior_evidence,
              account_evidence=EXCLUDED.account_evidence,
              score_breakdown=EXCLUDED.score_breakdown,
              flow_checks=EXCLUDED.flow_checks,
              score_version='fiat-v1',
              assessed_at=now()
          `,
          [
            intent.id,
            intent.user_id,
            intent.username,
            intent.email,
            intent.image,
            intent.provider,
            intent.provider_payment_status,
            intent.status,
            intent.currency,
            intent.requested_amount_cents / 100,
            intent.credited_amount_cents / 100,
            intent.actual_customer_total_cents === null
              ? null
              : intent.actual_customer_total_cents / 100,
            intent.provider_net_amount_cents === null
              ? null
              : intent.provider_net_amount_cents / 100,
            assessment.occurredAt.toISOString(),
            intent.updated_at,
            assessment.provider.riskScore,
            assessment.provider.threeDsVerified,
            assessment.riskScore,
            assessment.verdict,
            assessment.recommendation,
            assessment.summary,
            JSON.stringify(assessment.signals),
            JSON.stringify(assessment.provider),
            JSON.stringify(assessment.funding),
            JSON.stringify(assessment.behavior),
            JSON.stringify(assessment.account),
            JSON.stringify(assessment.scoreBreakdown),
            JSON.stringify(assessment.flowChecks),
          ],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return { ids: intents.map((intent) => intent.id) };
  }

  async loadTimeline(input: {
    intentId: string;
    userId: string;
    occurredAt: string;
    amountUsd: number;
  }): Promise<FiatTimelineEvent[]> {
    const ledger = await this.db.source.query<{
      id: string;
      type: string;
      amount_usd: string;
      description: string | null;
      created_at: string;
      is_fiat: boolean;
      is_crypto: boolean;
    }>(
      `
        WITH prior_deposits AS (
          SELECT lt.id, lt.type::text, ABS(lt.amount::numeric)::text amount_usd,
                 lt.description, lt.created_at,
                 (fdi.id IS NOT NULL) AS is_fiat,
                 (
                   fdi.id IS NULL
                   AND (
                     lt.crypto_asset IS NOT NULL
                     OR lt.blockchain_tx_hash IS NOT NULL
                     OR lt.fireblocks_tx_id IS NOT NULL
                   )
                 ) AS is_crypto
          FROM ledger_transactions lt
          LEFT JOIN fiat_deposit_intents fdi ON fdi.completed_ledger_id=lt.id
          WHERE lt.user_id=$1
            AND lt.type='deposit'
            AND lt.status='completed'
            AND lt.created_at<$2::timestamptz
          ORDER BY lt.created_at DESC, lt.id DESC
          LIMIT 8
        ),
        after_deposit AS (
          SELECT lt.id, lt.type::text, ABS(lt.amount::numeric)::text amount_usd,
                 lt.description, lt.created_at,
                 (fdi.id IS NOT NULL) AS is_fiat,
                 (
                   fdi.id IS NULL
                   AND (
                     lt.crypto_asset IS NOT NULL
                     OR lt.blockchain_tx_hash IS NOT NULL
                     OR lt.fireblocks_tx_id IS NOT NULL
                   )
                 ) AS is_crypto
          FROM ledger_transactions lt
          LEFT JOIN fiat_deposit_intents fdi ON fdi.completed_ledger_id=lt.id
          WHERE lt.user_id=$1
            AND lt.status='completed'
            AND lt.created_at>=$2::timestamptz
          ORDER BY lt.created_at, lt.id
          LIMIT 100
        )
        SELECT id::text, type, amount_usd, description, created_at,
               is_fiat, is_crypto
        FROM prior_deposits
        UNION ALL
        SELECT id::text, type, amount_usd, description, created_at,
               is_fiat, is_crypto
        FROM after_deposit
        ORDER BY created_at, id
      `,
      [input.userId, input.occurredAt],
    );
    const withdrawals = await this.db.source.query<{
      id: string;
      amount_usd: string;
      status: string;
      requested_at: string;
    }>(
      `
        SELECT id::text, total_value_usd::text AS amount_usd,
               status::text, requested_at
        FROM card_withdrawal_requests
        WHERE user_id=$1 AND requested_at>=$2::timestamptz
        ORDER BY requested_at, id
        LIMIT 30
      `,
      [input.userId, input.occurredAt],
    );
    const events: FiatTimelineEvent[] = ledger.rows.map((row) => {
      if (row.type === "deposit") {
        return {
          id: row.id,
          type: row.is_fiat ? "fiat_deposit" : "crypto_deposit",
          label: row.is_fiat ? "Fiat deposit completed" : "Crypto deposit completed",
          detail: row.is_crypto ? "Blockchain funding" : "Whop card funding",
          amountUsd: rounded(finiteNumber(row.amount_usd) ?? 0),
          occurredAt: new Date(row.created_at).toISOString(),
          category: row.is_fiat ? "fiat_deposit" : "crypto_deposit",
          tone: "good",
          isCurrent: false,
        };
      }
      const isWager = GAME_WAGER_TYPES.includes(row.type);
      const isPayout = GAME_PAYOUT_TYPES.includes(row.type);
      const isReward = REWARD_TYPES.includes(row.type);
      return {
        id: row.id,
        type: row.type,
        label: row.type.replaceAll("_", " "),
        detail: row.description,
        amountUsd: rounded(finiteNumber(row.amount_usd) ?? 0),
        occurredAt: new Date(row.created_at).toISOString(),
        category: isWager
          ? "play"
          : isPayout
            ? "win"
            : isReward
              ? "reward"
              : "account",
        tone: isWager ? "good" : isPayout || isReward ? "warning" : "neutral",
        isCurrent: false,
      };
    });
    events.push({
      id: `fiat:${input.intentId}`,
      type: "fiat_deposit_assessed",
      label: "Current Whop fiat deposit",
      detail: "This is the deposit under fraud review.",
      amountUsd: input.amountUsd,
      occurredAt: new Date(input.occurredAt).toISOString(),
      category: "fiat_deposit",
      tone: "neutral",
      isCurrent: true,
    });
    events.push(
      ...withdrawals.rows.map(
        (row): FiatTimelineEvent => ({
          id: `withdrawal:${row.id}`,
          type: "withdrawal_requested",
          label: `Withdrawal ${row.status}`,
          detail: "A payout request followed this fiat deposit.",
          amountUsd: rounded(finiteNumber(row.amount_usd) ?? 0),
          occurredAt: new Date(row.requested_at).toISOString(),
          category: "withdrawal",
          tone: "bad",
          isCurrent: false,
        }),
      ),
    );
    return events
      .sort(
        (a, b) =>
          new Date(a.occurredAt).getTime() -
          new Date(b.occurredAt).getTime(),
      )
      .slice(-140);
  }
}
