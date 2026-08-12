import type { FastifyBaseLogger } from "fastify";
import type pg from "pg";

import type { Config } from "./config.js";
import type { Databases } from "./db.js";
import {
  sanitizeDiscordMentions,
  type DiscordWebhookPayload,
} from "./discord.js";
import {
  notificationRoutesForFiatProblem,
  type FiatNotificationRouteKey,
} from "./notification-routes.js";
import { sendBotDiscordEvent } from "./discord-events.js";
import { drainOutbox } from "./outbox.js";
import { whopPaymentMethodLabel } from "./whop-payment-method.js";

const CURSOR_STREAM = "fiat-problems";
const HIGH_RISK_CURSOR_STREAM = "fiat-high-risk";
const FAILED_WEBHOOK_CURSOR_STREAM = "fiat-failed-webhooks";
const BATCH_SIZE = 100;
const DELIVERY_BATCH_SIZE = 8;
// A targeted risk refresh may wait on MaxMind. Keep one external-provider job
// per serialized monitor tick so a deposit burst cannot multiply that timeout
// and delay every unrelated antifraud phase behind it.
const REVIEW_CLASSIFICATION_BATCH_SIZE = 1;
const UTC = "AT TIME ZONE 'UTC'";

export type FiatReviewRiskClassifier = {
  refreshIntent(intentId: string): Promise<boolean>;
};

export const FIAT_PROBLEM_CODES = [
  "high_risk",
  "fiat_locked_account",
  "failed",
  "review",
  "disputed",
  "partially_refunded",
  "refunded",
  "checkout_creating_stale",
  "pending_stale",
  "webhook_failed",
  "blacklisted_email_domain",
  "suspicious_deposit_cluster",
  "fiat_identity_drift",
  "whop_history_auto_ban",
] as const;

export type FiatProblemCode = (typeof FIAT_PROBLEM_CODES)[number];

export const FIAT_RISK_PROBLEM_CODES = [
  "high_risk",
  "fiat_locked_account",
  "blacklisted_email_domain",
  "suspicious_deposit_cluster",
  "fiat_identity_drift",
] as const satisfies readonly FiatProblemCode[];

export function isFiatRiskProblem(code: FiatProblemCode): boolean {
  return (FIAT_RISK_PROBLEM_CODES as readonly FiatProblemCode[]).includes(code);
}

export type FiatProblem = {
  source_kind: "deposit_intent" | "payment_webhook" | "signup";
  source_id: string;
  problem_code: FiatProblemCode;
  user_id: string | null;
  username: string | null;
  details: Record<string, unknown>;
  occurred_at: Date;
};

type PendingFiatAlert = FiatProblem & {
  destination: FiatAlertDestination;
  attempt_count: number;
};

export const FIAT_ALERT_DESTINATIONS = [
  "antifraud_risk",
  "fiat_operations",
  "high_risk_supplemental",
  "email_blacklist",
  "auto_banned",
] as const;

export type FiatAlertDestination = Extract<
  FiatNotificationRouteKey,
  (typeof FIAT_ALERT_DESTINATIONS)[number]
>;

export function fiatAlertEventKey(
  destination: FiatAlertDestination,
  problemCode?: FiatProblemCode,
):
  | "antifraud.fiat_credit_review_required"
  | "antifraud.fiat_risk"
  | "antifraud.fiat_operations"
  | "antifraud.email_blacklist"
  | "antifraud.account_auto_banned" {
  if (problemCode === "review") {
    return "antifraud.fiat_credit_review_required";
  }
  if (problemCode === "whop_history_auto_ban") {
    return "antifraud.account_auto_banned";
  }
  switch (destination) {
    case "antifraud_risk":
    case "high_risk_supplemental":
      return "antifraud.fiat_risk";
    case "fiat_operations":
      return "antifraud.fiat_operations";
    case "email_blacklist":
      return "antifraud.email_blacklist";
    case "auto_banned":
      return "antifraud.account_auto_banned";
  }
}

type DiscordPayload = DiscordWebhookPayload;

function clean(value: unknown, maxLength = 1_024): string {
  const text = sanitizeDiscordMentions(String(value ?? "")).trim();
  if (text.length === 0) return "Not provided";
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function detail(details: Record<string, unknown>, key: string): string | null {
  const value = details[key];
  return value === null || value === undefined || value === ""
    ? null
    : String(value);
}

function detailDate(
  details: Record<string, unknown>,
  key: string,
): Date | null {
  const value = detail(details, key);
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function discordTime(date: Date): string {
  const seconds = Math.floor(date.getTime() / 1_000);
  return `<t:${seconds}:F>\n<t:${seconds}:R>`;
}

function formatUsdCents(value: unknown): string | null {
  const cents = Number(value);
  if (!Number.isInteger(cents) || cents < 0) return null;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

function formatCurrencyCents(
  value: unknown,
  currencyValue: unknown,
): string | null {
  const cents = Number(value);
  const currency = String(currencyValue ?? "")
    .trim()
    .toUpperCase();
  if (
    !Number.isSafeInteger(cents) ||
    cents <= 0 ||
    !/^[A-Z]{3}$/.test(currency)
  ) {
    return null;
  }
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

export function fiatProblemTitle(code: FiatProblemCode): string {
  switch (code) {
    case "high_risk":
      return "High-risk fiat deposit";
    case "fiat_locked_account":
      return "High-risk fiat deposit from locked account";
    case "failed":
      return "Fiat deposit failed";
    case "review":
      return "Fiat deposit needs review";
    case "disputed":
      return "Fiat deposit disputed";
    case "partially_refunded":
      return "Fiat deposit partially refunded";
    case "refunded":
      return "Fiat deposit refunded";
    case "checkout_creating_stale":
      return "Fiat checkout creation stalled";
    case "pending_stale":
      return "Fiat deposit pending too long";
    case "webhook_failed":
      return "Fiat webhook processing failed";
    case "blacklisted_email_domain":
      return "Blacklisted email domain blocked";
    case "suspicious_deposit_cluster":
      return "Suspicious Whop deposit cluster blocked";
    case "fiat_identity_drift":
      return "Fiat deposit identity changed";
    case "whop_history_auto_ban":
      return "Account automatically banned";
  }
}

export function buildFiatDiscordPayload(
  dashboardUrl: string,
  problem: FiatProblem,
): DiscordPayload {
  const details = problem.details;
  const amount = formatUsdCents(details.credited_amount_cents);
  const fields: DiscordPayload["embeds"][number]["fields"] = [];
  const highRisk = problem.problem_code === "high_risk";
  const blacklistedDomainAutoBan =
    problem.problem_code === "blacklisted_email_domain" &&
    detail(details, "email_risk_type") === "blacklisted_domain" &&
    details.ban_confirmed === true;
  const autoBanned =
    problem.problem_code === "whop_history_auto_ban" || blacklistedDomainAutoBan;
  const status = detail(details, "status");
  const providerStatus = detail(details, "provider_payment_status");
  const riskScore = detail(details, "risk_score");
  const depositOccurredAt = highRisk
    ? (detailDate(details, "deposit_occurred_at") ?? problem.occurred_at)
    : null;

  if (autoBanned) {
    fields.push({
      name: "👤 Account",
      value: clean(
        [problem.username ?? "Unknown user", problem.user_id]
          .filter(Boolean)
          .join("\n"),
      ),
      inline: true,
    });
    fields.push({
      name: "⛔ Action",
      value: "**Account banned**\nSessions revoked",
      inline: true,
    });
    if (blacklistedDomainAutoBan) {
      fields.push({
        name: "Blacklisted domain",
        value: clean(detail(details, "email_domain") ?? "Unknown"),
        inline: true,
      });
      fields.push({
        name: "Matched on",
        value: problem.source_kind === "signup" ? "Signup email" : "Whop checkout email",
        inline: true,
      });
    } else {
      fields.push({
        name: "Whop buyer history",
        value: clean(
          `${detail(details, "priorDisputeCount") ?? "0"} prior dispute(s)\n` +
            `${detail(details, "priorRefundCount") ?? "0"} prior refund(s)`,
        ),
        inline: true,
      });
      fields.push({
        name: "Additional Whop evidence",
        value: clean(
          `${detail(details, "priorFraudDeclines") ?? "0"} fraud decline(s)\n` +
            `${detail(details, "highRiskSessions") ?? "0"} high-risk session(s)`,
        ),
        inline: true,
      });
      fields.push({ name: "Provider risk", value: detail(details, "providerRiskScore") ?? "Unavailable", inline: true });
      fields.push({ name: "Whop payment", value: clean(detail(details, "paymentId") ?? problem.source_id), inline: true });
    }
  } else if (highRisk) {
    fields.push({
      name: "👤 Account",
      value: clean(
        [problem.username ?? "Unknown user", problem.user_id]
          .filter(Boolean)
          .join("\n"),
      ),
      inline: true,
    });
    fields.push({
      name: "💵 Deposit amount",
      value: amount ? `**${amount}**` : "Unknown",
      inline: true,
    });
    fields.push({
      name: "📊 Risk score",
      value: riskScore
        ? `**${clean(riskScore)} / 100**\nCritical risk`
        : "Critical risk",
      inline: true,
    });
    fields.push({
      name: "💳 Payment method",
      value: whopPaymentMethodLabel(details.payment_method_type),
      inline: true,
    });
    fields.push({
      name: "📌 Payment status",
      value: clean(providerStatus ?? status ?? "Unknown"),
      inline: true,
    });
    fields.push({
      name: "🕒 Deposit received",
      value: discordTime(depositOccurredAt ?? problem.occurred_at),
      inline: true,
    });
  } else {
    if (problem.username || problem.user_id) {
      fields.push({
        name: "Account",
        value: clean(
          [problem.username, problem.user_id].filter(Boolean).join(" · "),
        ),
        inline: true,
      });
    }
    if (amount) {
      fields.push({ name: "Credit amount", value: amount, inline: true });
    }
    if (status) {
      fields.push({ name: "Status", value: clean(status), inline: true });
    }
    if (providerStatus) {
      fields.push({
        name: "Provider status",
        value: clean(providerStatus),
        inline: true,
      });
    }
    if (problem.source_kind !== "signup") {
      fields.push({
        name: "Payment option",
        value: whopPaymentMethodLabel(details.payment_method_type),
        inline: true,
      });
    }
    const eventType = detail(details, "event_type");
    if (eventType) {
      fields.push({
        name: "Webhook event",
        value: clean(eventType),
        inline: true,
      });
    }
    const attempts = detail(details, "attempt_count");
    if (attempts) {
      fields.push({ name: "Attempts", value: clean(attempts), inline: true });
    }
    if (riskScore) {
      fields.push({
        name: "Risk score",
        value: `${clean(riskScore)}/100`,
        inline: true,
      });
    }
  }
  const lockedMethods = detail(details, "locked_deposits_fiat");
  if (lockedMethods) {
    fields.push({
      name: "Fiat deposit lock",
      value: clean(lockedMethods),
      inline: true,
    });
  }
  const checkoutEmail = detail(details, "checkout_email");
  if (checkoutEmail) {
    fields.push({
      name: "Whop checkout email",
      value: clean(checkoutEmail),
      inline: false,
    });
  }
  const signupEmail =
    problem.source_kind === "signup" ? detail(details, "email") : null;
  if (signupEmail) {
    fields.push({
      name: "Signup email",
      value: clean(signupEmail),
      inline: false,
    });
  }
  const emailDomain = detail(details, "email_domain");
  const patternMatch =
    detail(details, "email_risk_type") === "gmail_dot_fragmentation";
  if (emailDomain) {
    fields.push({
      name: patternMatch ? "Email provider" : "Blacklisted domain",
      value: clean(emailDomain),
      inline: true,
    });
  }
  const emailRiskReason = detail(details, "email_risk_reason");
  if (emailRiskReason) {
    fields.push({
      name: "Email risk",
      value: clean(emailRiskReason),
      inline: false,
    });
  }
  const clusterAmount = formatCurrencyCents(
    details.amount_cents,
    details.currency,
  );
  if (clusterAmount) {
    fields.push({
      name: "Shared deposit amount",
      value: clusterAmount,
      inline: true,
    });
  }
  const clusterMembers = detail(details, "cluster_member_count");
  const clusterAccounts = detail(details, "cluster_account_count");
  const clusterPayments = detail(details, "cluster_payment_count");
  if (clusterMembers || clusterAccounts || clusterPayments) {
    fields.push({
      name: "Cluster evidence",
      value: clean(
        `${clusterMembers ?? "?"} events / ` +
          `${clusterAccounts ?? "?"} accounts / ` +
          `${clusterPayments ?? "?"} payment identities`,
      ),
      inline: false,
    });
  }
  const clusterWindow = detail(details, "cluster_window_minutes");
  if (clusterWindow) {
    fields.push({
      name: "Time window",
      value: `${clean(clusterWindow)} minutes`,
      inline: true,
    });
  }
  if (Array.isArray(details.cluster_emails)) {
    fields.push({
      name: "Cluster checkout emails",
      value: clean(details.cluster_emails.join("\n")),
      inline: false,
    });
  }
  if (problem.problem_code === "fiat_identity_drift") {
    const codes = [
      ...(Array.isArray(details.reason_codes) ? details.reason_codes : []),
      ...(Array.isArray(details.watch_codes) ? details.watch_codes : []),
    ];
    if (codes.length > 0) {
      fields.push({
        name: "What changed",
        value: clean(codes.join("\n")),
        inline: false,
      });
    }
    // Baseline vs. observed, side by side: the analyst's first question is
    // always "changed from what?"
    const cardWas = detail(details, "baseline_card_last4");
    const cardNow = detail(details, "card_last4");
    if (cardWas || cardNow) {
      fields.push({
        name: "Card",
        value: clean(`••••${cardWas ?? "????"} → ••••${cardNow ?? "????"}`),
        inline: true,
      });
    }
    const emailWas = detail(details, "baseline_checkout_email");
    const emailNow = detail(details, "checkout_email");
    if (emailWas || emailNow) {
      fields.push({
        name: "Payer email",
        value: clean(`${emailWas ?? "unknown"} → ${emailNow ?? "unknown"}`),
        inline: false,
      });
    }
    const clean_ = detail(details, "prior_clean_deposits");
    if (clean_) {
      fields.push({
        name: "Clean deposits before this",
        value: clean(clean_),
        inline: true,
      });
    }
  }

  const reason =
    detail(details, "failure_reason") ??
    detail(details, "last_error") ??
    detail(details, "summary") ??
    detail(details, "locked_deposits_reason");
  if (reason) {
    fields.push({
      name: highRisk ? "🔎 Why it was flagged" : "Failure detail",
      value: clean(reason),
      inline: false,
    });
  }
  const recommendation = highRisk ? detail(details, "recommendation") : null;
  if (recommendation) {
    fields.push({
      name: "🛡️ Recommended action",
      value: clean(recommendation),
      inline: false,
    });
  }

  const url = autoBanned
    ? new URL("/antifraud/auto-bans", dashboardUrl).toString()
    : new URL(dashboardUrl).toString();
  const creditReview = problem.problem_code === "review";
  const description =
    autoBanned
      ? blacklistedDomainAutoBan
        ? "A confirmed blacklist rule matched this email domain. Packy automatically banned the linked account and revoked its sessions."
        : "Whop reported a known prior dispute or refund for this buyer. Packy automatically banned the linked account and revoked its sessions."
      : problem.problem_code === "suspicious_deposit_cluster"
      ? details.cluster_basis === "refunded_amount"
        ? "A high share of settled payments for this exact amount was refunded across distinct accounts and payment identities. Crypto and item withdrawals are locked."
        : "Multiple distinct accounts and payment identities used unusual Gmail aliases for the same amount inside a short window. Crypto and item withdrawals are locked."
      : problem.problem_code === "blacklisted_email_domain"
        ? patternMatch
          ? "The email matched the Gmail dot-fragmentation fraud pattern. Staff review is required; no automatic account action was taken."
          : problem.source_kind === "signup"
            ? "A new signup matched the email-domain blacklist. Crypto and item withdrawals are locked."
            : "A Whop checkout matched the email-domain blacklist. Crypto and item withdrawals are locked."
          : problem.problem_code === "fiat_identity_drift"
            ? details.verdict === "contain"
              ? details.enforcement === "contained"
                ? details.containment_action === "fiat_and_withdrawals"
                  ? "An authorized Fiat deposit hit a high-confidence identity rule. Automatic Fiat and withdrawal containment was queued for durable application; KYC was not changed."
                  : "An authorized Fiat deposit hit a high-confidence identity rule. Automatic crypto and item withdrawal containment was queued for durable application; KYC was not changed."
                : "An authorized Fiat deposit matched a containment rule, but automatic enforcement is switched off — nothing was locked. Review and act manually."
              : details.verdict === "review"
                ? "An authorized Fiat deposit matched an identity review rule. Account Review was opened; no automatic lock or KYC action was taken."
                : "An authorized Fiat deposit produced watch-only identity evidence. No automatic account action was taken."
          : problem.problem_code === "high_risk"
            ? "A fiat deposit received a canonical high-risk verdict. Review the evidence before clearing or escalating it."
            : problem.problem_code === "fiat_locked_account"
              ? `Whop fiat intent ${clean(details.intent_id ?? problem.source_id, 256)} was created for an account with fiat deposits locked.`
              : problem.source_kind === "deposit_intent"
                ? `Whop fiat intent ${clean(details.intent_id ?? problem.source_id, 256)} requires attention.`
                : `Whop payment webhook ${clean(details.provider_event_id ?? problem.source_id, 256)} could not be processed.`;

  return {
    username: autoBanned ? "PackyGG Antifraud" : "PackyGG Fiat",
    embeds: [
      {
        title: autoBanned
          ? blacklistedDomainAutoBan
            ? "⛔ Blacklisted-domain account auto-ban"
            : "⛔ Whop-history account auto-ban"
          : patternMatch
          ? "Suspicious checkout email review"
          : highRisk
            ? "🚨 High-risk fiat deposit"
            : fiatProblemTitle(problem.problem_code),
        description,
        url,
        color:
          creditReview || problem.problem_code === "pending_stale"
            ? 0xf59e0b
            : 0xef4444,
        fields,
        footer: {
          text: autoBanned
            ? "PackyGG Antifraud · Automatic ban confirmed"
            : highRisk
            ? "PackyGG Fiat Risk · Deposit received"
            : "PackyGG Fiat Operations",
        },
        timestamp: (depositOccurredAt ?? problem.occurred_at).toISOString(),
      },
    ],
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 5,
            label: autoBanned
              ? "Open Auto Bans"
              : creditReview
              ? "Open Deposit Reviews"
              : highRisk
                ? "Review High-Risk Deposit"
                : "Open Fiat Operations",
            url,
          },
        ],
      },
    ],
  };
}

export async function fetchFiatProblems(
  source: pg.Pool,
  cursor: { occurredAt: Date; sourceId: string },
  limit = BATCH_SIZE,
): Promise<FiatProblem[]> {
  const result = await source.query<FiatProblem>(
    `
      WITH candidates AS (
        SELECT
          'deposit_intent'::text AS source_kind,
          fdi.id::text || ':fiat_locked_account' AS source_id,
          'fiat_locked_account'::text AS problem_code,
          fdi.user_id,
          COALESCE(u.display_username, u.username) AS username,
          jsonb_build_object(
            'intent_id', fdi.id::text,
            'provider', fdi.provider,
            'status', fdi.status,
            'currency', fdi.currency,
            'requested_amount_cents', fdi.requested_amount_cents,
            'credited_amount_cents', fdi.credited_amount_cents,
            'actual_customer_total_cents', fdi.actual_customer_total_cents,
            'provider_payment_status', fdi.provider_payment_status,
            'provider_checkout_id', fdi.provider_checkout_id,
            'provider_payment_id', fdi.provider_payment_id,
            'payment_method_type', COALESCE(
              fdi.provider_metadata->>'payment_method_type',
              fdi.provider_metadata->'payment'->>'payment_method_type',
              fdi.provider_metadata->'data'->>'payment_method_type',
              fdi.provider_metadata->'data'->'payment'->>'payment_method_type'
            ),
            'locked_deposits_fiat',
              array_to_string(ufl.locked_deposits_fiat, ', '),
            'locked_deposits_at', ufl.locked_deposits_at,
            'locked_deposits_reason', ufl.locked_deposits_reason
          ) AS details,
          fdi.created_at ${UTC} AS occurred_at
        FROM fiat_deposit_intents fdi
        JOIN user_feature_locks ufl ON ufl.user_id = fdi.user_id
        LEFT JOIN "user" u ON u.id = fdi.user_id
        WHERE cardinality(ufl.locked_deposits_fiat) > 0
          AND fdi.status NOT IN ('created', 'canceled')
          AND (
            ufl.locked_deposits_at IS NULL
            OR ufl.locked_deposits_at <= fdi.created_at
          )

        UNION ALL

        SELECT
          'deposit_intent'::text AS source_kind,
          fdi.id::text || ':' ||
            CASE
              WHEN fdi.status = 'checkout_creating'
                THEN 'checkout_creating_stale'
              WHEN fdi.status = 'pending' THEN 'pending_stale'
              ELSE fdi.status
            END AS source_id,
          CASE
            WHEN fdi.status = 'checkout_creating'
              THEN 'checkout_creating_stale'
            WHEN fdi.status = 'pending' THEN 'pending_stale'
            ELSE fdi.status
          END AS problem_code,
          fdi.user_id,
          COALESCE(u.display_username, u.username) AS username,
          jsonb_build_object(
            'intent_id', fdi.id::text,
            'provider', fdi.provider,
            'status', fdi.status,
            'currency', fdi.currency,
            'requested_amount_cents', fdi.requested_amount_cents,
            'credited_amount_cents', fdi.credited_amount_cents,
            'actual_customer_total_cents', fdi.actual_customer_total_cents,
            'provider_payment_status', fdi.provider_payment_status,
            'provider_checkout_id', fdi.provider_checkout_id,
            'provider_payment_id', fdi.provider_payment_id,
            'payment_method_type', COALESCE(
              fdi.provider_metadata->>'payment_method_type',
              fdi.provider_metadata->'payment'->>'payment_method_type',
              fdi.provider_metadata->'data'->>'payment_method_type',
              fdi.provider_metadata->'data'->'payment'->>'payment_method_type'
            ),
            'failure_reason', fdi.failure_reason
          ) AS details,
          CASE
            WHEN fdi.status = 'checkout_creating'
              THEN fdi.updated_at + interval '15 minutes'
            WHEN fdi.status = 'pending'
              THEN fdi.updated_at + interval '60 minutes'
            ELSE fdi.updated_at
          END ${UTC} AS occurred_at
        FROM fiat_deposit_intents fdi
        LEFT JOIN "user" u ON u.id = fdi.user_id
        WHERE fdi.status IN (
          'failed',
          'review',
          'disputed',
          'partially_refunded',
          'refunded',
          'checkout_creating',
          'pending'
        )

      )
      SELECT
        source_kind,
        source_id,
        problem_code,
        user_id,
        username,
        details,
        occurred_at
      FROM candidates
      WHERE (occurred_at, source_id) >
        (date_trunc('milliseconds', $1::timestamptz ${UTC}), $2::text)
        AND occurred_at <= now() ${UTC}
      ORDER BY occurred_at, source_id
      LIMIT $3
    `,
    [cursor.occurredAt, cursor.sourceId, limit],
  );
  return result.rows;
}

export async function fetchFailedPaymentWebhooks(
  source: pg.Pool,
  cursor: { occurredAt: Date; sourceId: string },
  limit = BATCH_SIZE,
): Promise<FiatProblem[]> {
  const result = await source.query<FiatProblem>(
    `
      SELECT
        'payment_webhook'::text AS source_kind,
        pwe.id::text || ':webhook_failed' AS source_id,
        'webhook_failed'::text AS problem_code,
        fdi.user_id,
        COALESCE(u.display_username, u.username) AS username,
        jsonb_build_object(
          'webhook_event_id', pwe.id::text,
          'provider_event_id', pwe.provider_event_id,
          'provider_resource_id', pwe.provider_resource_id,
          'event_type', pwe.event_type,
          'status', pwe.processing_status,
          'attempt_count', pwe.attempt_count,
          'last_error', pwe.last_error,
          'intent_id', fdi.id::text,
          'credited_amount_cents', fdi.credited_amount_cents,
          'payment_method_type', COALESCE(
            pwe.payload->>'payment_method_type',
            pwe.payload->'payment'->>'payment_method_type',
            pwe.payload->'data'->>'payment_method_type',
            pwe.payload->'data'->'payment'->>'payment_method_type'
          )
        ) AS details,
        pwe.received_at ${UTC} AS occurred_at
      FROM payment_webhook_events pwe
      LEFT JOIN LATERAL (
        SELECT
          candidate.id,
          candidate.user_id,
          candidate.credited_amount_cents
        FROM fiat_deposit_intents candidate
        WHERE candidate.provider_payment_id = pwe.provider_resource_id
           OR candidate.provider_checkout_id = pwe.provider_resource_id
        ORDER BY
          CASE
            WHEN candidate.provider_payment_id = pwe.provider_resource_id
              THEN 0
            ELSE 1
          END
        LIMIT 1
      ) fdi ON true
      LEFT JOIN "user" u ON u.id = fdi.user_id
      WHERE pwe.processing_status = 'failed'
        AND pwe.received_at >= (now() ${UTC}) - interval '30 days'
        AND (
          pwe.received_at ${UTC},
          pwe.id::text || ':webhook_failed'
        ) > ($1, $2)
      ORDER BY pwe.received_at, pwe.id
      LIMIT $3
    `,
    [cursor.occurredAt, cursor.sourceId, limit],
  );
  return result.rows;
}

export async function fetchHighRiskFiatProblems(
  antifraud: pg.Pool,
  cursor: { occurredAt: Date; sourceId: string },
  limit = BATCH_SIZE,
): Promise<FiatProblem[]> {
  const result = await antifraud.query<FiatProblem>(
    `
      SELECT
        'deposit_intent'::text AS source_kind,
        fda.deposit_intent_id::text || ':high_risk' AS source_id,
        'high_risk'::text AS problem_code,
        fda.user_id,
        fda.username,
        jsonb_build_object(
          'intent_id', fda.deposit_intent_id::text,
          'provider', fda.provider,
          'status', fda.status,
          'currency', fda.currency,
          'credited_amount_cents',
            round(fda.credited_amount_usd * 100)::bigint,
          'provider_payment_status', fda.provider_payment_status,
          'payment_method_type',
            fda.provider_evidence->>'paymentMethodType',
          'deposit_occurred_at', fda.occurred_at,
          'risk_score', fda.risk_score,
          'verdict', fda.verdict,
          'recommendation', fda.recommendation,
          'summary', fda.summary
        ) AS details,
        fda.assessed_at AS occurred_at
      FROM fiat_deposit_assessments fda
      WHERE fda.verdict = 'bad'
        AND fda.assessed_at <= now() - interval '5 seconds'
        AND (
          fda.assessed_at,
          fda.deposit_intent_id::text || ':high_risk'
        ) >
          ($1::timestamptz, $2::text)
      ORDER BY fda.assessed_at, fda.deposit_intent_id
      LIMIT $3
    `,
    [cursor.occurredAt, cursor.sourceId, limit],
  );
  return result.rows;
}

export function fiatAlertDestinations(
  problemCode: FiatProblemCode,
): readonly FiatAlertDestination[] {
  return notificationRoutesForFiatProblem(problemCode);
}

export class FiatProblemAlerts {
  constructor(
    private readonly config: Config,
    private readonly db: Databases,
    private readonly log: FastifyBaseLogger,
    private readonly reviewRiskClassifier?: FiatReviewRiskClassifier,
  ) {}

  async ensureCursor(): Promise<void> {
    await this.db.antifraud.query(
      `
        INSERT INTO source_cursors(stream, occurred_at, source_id)
        VALUES
          ($1, now() - interval '2 minutes', ''),
          ($2, now() - interval '2 minutes', ''),
          ($3, now() - interval '30 days', '')
        ON CONFLICT (stream) DO NOTHING
      `,
      [CURSOR_STREAM, HIGH_RISK_CURSOR_STREAM, FAILED_WEBHOOK_CURSOR_STREAM],
    );
  }

  async process(): Promise<void> {
    await this.capture();
    await this.classifyPendingReviews();
    await this.captureHighRiskAssessments();
    await this.queueConfirmedEmailDomainAutoBans();
    await this.syncDeliveries();
    await this.suppressClassifiedReviewDeliveries();
    await this.deliver();
  }

  private async classifyPendingReviews(): Promise<void> {
    if (!this.reviewRiskClassifier) return;
    const pending = await this.db.antifraud.query<{ intent_id: string }>(
      `
        SELECT split_part(alert.source_id, ':', 1) AS intent_id
        FROM fiat_problem_alert_outbox AS alert
        WHERE alert.problem_code = 'review'
          AND alert.discord_delivered_at IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM fiat_problem_alert_deliveries delivery
            WHERE delivery.source_kind = alert.source_kind
              AND delivery.source_id = alert.source_id
              AND delivery.destination = 'fiat_operations'
              AND (
                delivery.delivered_at IS NOT NULL
                OR delivery.suppressed_at IS NOT NULL
              )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM fiat_deposit_assessments assessment
            WHERE assessment.deposit_intent_id::text =
              split_part(alert.source_id, ':', 1)
              AND assessment.status = 'review'
              AND assessment.source_updated_at >= alert.occurred_at
          )
        ORDER BY alert.occurred_at, alert.source_id
        LIMIT ${REVIEW_CLASSIFICATION_BATCH_SIZE}
      `,
    );

    for (const { intent_id: intentId } of pending.rows) {
      try {
        const classified = await this.reviewRiskClassifier.refreshIntent(intentId);
        if (!classified) {
          this.log.error(
            { intentId },
            "Fiat review risk classification found no matching deposit",
          );
        }
      } catch (error) {
        // Keep the delivery pending and retry next tick. Sending a normal card
        // without its risk result would recreate the race this gate prevents.
        this.log.error(
          { err: error, intentId },
          "Fiat review risk classification failed",
        );
      }
    }
  }

  private async queueConfirmedEmailDomainAutoBans(): Promise<void> {
    const pending = await this.db.antifraud.query<{ source_kind: string; source_id: string; user_id: string }>(
      `SELECT source_kind, source_id, user_id
       FROM fiat_problem_alert_outbox
       WHERE problem_code='blacklisted_email_domain'
         AND details->>'email_risk_type'='blacklisted_domain'
         AND COALESCE(details->>'ban_confirmed','false') <> 'true'
         AND user_id IS NOT NULL
         AND discord_delivered_at IS NULL
       ORDER BY occurred_at LIMIT 500`,
    );
    if (pending.rows.length === 0) return;
    const userIds = Array.from(new Set(pending.rows.map((row) => row.user_id)));
    const confirmed = await this.db.source.query<{ id: string; banned_reason: string | null; banned_at: Date | null }>(
      `SELECT id, banned_reason, banned_at FROM "user"
       WHERE id=ANY($1::text[]) AND is_banned=true
         AND banned_reason LIKE 'Automatic fraud ban:%active blocked email domain%'`,
      [userIds],
    );
    const byUser = new Map(confirmed.rows.map((row) => [row.id, row]));
    for (const alert of pending.rows) {
      const account = byUser.get(alert.user_id);
      if (!account) continue;
      await this.db.antifraud.query(
        `UPDATE fiat_problem_alert_outbox
         SET details=details || jsonb_build_object(
               'ban_confirmed', true, 'ban_reason', $3::text,
               'banned_at', $4::timestamptz
             ), next_attempt_at=now(), updated_at=now()
         WHERE source_kind=$1 AND source_id=$2`,
        [alert.source_kind, alert.source_id, account.banned_reason, account.banned_at],
      );
    }
  }

  private async captureHighRiskAssessments(): Promise<void> {
    for (;;) {
      const cursor = await this.db.antifraud.query<{
        occurred_at: Date;
        source_id: string;
      }>(
        `
          SELECT occurred_at, source_id
          FROM source_cursors
          WHERE stream = $1
        `,
        [HIGH_RISK_CURSOR_STREAM],
      );
      const row = cursor.rows[0];
      if (!row) throw new Error("High-risk fiat cursor is missing");

      const problems = await fetchHighRiskFiatProblems(this.db.antifraud, {
        occurredAt: row.occurred_at,
        sourceId: row.source_id,
      });
      if (problems.length === 0) return;

      await this.storeProblems(problems);
      const last = problems.at(-1);
      if (!last) throw new Error("High-risk fiat batch was empty");
      await this.db.antifraud.query(
        `
          UPDATE source_cursors
          SET occurred_at = $2, source_id = $3, updated_at = now()
          WHERE stream = $1
        `,
        [HIGH_RISK_CURSOR_STREAM, last.occurred_at, last.source_id],
      );

      if (problems.length < BATCH_SIZE) return;
    }
  }

  private async capture(): Promise<void> {
    for (;;) {
      const cursor = await this.db.antifraud.query<{
        occurred_at: Date;
        source_id: string;
      }>(
        "SELECT occurred_at, source_id FROM source_cursors WHERE stream = $1",
        [FAILED_WEBHOOK_CURSOR_STREAM],
      );
      const row = cursor.rows[0];
      if (!row) throw new Error("Failed-webhook cursor is missing");
      const failedWebhooks = await fetchFailedPaymentWebhooks(this.db.source, {
        occurredAt: row.occurred_at,
        sourceId: row.source_id,
      });
      if (failedWebhooks.length === 0) break;
      await this.storeProblems(failedWebhooks);
      const last = failedWebhooks.at(-1);
      if (!last) break;
      await this.db.antifraud.query(
        `
          UPDATE source_cursors
          SET occurred_at = $2, source_id = $3, updated_at = now()
          WHERE stream = $1
        `,
        [FAILED_WEBHOOK_CURSOR_STREAM, last.occurred_at, last.source_id],
      );
      if (failedWebhooks.length < BATCH_SIZE) break;
    }

    for (;;) {
      const cursor = await this.db.antifraud.query<{
        occurred_at: Date;
        source_id: string;
      }>(
        `
          SELECT occurred_at, source_id
          FROM source_cursors
          WHERE stream = $1
        `,
        [CURSOR_STREAM],
      );
      const row = cursor.rows[0];
      if (!row) throw new Error("Fiat problem cursor is missing");

      const problems = await fetchFiatProblems(this.db.source, {
        occurredAt: row.occurred_at,
        sourceId: row.source_id,
      });
      if (problems.length === 0) return;

      await this.storeProblems(problems);
      const last = problems.at(-1);
      if (!last) throw new Error("Fiat problem batch was empty");
      await this.db.antifraud.query(
        `
          UPDATE source_cursors
          SET occurred_at = $2, source_id = $3, updated_at = now()
          WHERE stream = $1
        `,
        [CURSOR_STREAM, last.occurred_at, last.source_id],
      );

      if (problems.length < BATCH_SIZE) return;
    }
  }

  private async storeProblems(problems: readonly FiatProblem[]): Promise<void> {
    await this.db.antifraud.query(
      `
        INSERT INTO fiat_problem_alert_outbox (
          source_kind, source_id, problem_code, user_id, username,
          details, occurred_at
        )
        SELECT *
        FROM unnest(
          $1::text[], $2::text[], $3::text[], $4::text[], $5::text[],
          $6::jsonb[], $7::timestamptz[]
        )
        ON CONFLICT (source_kind, source_id) DO NOTHING
      `,
      [
        problems.map((problem) => problem.source_kind),
        problems.map((problem) => problem.source_id),
        problems.map((problem) => problem.problem_code),
        problems.map((problem) => problem.user_id),
        problems.map((problem) => problem.username),
        problems.map((problem) => JSON.stringify(problem.details)),
        problems.map((problem) => problem.occurred_at),
      ],
    );
  }

  private async syncDeliveries(): Promise<void> {
    await this.db.antifraud.query(
      `
        INSERT INTO fiat_problem_alert_deliveries (
          source_kind, source_id, destination
        )
        SELECT
          alert.source_kind,
          alert.source_id,
          destination.destination
        FROM fiat_problem_alert_outbox AS alert
        CROSS JOIN LATERAL (
          SELECT 'email_blacklist'::text AS destination
          WHERE alert.problem_code = 'suspicious_deposit_cluster'
             OR (alert.problem_code = 'blacklisted_email_domain'
                 AND alert.details->>'email_risk_type' <> 'blacklisted_domain')

          UNION ALL

          SELECT 'antifraud_risk'::text
          WHERE alert.problem_code IN (
            'high_risk',
            'fiat_locked_account',
            'fiat_identity_drift'
          )

          UNION ALL

          SELECT 'high_risk_supplemental'::text
          WHERE alert.problem_code = 'high_risk'

          UNION ALL

          SELECT 'auto_banned'::text
          WHERE alert.problem_code = 'whop_history_auto_ban'
             OR (alert.problem_code = 'blacklisted_email_domain'
                 AND alert.details->>'email_risk_type' = 'blacklisted_domain'
                 AND alert.details->>'ban_confirmed' = 'true')

          UNION ALL

          SELECT 'fiat_operations'::text
          WHERE alert.problem_code NOT IN (
            'blacklisted_email_domain',
            'suspicious_deposit_cluster',
            'high_risk',
            'fiat_locked_account',
            'fiat_identity_drift',
            'whop_history_auto_ban'
          )
        ) AS destination
        ON CONFLICT (source_kind, source_id, destination) DO NOTHING
      `,
    );
  }

  private async suppressClassifiedReviewDeliveries(): Promise<void> {
    const suppressed = await this.db.antifraud.query<{
      source_kind: FiatProblem["source_kind"];
      source_id: string;
    }>(
      `
        UPDATE fiat_problem_alert_deliveries AS delivery
        SET
          suppressed_at = COALESCE(delivery.suppressed_at, now()),
          suppression_reason = CASE
            WHEN EXISTS (
              SELECT 1
              FROM fiat_deposit_identity_checks identity_check
              WHERE identity_check.intent_id =
                split_part(alert.source_id, ':', 1)
                AND identity_check.verdict = 'contain'
            ) THEN 'identity_containment'
            WHEN EXISTS (
              SELECT 1
              FROM fiat_deposit_assessments assessment
              WHERE assessment.deposit_intent_id::text =
                split_part(alert.source_id, ':', 1)
                AND assessment.source_updated_at >= alert.occurred_at
                AND assessment.verdict = 'bad'
            ) THEN 'high_risk_assessment'
            ELSE 'deposit_status_changed'
          END,
          last_error = NULL,
          updated_at = now()
        FROM fiat_problem_alert_outbox AS alert
        WHERE delivery.source_kind = alert.source_kind
          AND delivery.source_id = alert.source_id
          AND delivery.destination = 'fiat_operations'
          AND delivery.delivered_at IS NULL
          AND delivery.suppressed_at IS NULL
          AND alert.problem_code = 'review'
          AND (
            EXISTS (
              SELECT 1
              FROM fiat_deposit_assessments assessment
              WHERE assessment.deposit_intent_id::text =
                split_part(alert.source_id, ':', 1)
                AND assessment.source_updated_at >= alert.occurred_at
                AND (
                  assessment.status <> 'review'
                  OR assessment.verdict = 'bad'
                )
            )
            OR EXISTS (
              SELECT 1
              FROM fiat_deposit_identity_checks identity_check
              WHERE identity_check.intent_id =
                split_part(alert.source_id, ':', 1)
                AND identity_check.verdict = 'contain'
            )
          )
        RETURNING delivery.source_kind, delivery.source_id
      `,
    );
    for (const delivery of suppressed.rows) {
      await this.refreshLegacyDeliveryState(delivery);
    }
  }

  private async deliver(): Promise<void> {
    const pending = await this.db.antifraud.query<PendingFiatAlert>(
      `
        SELECT
          alert.source_kind,
          alert.source_id,
          alert.problem_code,
          alert.user_id,
          alert.username,
          alert.details,
          alert.occurred_at,
          delivery.destination,
          delivery.attempt_count
        FROM fiat_problem_alert_deliveries AS delivery
        JOIN fiat_problem_alert_outbox AS alert
          USING (source_kind, source_id)
        WHERE delivery.delivered_at IS NULL
          AND delivery.suppressed_at IS NULL
          AND delivery.next_attempt_at <= now()
          AND alert.next_attempt_at <= now()
          -- A review card is eligible on evidence, never elapsed time. This
          -- prevents it racing the high-risk/containment cards while releasing
          -- an ordinary review immediately after both checks finish.
          AND (
            alert.problem_code <> 'review'
            OR (
              EXISTS (
                SELECT 1
                FROM fiat_deposit_assessments assessment
                WHERE assessment.deposit_intent_id::text =
                  split_part(alert.source_id, ':', 1)
                  AND assessment.status = 'review'
                  AND assessment.source_updated_at >= alert.occurred_at
                  AND assessment.verdict <> 'bad'
              )
              AND EXISTS (
                SELECT 1
                FROM fiat_deposit_identity_checks identity_check
                WHERE identity_check.intent_id =
                  split_part(alert.source_id, ':', 1)
              )
              AND NOT EXISTS (
                SELECT 1
                FROM fiat_deposit_identity_checks identity_check
                WHERE identity_check.intent_id =
                  split_part(alert.source_id, ':', 1)
                  AND identity_check.verdict = 'contain'
              )
            )
          )
        ORDER BY alert.occurred_at, delivery.destination
        LIMIT ${DELIVERY_BATCH_SIZE}
      `,
    );

    await drainOutbox<PendingFiatAlert>({
      fetchPending: async () => pending.rows,
      attemptCount: (problem) => problem.attempt_count,
      attempt: (problem) => this.send(problem),
      record: async (problem, outcome) => {
        await this.db.antifraud.query(
          `
          UPDATE fiat_problem_alert_deliveries
          SET
            delivered_at = CASE
              WHEN $4::boolean THEN COALESCE(delivered_at, now())
              ELSE delivered_at
            END,
            attempt_count = $5,
            next_attempt_at = CASE
              WHEN $4::boolean THEN now()
              ELSE now() + ($6::text || ' seconds')::interval
            END,
            last_error = CASE
              WHEN $4::boolean THEN NULL
              ELSE 'Discord delivery failed'
            END,
            updated_at = now()
          WHERE source_kind = $1
            AND source_id = $2
            AND destination = $3
        `,
          [
            problem.source_kind,
            problem.source_id,
            problem.destination,
            outcome.delivered,
            outcome.attempt,
            outcome.retrySeconds,
          ],
        );
      },
      onRecorded: async (problem, outcome) => {
        if (outcome.delivered) {
          this.log.info(
            {
              sourceKind: problem.source_kind,
              sourceId: problem.source_id,
              destination: problem.destination,
            },
            "Fiat Discord alert delivered",
          );
        }
        await this.refreshLegacyDeliveryState(problem);
      },
    });
  }

  private async refreshLegacyDeliveryState(
    problem: Pick<PendingFiatAlert, "source_kind" | "source_id">,
  ): Promise<void> {
    await this.db.antifraud.query(
      `
        WITH delivery_state AS (
          SELECT
            count(*) FILTER (
              WHERE delivered_at IS NULL AND suppressed_at IS NULL
            ) AS pending_count,
            COALESCE(sum(attempt_count), 0)::integer AS attempt_count,
            min(next_attempt_at) FILTER (
              WHERE delivered_at IS NULL AND suppressed_at IS NULL
            ) AS next_attempt_at,
            string_agg(last_error, '; ' ORDER BY destination) FILTER (
              WHERE delivered_at IS NULL
                AND suppressed_at IS NULL
                AND last_error IS NOT NULL
            ) AS last_error
          FROM fiat_problem_alert_deliveries
          WHERE source_kind = $1 AND source_id = $2
        )
        UPDATE fiat_problem_alert_outbox AS alert
        SET
          discord_delivered_at = CASE
            WHEN state.pending_count = 0
              THEN COALESCE(alert.discord_delivered_at, now())
            ELSE NULL
          END,
          attempt_count = state.attempt_count,
          next_attempt_at = COALESCE(
            state.next_attempt_at,
            'infinity'::timestamptz
          ),
          last_error = state.last_error,
          updated_at = now()
        FROM delivery_state AS state
        WHERE alert.source_kind = $1 AND alert.source_id = $2
      `,
      [problem.source_kind, problem.source_id],
    );
  }

  private async send(
    problem: PendingFiatAlert,
  ): Promise<{ delivered: boolean; retryAfterSeconds: number | null }> {
    const eventKey = fiatAlertEventKey(
      problem.destination,
      problem.problem_code,
    );
    const delivered = await sendBotDiscordEvent(this.config, this.log, {
      eventKey,
      // The former high-risk supplemental webhook now resolves to the same
      // event and dedupe key. The configurable router fans one event out to
      // every selected channel without creating duplicate alerts.
      dedupeKey: `fiat:${problem.source_kind}:${problem.source_id}:` + eventKey,
      payload: buildFiatDiscordPayload(
        this.config.FIAT_ALERT_DASHBOARD_URL,
        problem,
      ),
    });
    return { delivered, retryAfterSeconds: null };
  }
}
