import { createHash } from "node:crypto";

import type pg from "pg";
import type { Pool } from "pg";

import type { Databases } from "./db.js";
import {
  canonicalIp,
  EnrichmentService,
  fingerprintEventIdentity,
  providerContractMetadata,
  type EnrichmentResult,
} from "./enrichment.js";
import type { SignupProvider } from "./provider-contracts.js";
import type { FiatEligibilityEnvironment } from "./fiat-eligibility-auth.js";
import { domainFromEmail } from "./fiat-email-domains.js";
import {
  FIAT_ELIGIBILITY_CONTAINMENT_EVENT,
  queueFiatEligibilityContainment,
} from "./fiat-eligibility-containment.js";
import {
  AUTOMATIC_DENY_SCORE,
  DECISION_TTL_MS,
  evaluateFiatEligibility,
  MAX_FUTURE_SKEW_MS,
  MAX_REQUEST_AGE_MS,
  SMALL_CRYPTO_DEPOSIT_USD,
  SMALL_CRYPTO_TRUST_WEIGHT,
  accountAgeDays,
  badDeviceReputation,
  badIpReputation,
  behaviourSignals,
  type FiatEligibilityBehaviour,
  type FiatEligibilityAdditionalBlocklists,
  type FiatEligibilityBlocklistMatch,
  type FiatEligibilityNetwork,
  type FiatEligibilityPolicyOutcome,
  type FiatEligibilitySignal,
} from "./fiat-eligibility-policy.js";
import { disposableEmailDomain } from "./scoring.js";
import {
  prePaymentObservationSignals,
  type FiatPrePaymentObservationEvidence,
} from "./fiat-observations.js";
import type { ScoreWeightStore } from "./score-weight-store.js";
import type { Signal, Signup } from "./types.js";

const EMPTY_PRE_PAYMENT_OBSERVATIONS: FiatPrePaymentObservationEvidence = {
  status: "complete",
  ipAttempts10m: 0,
  deviceAttempts10m: 0,
  platformAttempts10m: 0,
  ipDistinctUsers24h: 0,
  deviceDistinctUsers24h: 0,
  linkedActiveRiskUsers: 0,
  amountAttempts30m: 0,
  amountDistinctUsers30m: 0,
};

function unavailablePrePaymentObservations(
  error: unknown,
): FiatPrePaymentObservationEvidence {
  console.warn("[fiat-observations] pre-payment evidence query unavailable", {
    errorType: error instanceof Error ? error.name : typeof error,
    errorCode: error instanceof Error
      ? (error as Error & { code?: unknown }).code
      : undefined,
  });
  return { ...EMPTY_PRE_PAYMENT_OBSERVATIONS, status: "unavailable" };
}

export type FiatEligibilityRequest = {
  env: FiatEligibilityEnvironment;
  createdAt: string;
  ipAddress: string;
  fingerprint: string;
  userID: string;
  /** Optional until the checkout backend sends payment context. */
  amountCents?: number;
  currency?: string;
  locale?: string;
  timezone?: string;
};

export type FiatEligibilityDecision = {
  decisionId: string;
  decision: "allow" | "deny";
  allowed: boolean;
  timestamp: string;
  riskScore: number;
  reasonCodes: string[];
  expiresAt: string;
  idempotent: boolean;
  /** True when this assessment queued account containment. */
  contained: boolean;
  enforcementReasons: string[];
};

/**
 * Deposit / play / reward lookback for the behaviour leg. Long enough that a
 * real customer's funding history counts, bounded so one account can never turn
 * a checkout into an unbounded ledger scan.
 */
const BEHAVIOUR_LOOKBACK_DAYS = 365;

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

/**
 * Wall-clock ceilings for the checkout path. The source and Antifraud pools
 * carry 10s/15s statement timeouts for background work; a checkout cannot wait
 * that long, so every read gets its own deadline and a breach fails closed.
 */
const SOURCE_READ_TIMEOUT_MS = 3_000;
/**
 * Deadline for the corroborating Abstract IP provider. It can
 * only ever add points and cannot block a decision, so its 5s SDK timeout must
 * not set the latency a paying customer waits. On a
 * breach the provider is reported as failed, which the policy scores as
 * `*_check_degraded` (10 points, never blocking). The MANDATORY providers keep
 * their full budget: without Fingerprint and proxycheck there is no decision to
 * make, so waiting for them is the point.
 */
const CORROBORATING_PROVIDER_TIMEOUT_MS = 2_000;
const ANTIFRAUD_READ_TIMEOUT_MS = 2_500;
const PERSIST_TIMEOUT_MS = 5_000;

type SourceSubjectRow = Omit<Signup, "user_agent"> & {
  latest_login_ip: string | null;
  latest_login_visitor_id: string | null;
  latest_login_at: Date | null;
  latest_login_confidence: number | null;
  latest_login_suspected_alt: boolean;
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
  last_paid_fiat_at: Date | null;
  crypto_deposits: number;
  crypto_deposit_usd: string;
  crypto_trust_usd: string;
  fiat_deposits: number;
  fiat_deposit_usd: string;
  wager_usd: string;
  game_events: number;
  reward_usd: string;
  rain_wins: number;
  withdrawal_requests: number;
};

type StoredAssessment = {
  id: string;
  request_hash: string;
  decision: "allow" | "deny";
  risk_score: number;
  reason_codes: string[];
  enforcement_reasons: string[] | null;
  enforcement: string | null;
  expires_at: Date;
  created_at: Date;
};

export class FingerprintReuseError extends Error {
  constructor() {
    super("Fingerprint event was already used for a different request");
    this.name = "FingerprintReuseError";
  }
}

class DeadlineError extends Error {
  constructor(label: string) {
    super(`${label}_timeout`);
    this.name = "DeadlineError";
  }
}

/**
 * Bound one awaited step. A breached deadline rejects; the underlying query is
 * still capped by the pool's own `statement_timeout`, so nothing leaks past it.
 */
async function withDeadline<T>(
  work: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new DeadlineError(label)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Never rejects: a corroborating provider that misses its deadline is reported
 * as failed so the policy can score it, exactly as it would score a provider
 * that returned an error.
 */
function boundedCorroboration(
  work: Promise<EnrichmentResult>,
  provider: SignupProvider,
): Promise<EnrichmentResult> {
  return withDeadline(
    work,
    CORROBORATING_PROVIDER_TIMEOUT_MS,
    `fiat_${provider}_provider`,
  ).catch((error: unknown) => ({
    provider,
    status: "failed" as const,
    lookupKey: `deadline:${provider}`,
    errorCode:
      error instanceof DeadlineError ? "checkout_deadline" : "provider_error",
    ...providerContractMetadata(provider, "live", "unknown", {
      errorCode:
        error instanceof DeadlineError ? "checkout_deadline" : "provider_error",
    }),
    signals: [],
  }));
}

function usd(value: string | number | null | undefined): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function behaviourFrom(
  row: SourceSubjectRow,
  now: Date,
): FiatEligibilityBehaviour {
  const lastPaid = row.last_paid_fiat_at
    ? new Date(row.last_paid_fiat_at).getTime()
    : null;
  return {
    cryptoDeposits: row.crypto_deposits ?? 0,
    cryptoDepositUsd: usd(row.crypto_deposit_usd),
    cryptoTrustUsd: usd(row.crypto_trust_usd),
    fiatDeposits: row.fiat_deposits ?? 0,
    fiatDepositUsd: usd(row.fiat_deposit_usd),
    wagerUsd: usd(row.wager_usd),
    gameEvents: row.game_events ?? 0,
    rewardUsd: usd(row.reward_usd),
    rainWins: row.rain_wins ?? 0,
    withdrawalRequests: row.withdrawal_requests ?? 0,
    msSinceLastPaidFiat:
      lastPaid !== null && Number.isFinite(lastPaid)
        ? now.getTime() - lastPaid
        : null,
  };
}

/**
 * One round trip for everything the source database can answer: account state,
 * locks, KYC, country policy, the signup device, and the deposit / play /
 * reward history the behaviour leg needs. Every aggregate rides the
 * `(user_id, created_at)` covering index the mirror already carries.
 */
async function loadSourceSubject(
  source: Pool,
  userId: string,
): Promise<SourceSubjectRow | null> {
  const result = await source.query<SourceSubjectRow>(
    `
      SELECT
        u.id, u.name, u.username, u.email, u.image, u.signup_ip, u.country,
        u.country_code, u.continent_code, u.state, u.city, u.affiliate_code,
        u.referred_by, u.is_suspected_alt,
        u.created_at AT TIME ZONE 'UTC' AS created_at,
        u.is_banned, u.is_locked, u.is_self_excluded,
        fp.request_id AS fingerprint_request_id,
        fp.visitor_id,
        fp.confidence AS fingerprint_confidence,
        fp.ip::text AS fingerprint_ip,
        login_fp.visitor_id AS latest_login_visitor_id,
        login_fp.ip::text AS latest_login_ip,
        login_fp.created_at AS latest_login_at,
        login_fp.confidence AS latest_login_confidence,
        COALESCE(login_fp.suspected_alt_triggered, false)
          AS latest_login_suspected_alt,
        COALESCE(cardinality(ufl.locked_deposits_fiat), 0) > 0 AS fiat_locked,
        COALESCE(cr.blocked, false) AS country_blocked,
        COALESCE(cardinality(cr.locked_deposits_fiat), 0) > 0
          AS country_fiat_locked,
        COALESCE(uk.kyc_required, false) AS kyc_required,
        COALESCE(uk.status::text, 'none') AS kyc_status,
        COALESCE(uk.admin_decision::text, 'pending') AS kyc_admin_decision,
        COALESCE(paid.prior_paid_fiat, 0)::int AS prior_paid_fiat,
        paid.last_paid_fiat_at,
        COALESCE(dep.crypto_deposits, 0)::int AS crypto_deposits,
        COALESCE(dep.crypto_deposit_usd, 0)::text AS crypto_deposit_usd,
        COALESCE(dep.crypto_trust_usd, 0)::text AS crypto_trust_usd,
        COALESCE(dep.fiat_deposits, 0)::int AS fiat_deposits,
        COALESCE(dep.fiat_deposit_usd, 0)::text AS fiat_deposit_usd,
        COALESCE(act.wager_usd, 0)::text AS wager_usd,
        COALESCE(act.game_events, 0)::int AS game_events,
        COALESCE(act.reward_usd, 0)::text AS reward_usd,
        COALESCE(act.rain_wins, 0)::int AS rain_wins,
        COALESCE(cash.withdrawal_requests, 0)::int AS withdrawal_requests
      -- Deliberately does NOT read audit_events. The signup user-agent it used
      -- to fetch is consumed by nothing on this path (no provider takes it, the
      -- policy never reads it, the assessment never stores it) and the mirror
      -- has no index on audit_events.user_id, so the lateral cost a full
      -- 211k-row sequential scan per checkout: 42ms -> 14ms and 96k fewer
      -- shared buffers once removed, measured on the production mirror.
      FROM "user" u
      LEFT JOIN user_feature_locks ufl ON ufl.user_id = u.id
      LEFT JOIN user_kyc uk ON uk.user_id = u.id
      LEFT JOIN country_restrictions cr
        ON UPPER(cr.country_code) = UPPER(u.country_code)
      LEFT JOIN LATERAL (
        SELECT request_id, visitor_id, confidence, ip
        FROM fingerprints
        WHERE user_id = u.id AND event_type = 'signup'
        ORDER BY created_at DESC
        LIMIT 1
      ) fp ON true
      LEFT JOIN LATERAL (
        SELECT
          visitor_id, ip, created_at, confidence, suspected_alt_triggered
        FROM fingerprints
        WHERE user_id = u.id AND event_type = 'login'
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      ) login_fp ON true
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*)::int AS prior_paid_fiat,
          MAX(fdi.paid_at) AS last_paid_fiat_at
        FROM fiat_deposit_intents fdi
        WHERE fdi.user_id = u.id
          AND fdi.paid_at IS NOT NULL
      ) paid ON true
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) FILTER (
            WHERE intent.id IS NULL
              AND (
                lt.crypto_asset IS NOT NULL
                OR lt.blockchain_tx_hash IS NOT NULL
                OR lt.fireblocks_tx_id IS NOT NULL
              )
          ) AS crypto_deposits,
          COALESCE(SUM(ABS(lt.amount::numeric)) FILTER (
            WHERE intent.id IS NULL
              AND (
                lt.crypto_asset IS NOT NULL
                OR lt.blockchain_tx_hash IS NOT NULL
                OR lt.fireblocks_tx_id IS NOT NULL
              )
          ), 0) AS crypto_deposit_usd,
          COALESCE(SUM(
            CASE
              WHEN intent.id IS NULL
                AND (
                  lt.crypto_asset IS NOT NULL
                  OR lt.blockchain_tx_hash IS NOT NULL
                  OR lt.fireblocks_tx_id IS NOT NULL
                )
              THEN CASE
                WHEN ABS(lt.amount::numeric) < $6::numeric
                  THEN ABS(lt.amount::numeric) * $7::numeric
                ELSE ABS(lt.amount::numeric)
              END
              ELSE 0
            END
          ), 0) AS crypto_trust_usd,
          COUNT(*) FILTER (WHERE intent.id IS NOT NULL) AS fiat_deposits,
          COALESCE(SUM(ABS(lt.amount::numeric)) FILTER (
            WHERE intent.id IS NOT NULL
          ), 0) AS fiat_deposit_usd
        FROM ledger_transactions lt
        -- The user_id predicate is redundant on paper (an intent's completed
        -- ledger row always belongs to the same account) but it is what lets
        -- the planner use the intents' (user_id, created_at) index. Without it
        -- PostgreSQL seq-scans the whole intents table once per deposit row.
        LEFT JOIN fiat_deposit_intents intent
          ON intent.completed_ledger_id = lt.id
          AND intent.user_id = u.id
        WHERE lt.user_id = u.id
          AND lt.type::text = 'deposit'
          AND lt.status::text = 'completed'
          AND lt.created_at >= now() - ($2::int * interval '1 day')
      ) dep ON true
      LEFT JOIN LATERAL (
        SELECT
          COALESCE(SUM(ABS(lt.amount::numeric)) FILTER (
            WHERE lt.type::text = ANY($3::text[])
          ), 0) AS wager_usd,
          COUNT(*) FILTER (
            WHERE lt.type::text = ANY($3::text[])
              OR lt.type::text = ANY($4::text[])
          ) AS game_events,
          COALESCE(SUM(ABS(lt.amount::numeric)) FILTER (
            WHERE lt.type::text = ANY($5::text[])
          ), 0) AS reward_usd,
          COUNT(*) FILTER (WHERE lt.type::text = 'rain_win') AS rain_wins
        FROM ledger_transactions lt
        WHERE lt.user_id = u.id
          AND lt.status::text = 'completed'
          AND lt.created_at >= now() - ($2::int * interval '1 day')
          AND (
            lt.type::text = ANY($3::text[])
            OR lt.type::text = ANY($4::text[])
            OR lt.type::text = ANY($5::text[])
          )
      ) act ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS withdrawal_requests
        FROM card_withdrawal_requests cwr
        WHERE cwr.user_id = u.id
          AND cwr.requested_at >= now() - ($2::int * interval '1 day')
      ) cash ON true
      WHERE u.id = $1
      LIMIT 1
    `,
    [
      userId,
      BEHAVIOUR_LOOKBACK_DAYS,
      GAME_WAGER_TYPES,
      GAME_PAYOUT_TYPES,
      REWARD_TYPES,
      SMALL_CRYPTO_DEPOSIT_USD,
      SMALL_CRYPTO_TRUST_WEIGHT,
    ],
  );
  return result.rows[0] ?? null;
}

async function loadNetworkEvidence(
  source: Pool,
  input: {
    userId: string;
    requestIp: string;
    checkoutVisitorId: string | null;
  },
): Promise<FiatEligibilityNetwork> {
  const result = await source.query<{
    shared_checkout_visitor_users: number;
    shared_current_ip_users: number;
  }>(
    `
      SELECT
        CASE WHEN $3::text IS NULL THEN 0 ELSE (
          SELECT COUNT(DISTINCT f.user_id)::int
          FROM fingerprints f
          WHERE f.visitor_id = $3
            AND f.user_id IS NOT NULL
            AND f.user_id <> $1
        ) END AS shared_checkout_visitor_users,
        (
          SELECT COUNT(*)::int
          FROM "user" peer
          WHERE peer.signup_ip = $2
            AND peer.id <> $1
        ) AS shared_current_ip_users
    `,
    [input.userId, input.requestIp, input.checkoutVisitorId],
  );
  return {
    sharedCheckoutVisitorUsers:
      result.rows[0]?.shared_checkout_visitor_users ?? 0,
    sharedCurrentIpUsers: result.rows[0]?.shared_current_ip_users ?? 0,
  };
}

/**
 * Active operator IP / fingerprint blocklist rules matching this checkout.
 * Read-only: the match row is written later, and only when the checkout is
 * actually contained.
 */
async function loadBlocklistMatches(
  antifraud: Pool,
  input: {
    requestIp: string;
    checkoutVisitorId: string | null;
    latestLoginIp: string | null;
    latestLoginVisitorId: string | null;
    signupIp: string | null;
    signupVisitorId: string | null;
  },
): Promise<FiatEligibilityBlocklistMatch[]> {
  const result = await antifraud.query<FiatEligibilityBlocklistMatch>(
    `
      WITH candidates(kind, value, matched_on, priority) AS (
        VALUES
          ('ip', $1::text, 'checkout', 1),
          ('fingerprint', $2::text, 'checkout', 1),
          ('ip', $3::text, 'latest_login', 2),
          ('fingerprint', $4::text, 'latest_login', 2),
          ('ip', $5::text, 'signup', 3),
          ('fingerprint', $6::text, 'signup', 3)
      ), matches AS (
        SELECT
          rules.id,
          rules.kind,
          candidates.matched_on,
          candidates.priority,
          rules.match_mode,
          rules.ip_network,
          rules.fingerprint_id,
          rules.reason,
          rules.effect,
          ROW_NUMBER() OVER (
            PARTITION BY rules.id ORDER BY candidates.priority
          ) AS match_rank
        FROM identifier_blocklists rules
        JOIN candidates ON candidates.kind = rules.kind
          AND candidates.value IS NOT NULL
          AND CASE
            WHEN rules.kind = 'ip'
              AND pg_input_is_valid(candidates.value, 'inet')
              THEN candidates.value::inet <<= rules.ip_network
            WHEN rules.kind = 'fingerprint'
              THEN rules.fingerprint_id = candidates.value
            ELSE false
          END
        WHERE rules.enabled
          AND (rules.expires_at IS NULL OR rules.expires_at > now())
      )
      SELECT
        id,
        kind,
        CASE
          WHEN kind = 'ip' AND match_mode = 'exact' THEN host(ip_network)
          WHEN kind = 'ip' THEN ip_network::text
          ELSE fingerprint_id
        END AS value,
        reason,
        effect,
        matched_on
      FROM matches
      WHERE match_rank = 1
      ORDER BY kind, id
      LIMIT 20
    `,
    [
      input.requestIp,
      input.checkoutVisitorId,
      input.latestLoginIp,
      input.latestLoginVisitorId,
      input.signupIp,
      input.signupVisitorId,
    ],
  );
  return result.rows;
}

/**
 * Remaining email fraud-enforcement lists used by checkout.
 */
async function loadAdditionalBlocklists(
  antifraud: Pool,
  input: { email: string | null; disposableEmailPoints: number },
): Promise<FiatEligibilityAdditionalBlocklists> {
  const emailDomain = input.email ? domainFromEmail(input.email) : null;
  const disposableDomain = disposableEmailDomain(input.email);
  const emailRule = emailDomain
    ? await antifraud.query<{ active: boolean }>(
          `
            SELECT EXISTS (
              SELECT 1
              FROM fiat_email_domain_blacklist
              WHERE enabled
                AND (expires_at IS NULL OR expires_at > now())
                AND domain = $1
            ) AS active
          `,
          [emailDomain],
        )
    : { rows: [{ active: false }] };
  return {
    emailDomain: emailRule.rows[0]?.active === true ? emailDomain : null,
    disposableEmailDomain: disposableDomain,
    disposableEmailPoints: input.disposableEmailPoints,
  };
}

async function loadPrePaymentObservations(
  antifraud: Pool,
  input: {
    environment: FiatEligibilityEnvironment;
    userId: string;
    requestIp: string;
    checkoutVisitorId: string | null;
    amountCents?: number;
    currency?: string;
  },
): Promise<FiatPrePaymentObservationEvidence> {
  const result = await antifraud.query<{
    ip_attempts_10m: number;
    device_attempts_10m: number;
    platform_attempts_10m: number;
    ip_distinct_users_24h: number;
    device_distinct_users_24h: number;
    linked_active_risk_users: number;
    amount_attempts_30m: number;
    amount_distinct_users_30m: number;
    ip_has_current_user_24h: boolean;
    device_has_current_user_24h: boolean;
    amount_has_current_user_30m: boolean;
  }>(
    `
      WITH recent AS (
        SELECT user_id, request_ip, checkout_visitor_id, provider_evidence,
          created_at
        FROM fiat_eligibility_assessments
        WHERE environment=$1 AND created_at>=now()-interval '24 hours'
      ), linked_users AS (
        SELECT DISTINCT user_id
        FROM recent
        WHERE user_id<>$2
          AND (
            request_ip=$3::inet
            OR (
              $4::text IS NOT NULL
              AND checkout_visitor_id=$4
            )
          )
      )
      SELECT
        COUNT(*) FILTER (
          WHERE request_ip=$3::inet
            AND created_at>=now()-interval '10 minutes'
        )::int AS ip_attempts_10m,
        COUNT(*) FILTER (
          WHERE $4::text IS NOT NULL
            AND checkout_visitor_id=$4
            AND created_at>=now()-interval '10 minutes'
        )::int AS device_attempts_10m,
        COUNT(*) FILTER (
          WHERE created_at>=now()-interval '10 minutes'
        )::int AS platform_attempts_10m,
        COUNT(DISTINCT user_id) FILTER (
          WHERE request_ip=$3::inet
        )::int AS ip_distinct_users_24h,
        COALESCE(BOOL_OR(request_ip=$3::inet AND user_id=$2), false)
          AS ip_has_current_user_24h,
        COUNT(DISTINCT user_id) FILTER (
          WHERE $4::text IS NOT NULL AND checkout_visitor_id=$4
        )::int AS device_distinct_users_24h,
        COALESCE(BOOL_OR(
          $4::text IS NOT NULL AND checkout_visitor_id=$4 AND user_id=$2
        ), false) AS device_has_current_user_24h,
        (
          SELECT COUNT(DISTINCT c.user_id)::int
          FROM cases c
          JOIN linked_users linked ON linked.user_id=c.user_id
          WHERE c.status<>'resolved'
            AND c.severity IN ('high','critical')
        ) AS linked_active_risk_users,
        COUNT(*) FILTER (
          WHERE $5::int IS NOT NULL
            AND upper(provider_evidence#>>'{requestContext,currency}')=upper($6)
            AND CASE
              WHEN provider_evidence#>>'{requestContext,amountCents}'
                ~ '^[0-9]+$'
              THEN (provider_evidence#>>'{requestContext,amountCents}')::int
              ELSE NULL
            END=$5
            AND created_at>=now()-interval '30 minutes'
        )::int AS amount_attempts_30m,
        COUNT(DISTINCT user_id) FILTER (
          WHERE $5::int IS NOT NULL
            AND upper(provider_evidence#>>'{requestContext,currency}')=upper($6)
            AND CASE
              WHEN provider_evidence#>>'{requestContext,amountCents}'
                ~ '^[0-9]+$'
              THEN (provider_evidence#>>'{requestContext,amountCents}')::int
              ELSE NULL
            END=$5
            AND created_at>=now()-interval '30 minutes'
        )::int AS amount_distinct_users_30m,
        COALESCE(BOOL_OR(
          $5::int IS NOT NULL
          AND user_id=$2
          AND upper(provider_evidence#>>'{requestContext,currency}')=upper($6)
          AND CASE
            WHEN provider_evidence#>>'{requestContext,amountCents}'
              ~ '^[0-9]+$'
            THEN (provider_evidence#>>'{requestContext,amountCents}')::int
            ELSE NULL
          END=$5
          AND created_at>=now()-interval '30 minutes'
        ), false) AS amount_has_current_user_30m
      FROM recent
    `,
    [
      input.environment,
      input.userId,
      input.requestIp,
      input.checkoutVisitorId,
      input.amountCents ?? null,
      input.currency ?? "",
    ],
  );
  const row = result.rows[0];
  const includeCurrent = (value: number | undefined): number => (value ?? 0) + 1;
  const includeCurrentUser = (
    value: number | undefined,
    alreadyIncluded: boolean | undefined,
  ): number => (value ?? 0) + (alreadyIncluded ? 0 : 1);
  return {
    status: "complete",
    ipAttempts10m: includeCurrent(row?.ip_attempts_10m),
    deviceAttempts10m: input.checkoutVisitorId
      ? includeCurrent(row?.device_attempts_10m)
      : 0,
    platformAttempts10m: includeCurrent(row?.platform_attempts_10m),
    ipDistinctUsers24h: includeCurrentUser(
      row?.ip_distinct_users_24h,
      row?.ip_has_current_user_24h,
    ),
    deviceDistinctUsers24h: input.checkoutVisitorId
      ? includeCurrentUser(
          row?.device_distinct_users_24h,
          row?.device_has_current_user_24h,
        )
      : 0,
    linkedActiveRiskUsers: row?.linked_active_risk_users ?? 0,
    amountAttempts30m: input.amountCents === undefined
      ? 0
      : includeCurrent(row?.amount_attempts_30m),
    amountDistinctUsers30m: input.amountCents === undefined
      ? 0
      : includeCurrentUser(
          row?.amount_distinct_users_30m,
          row?.amount_has_current_user_30m,
        ),
  };
}

function requestHash(input: FiatEligibilityRequest, requestIp: string): string {
  return createHash("sha256")
    .update([
      input.env,
      input.createdAt,
      requestIp,
      input.fingerprint,
      input.userID,
      input.amountCents ?? "",
      input.currency?.toUpperCase() ?? "",
      input.locale ?? "",
      input.timezone ?? "",
    ].join("\n"))
    .digest("hex");
}

function storedDecision(
  row: StoredAssessment,
  idempotent: boolean,
): FiatEligibilityDecision {
  return {
    decisionId: row.id,
    decision: row.decision,
    allowed: row.decision === "allow",
    timestamp: row.created_at.toISOString(),
    riskScore: row.risk_score,
    reasonCodes: row.reason_codes,
    expiresAt: row.expires_at.toISOString(),
    idempotent,
    contained: row.enforcement === "contained",
    enforcementReasons: row.enforcement_reasons ?? [],
  };
}

export class FiatEligibilityService {
  private readonly enrichment: EnrichmentService;
  private readonly inFlight = new Map<
    string,
    {
      requestHash: string;
      promise: Promise<FiatEligibilityDecision>;
    }
  >();

  constructor(
    private readonly db: Databases,
    private readonly scoreWeights: ScoreWeightStore,
    enrichment: EnrichmentService,
    private readonly globallyEnabled: boolean,
    /**
     * Master switch for automatic account containment. Assessment and deny
     * behaviour are unaffected when it is off — only the MAIN lock command is
     * withheld, so the endpoint can run in observe-only mode.
     */
    private readonly containmentEnabled: boolean = true,
  ) {
    this.enrichment = enrichment;
  }

  private sourceFor(environment: FiatEligibilityEnvironment): Pool {
    if (environment === "prod") return this.db.source;
    if (this.db.fiatDevSource) return this.db.fiatDevSource;
    throw new Error("fiat_dev_source_unavailable");
  }

  private async existing(
    fingerprintRequestId: string,
  ): Promise<StoredAssessment | null> {
    const result = await this.db.antifraud.query<StoredAssessment>(
      `
        SELECT
          id, request_hash, decision, risk_score, reason_codes,
          enforcement_reasons, enforcement, expires_at, created_at
        FROM fiat_eligibility_assessments
        WHERE fingerprint_request_id = $1
        LIMIT 1
      `,
      [fingerprintRequestId],
    );
    return result.rows[0] ?? null;
  }

  async assess(
    input: FiatEligibilityRequest,
    now = new Date(),
  ): Promise<FiatEligibilityDecision> {
    const requestIp = canonicalIp(input.ipAddress);
    if (!requestIp) throw new Error("invalid_request_ip");
    const hash = requestHash(input, requestIp);
    const active = this.inFlight.get(input.fingerprint);
    if (active) {
      if (active.requestHash !== hash) throw new FingerprintReuseError();
      return { ...await active.promise, idempotent: true };
    }
    const promise = this.assessOnce(input, now, requestIp, hash);
    this.inFlight.set(input.fingerprint, { requestHash: hash, promise });
    try {
      return await promise;
    } finally {
      if (this.inFlight.get(input.fingerprint)?.promise === promise) {
        this.inFlight.delete(input.fingerprint);
      }
    }
  }

  private async assessOnce(
    input: FiatEligibilityRequest,
    now: Date,
    requestIp: string,
    hash: string,
  ): Promise<FiatEligibilityDecision> {
    if (!this.globallyEnabled) {
      return this.denyGloballyDisabled(input, now, hash);
    }
    const previous = await withDeadline(
      this.existing(input.fingerprint),
      ANTIFRAUD_READ_TIMEOUT_MS,
      "fiat_replay_lookup",
    );
    if (previous) {
      if (previous.request_hash !== hash) throw new FingerprintReuseError();
      return storedDecision(previous, true);
    }

    const source = this.sourceFor(input.env);
    const subject = await withDeadline(
      loadSourceSubject(source, input.userID),
      SOURCE_READ_TIMEOUT_MS,
      "fiat_subject_read",
    );
    if (!subject) throw new Error("fiat_subject_not_found");

    const requestCreatedAt = new Date(input.createdAt);
    const weights = await this.scoreWeights.get();
    // Providers are asked about the CHECKOUT, not the signup: the request IP and
    // the fresh Fingerprint request id replace the stored signup values.
    const providerSubject: Signup = {
      ...subject,
      user_agent: null,
      signup_ip: requestIp,
      fingerprint_ip: null,
      fingerprint_request_id: input.fingerprint,
    };

    const fingerprintPromise = this.enrichment.fingerprintCheck(
      providerSubject,
      weights,
    );
    const additionalBlocklistsPromise = withDeadline(
      loadAdditionalBlocklists(this.db.antifraud, {
        email: subject.email,
        disposableEmailPoints: weights.disposable_email,
      }),
      ANTIFRAUD_READ_TIMEOUT_MS,
      "fiat_additional_blocklists_read",
    );
    // The shared-device count needs the visitor id from the Fingerprint event,
    // so it is chained onto that one call instead of waiting for the whole fan-
    // out. Never rejects: shared-network evidence degrades to zero rather than
    // failing a checkout the providers themselves answered.
    const networkPromise = fingerprintPromise.then(
      (result) =>
        withDeadline(
          loadNetworkEvidence(source, {
            userId: input.userID,
            requestIp,
            checkoutVisitorId: fingerprintEventIdentity(result.response)
              .visitorId,
          }),
          SOURCE_READ_TIMEOUT_MS,
          "fiat_network_read",
        ).catch(() => ({
          sharedCheckoutVisitorUsers: 0,
          sharedCurrentIpUsers: 0,
        })),
      () => ({ sharedCheckoutVisitorUsers: 0, sharedCurrentIpUsers: 0 }),
    );
    const blocklistPromise = fingerprintPromise.then((result) => {
      const checkoutIdentity = fingerprintEventIdentity(result.response);
      return withDeadline(
        loadBlocklistMatches(this.db.antifraud, {
          requestIp,
          checkoutVisitorId: checkoutIdentity.visitorId,
          latestLoginIp: subject.latest_login_ip
            ? canonicalIp(subject.latest_login_ip) ?? null
            : null,
          latestLoginVisitorId: subject.latest_login_visitor_id,
          signupIp: subject.signup_ip
            ? canonicalIp(subject.signup_ip) ?? null
            : null,
          signupVisitorId: subject.visitor_id,
        }),
        ANTIFRAUD_READ_TIMEOUT_MS,
        "fiat_blocklist_read",
      );
    });
    const observationsPromise = fingerprintPromise.then(
      (result) => withDeadline(
        loadPrePaymentObservations(this.db.antifraud, {
          environment: input.env,
          userId: input.userID,
          requestIp,
          checkoutVisitorId: fingerprintEventIdentity(result.response)
            .visitorId,
          amountCents: input.amountCents,
          currency: input.currency,
        }),
        ANTIFRAUD_READ_TIMEOUT_MS,
        "fiat_observations_read",
      ).catch(unavailablePrePaymentObservations),
      () => EMPTY_PRE_PAYMENT_OBSERVATIONS,
    );

    const [
      fingerprint,
      proxycheck,
      abstractIp,
      network,
      history,
      velocity,
      blocklistMatches,
      additionalBlocklists,
      observations,
    ] = await Promise.all([
      fingerprintPromise,
      this.enrichment.proxycheck(providerSubject, weights, "fiat-eligibility"),
      boundedCorroboration(
        this.enrichment.abstractIpCheck(providerSubject, weights),
        "abstract_ip",
      ),
      networkPromise,
      this.loadFraudHistory(input),
      this.loadVelocity(input),
      blocklistPromise,
      additionalBlocklistsPromise,
      observationsPromise,
    ]);

    const identity = fingerprintEventIdentity(fingerprint.response);
    const providers = [fingerprint, proxycheck, abstractIp];
    const behaviour = behaviourFrom(subject, now);
    const policyOutcome = evaluateFiatEligibility({
      now,
      requestCreatedAt,
      requestIp,
      subject: {
        ...subject,
        signup_ip: subject.signup_ip
          ? canonicalIp(subject.signup_ip) ?? subject.signup_ip
          : null,
        latest_login_ip: subject.latest_login_ip
          ? canonicalIp(subject.latest_login_ip) ?? subject.latest_login_ip
          : null,
      },
      identity,
      providers,
      behaviour,
      network,
      blocklistMatches,
      additionalBlocklists,
      signupRiskScore: history.signupRiskScore,
      activeCaseSeverity: history.activeCaseSeverity,
      attempts10m: velocity.attempts10m,
      deniedAttempts24h: velocity.deniedAttempts24h,
    });
    const outcome: FiatEligibilityPolicyOutcome = {
      ...policyOutcome,
      signals: [
        ...policyOutcome.signals,
        ...prePaymentObservationSignals(observations),
      ],
    };

    return this.persist({
      input,
      now,
      requestIp,
      hash,
      subject,
      identity,
      providers,
      behaviour,
      network,
      blocklistMatches,
      additionalBlocklists,
      observations,
      outcome,
    });
  }

  private async loadFraudHistory(input: FiatEligibilityRequest): Promise<{
    signupRiskScore: number;
    activeCaseSeverity: string | null;
  }> {
    // Signup assessments and cases only exist for the production population.
    if (input.env !== "prod") {
      return { signupRiskScore: 0, activeCaseSeverity: null };
    }
    const result = await withDeadline(
      this.db.antifraud.query<{
        signup_risk_score: number;
        active_case_severity: string | null;
      }>(
        `
          SELECT
            COALESCE((
              SELECT score FROM signup_assessments WHERE user_id=$1
            ), 0)::int AS signup_risk_score,
            (
              SELECT severity
              FROM cases
              WHERE user_id=$1 AND status <> 'resolved'
              ORDER BY
                CASE severity
                  WHEN 'critical' THEN 4
                  WHEN 'high' THEN 3
                  WHEN 'medium' THEN 2
                  ELSE 1
                END DESC,
                updated_at DESC
              LIMIT 1
            ) AS active_case_severity
        `,
        [input.userID],
      ),
      ANTIFRAUD_READ_TIMEOUT_MS,
      "fiat_history_read",
    );
    return {
      signupRiskScore: result.rows[0]?.signup_risk_score ?? 0,
      activeCaseSeverity: result.rows[0]?.active_case_severity ?? null,
    };
  }

  private async loadVelocity(input: FiatEligibilityRequest): Promise<{
    attempts10m: number;
    deniedAttempts24h: number;
  }> {
    const result = await withDeadline(
      this.db.antifraud.query<{
        attempts_10m: number;
        denied_attempts_24h: number;
      }>(
        `
          SELECT
            COUNT(*) FILTER (
              WHERE created_at >= now() - interval '10 minutes'
            )::int AS attempts_10m,
            COUNT(*) FILTER (
              WHERE created_at >= now() - interval '24 hours'
                AND decision='deny'
            )::int AS denied_attempts_24h
          FROM fiat_eligibility_assessments
          WHERE environment=$1 AND user_id=$2
            AND created_at >= now() - interval '24 hours'
        `,
        [input.env, input.userID],
      ),
      ANTIFRAUD_READ_TIMEOUT_MS,
      "fiat_velocity_read",
    );
    return {
      attempts10m: result.rows[0]?.attempts_10m ?? 0,
      deniedAttempts24h: result.rows[0]?.denied_attempts_24h ?? 0,
    };
  }

  /**
   * Store the assessment and, when the policy demands it, queue containment in
   * the same transaction. Either both land or neither does.
   */
  private async persist(context: {
    input: FiatEligibilityRequest;
    now: Date;
    requestIp: string;
    hash: string;
    subject: SourceSubjectRow;
    identity: ReturnType<typeof fingerprintEventIdentity>;
    providers: EnrichmentResult[];
    behaviour: FiatEligibilityBehaviour;
    network: FiatEligibilityNetwork;
    blocklistMatches: FiatEligibilityBlocklistMatch[];
    additionalBlocklists: FiatEligibilityAdditionalBlocklists;
    observations: FiatPrePaymentObservationEvidence;
    outcome: FiatEligibilityPolicyOutcome;
  }): Promise<FiatEligibilityDecision> {
    const { input, now, providers, outcome } = context;
    const byName = new Map(
      providers.map((provider) => [provider.provider, provider]),
    );
    const expiresAt = new Date(now.getTime() + DECISION_TTL_MS);
    // Containment writes to the production account population, so a dev
    // credential can never trigger one no matter what its source data says.
    const contain =
      outcome.enforce
      && this.containmentEnabled
      && input.env === "prod";
    const providerSignals = providers.flatMap((provider) =>
      provider.signals.map((signal: Signal) => ({
        provider: provider.provider,
        key: signal.key,
        title: signal.title,
        detail: signal.detail,
        points: signal.points,
        payload: signal.payload ?? {},
      })),
    );

    const client = await this.db.antifraud.connect();
    try {
      return await withDeadline(
        this.persistWithin(client, {
          ...context,
          byName,
          expiresAt,
          contain,
          providerSignals,
        }),
        PERSIST_TIMEOUT_MS,
        "fiat_persist",
      );
    } finally {
      client.release();
    }
  }

  private async persistWithin(
    client: pg.PoolClient,
    context: {
      input: FiatEligibilityRequest;
      now: Date;
      requestIp: string;
      hash: string;
      subject: SourceSubjectRow;
      identity: ReturnType<typeof fingerprintEventIdentity>;
      behaviour: FiatEligibilityBehaviour;
      network: FiatEligibilityNetwork;
      blocklistMatches: FiatEligibilityBlocklistMatch[];
      additionalBlocklists: FiatEligibilityAdditionalBlocklists;
      observations: FiatPrePaymentObservationEvidence;
      outcome: FiatEligibilityPolicyOutcome;
      byName: Map<string, EnrichmentResult>;
      expiresAt: Date;
      contain: boolean;
      providerSignals: Array<Record<string, unknown>>;
    },
  ): Promise<FiatEligibilityDecision> {
    const { input, outcome, subject, byName } = context;
    let open = false;
    try {
      await client.query("BEGIN");
      open = true;
      const inserted = await client.query<StoredAssessment>(
        `
          INSERT INTO fiat_eligibility_assessments (
            environment, user_id, request_hash, request_created_at, request_ip,
            fingerprint_request_id, signup_ip, signup_visitor_id,
            checkout_visitor_id, account_age_days, fingerprint_status,
            proxycheck_status, abstract_ip_status,
            risk_score, decision, enforcement, reason_codes,
            enforcement_reasons, signals, behaviour_evidence,
            provider_evidence, expires_at
          )
          VALUES (
            $1, $2, $3, $4, $5::inet,
            $6, $7, $8,
            $9, $10, $11,
            $12, $13,
            $14, $15, $16, $17::text[],
            $18::text[], $19::jsonb, $20::jsonb,
            $21::jsonb, $22
          )
          ON CONFLICT (fingerprint_request_id) DO NOTHING
          RETURNING
            id, request_hash, decision, risk_score, reason_codes,
            enforcement_reasons, enforcement, expires_at, created_at
        `,
        [
          input.env,
          input.userID,
          context.hash,
          new Date(input.createdAt),
          context.requestIp,
          input.fingerprint,
          subject.signup_ip,
          subject.visitor_id,
          context.identity.visitorId,
          accountAgeDays(subject.created_at, context.now),
          byName.get("fingerprint")?.status ?? "skipped",
          byName.get("proxycheck")?.status ?? "skipped",
          byName.get("abstract_ip")?.status ?? "skipped",
          outcome.riskScore,
          outcome.decision,
          context.contain
            ? "contained"
            : outcome.enforce
              ? "suppressed"
              : "none",
          outcome.signals
            .filter((signal) => !signal.evidenceOnly && signal.points > 0)
            .map((signal) => signal.key),
          outcome.enforcementReasons,
          JSON.stringify(outcome.signals),
          JSON.stringify(context.behaviour),
          JSON.stringify({
            providers: Object.fromEntries(
              [...byName.entries()].map(([name, provider]) => [name, {
                status: provider.status,
                score: provider.score ?? null,
                errorCode: provider.errorCode ?? null,
                completeness: provider.completeness,
              }]),
            ),
            identity: context.identity,
            identityBaselines: {
              checkout: {
                ip: context.requestIp,
                visitorId: context.identity.visitorId,
                occurredAt: context.identity.eventTime,
              },
              latestLogin: {
                ip: subject.latest_login_ip,
                visitorId: subject.latest_login_visitor_id,
                occurredAt: subject.latest_login_at,
                confidence: subject.latest_login_confidence,
                suspectedAlt: subject.latest_login_suspected_alt,
              },
              signup: {
                ip: subject.signup_ip,
                visitorId: subject.visitor_id,
              },
            },
            network: context.network,
            reputation: {
              badIp: badIpReputation([...byName.values()]),
              badDevice: badDeviceReputation([...byName.values()]),
            },
            blocklistMatches: context.blocklistMatches.map((match) => ({
              kind: match.kind,
              value: match.value,
              matchedOn: match.matched_on,
            })),
            additionalBlocklists: context.additionalBlocklists,
            observations: context.observations,
            requestContext: {
              amountCents: input.amountCents ?? null,
              currency: input.currency?.toUpperCase() ?? null,
              locale: input.locale ?? null,
              timezone: input.timezone ?? null,
            },
            providerSignals: context.providerSignals,
          }),
          context.expiresAt,
        ],
      );

      const row = inserted.rows[0];
      if (!row) {
        // Another delivery of the same Fingerprint event won the insert.
        await client.query("ROLLBACK");
        open = false;
        const existing = await this.existing(input.fingerprint);
        if (!existing) throw new Error("fiat_eligibility_persistence_failed");
        if (existing.request_hash !== context.hash) {
          throw new FingerprintReuseError();
        }
        return storedDecision(existing, true);
      }

      if (context.contain) {
        await queueFiatEligibilityContainment(client, {
          assessmentId: row.id,
          environment: "prod",
          subject: {
            id: subject.id,
            username: subject.username,
            email: subject.email,
            image: subject.image,
            signup_ip: subject.signup_ip,
            country: subject.country,
            country_code: subject.country_code,
            continent_code: subject.continent_code,
            state: subject.state,
            city: subject.city,
            affiliate_code: subject.affiliate_code,
            referred_by: subject.referred_by,
            created_at: subject.created_at,
          },
          reasonCodes: outcome.enforcementReasons,
          riskScore: outcome.riskScore,
          occurredAt: context.now,
          blocklistMatches: context.blocklistMatches.filter(
            (match) => match.effect === "block",
          ),
          evidence: {
            requestIpFamily: context.requestIp.includes(":") ? 6 : 4,
            accountAgeDays: Number(
              accountAgeDays(subject.created_at, context.now).toFixed(4),
            ),
            behaviour: context.behaviour,
          },
        });
      }

      await client.query("COMMIT");
      open = false;
      return storedDecision(row, false);
    } catch (error) {
      if (open) await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }

  private async denyGloballyDisabled(
    input: FiatEligibilityRequest,
    now: Date,
    hash: string,
  ): Promise<FiatEligibilityDecision> {
    const inserted = await this.db.antifraud.query<{
      id: string;
      request_hash: string;
      created_at: Date;
    }>(
      `
        INSERT INTO fiat_eligibility_gate_events (
          environment, user_id, fingerprint_request_id, request_hash,
          decision, reason_code, created_at
        ) VALUES ($1,$2,$3,$4,'deny','fiat_globally_disabled',$5)
        ON CONFLICT (fingerprint_request_id) DO NOTHING
        RETURNING id, request_hash, created_at
      `,
      [input.env, input.userID, input.fingerprint, hash, now],
    );
    let row = inserted.rows[0];
    if (!row) {
      const existing = await this.db.antifraud.query<{
        id: string;
        request_hash: string;
        created_at: Date;
      }>(
        `
          SELECT id, request_hash, created_at
          FROM fiat_eligibility_gate_events
          WHERE fingerprint_request_id=$1
          LIMIT 1
        `,
        [input.fingerprint],
      );
      row = existing.rows[0];
    }
    if (!row) throw new Error("fiat_disabled_decision_persistence_failed");
    if (row.request_hash !== hash) throw new FingerprintReuseError();
    return {
      decisionId: row.id,
      decision: "deny",
      allowed: false,
      timestamp: row.created_at.toISOString(),
      riskScore: 0,
      reasonCodes: ["fiat_globally_disabled"],
      expiresAt: row.created_at.toISOString(),
      idempotent: (inserted.rowCount ?? 0) === 0,
      contained: false,
      enforcementReasons: [],
    };
  }
}

export const fiatEligibilityInternals = {
  automaticReview: evaluateFiatEligibility,
  loadSourceSubject,
  loadBlocklistMatches,
  loadAdditionalBlocklists,
  loadPrePaymentObservations,
  behaviourSignals,
  badIpReputation,
  badDeviceReputation,
  requestHash,
  AUTOMATIC_DENY_SCORE,
  MAX_REQUEST_AGE_MS,
  MAX_FUTURE_SKEW_MS,
  CORROBORATING_PROVIDER_TIMEOUT_MS,
  CONTAINMENT_EVENT: FIAT_ELIGIBILITY_CONTAINMENT_EVENT,
  GAME_WAGER_TYPES,
  GAME_PAYOUT_TYPES,
  REWARD_TYPES,
};

export type { FiatEligibilitySignal };
