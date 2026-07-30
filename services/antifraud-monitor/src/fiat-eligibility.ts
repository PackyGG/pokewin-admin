import { createHash } from "node:crypto";

import type { Pool } from "pg";

import type { Databases } from "./db.js";
import {
  canonicalIp,
  EnrichmentService,
  fingerprintEventIdentity,
  type EnrichmentResult,
} from "./enrichment.js";
import type { FiatEligibilityEnvironment } from "./fiat-eligibility-auth.js";
import type { ScoreWeightStore } from "./score-weight-store.js";
import type { Signal, Signup } from "./types.js";

export type FiatEligibilityRequest = {
  env: FiatEligibilityEnvironment;
  createdAt: string;
  ipAddress: string;
  fingerprint: string;
  userID: string;
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
};

type SourceSubject = Signup & {
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

type NetworkEvidence = {
  sharedCheckoutVisitorUsers: number;
  sharedCurrentIpUsers: number;
};

type StoredAssessment = {
  id: string;
  request_hash: string;
  decision: "allow" | "deny";
  risk_score: number;
  reason_codes: string[];
  expires_at: Date;
  created_at: Date;
};

export type FiatEligibilitySignal = {
  key: string;
  detail: string;
  points: number;
  blocking: boolean;
  source: "account" | "request" | "fingerprint" | "ip" | "network" | "history";
};

type AutomaticReviewInput = {
  now: Date;
  requestCreatedAt: Date;
  subject: SourceSubject;
  requestIp: string;
  fingerprint: EnrichmentResult;
  proxycheck: EnrichmentResult;
  fingerprintIdentity: ReturnType<typeof fingerprintEventIdentity>;
  network: NetworkEvidence;
  signupRiskScore: number;
  activeCaseSeverity: string | null;
  attempts10m: number;
  deniedAttempts24h: number;
};

const DECISION_TTL_MS = 60_000;
const MAX_REQUEST_AGE_MS = 120_000;
const MAX_FUTURE_SKEW_MS = 30_000;
const AUTOMATIC_DENY_SCORE = 50;
const HARD_FINGERPRINT_SIGNALS = new Set([
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

export class FingerprintReuseError extends Error {
  constructor() {
    super("Fingerprint event was already used for a different request");
    this.name = "FingerprintReuseError";
  }
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function ageDays(createdAt: Date, now: Date): number {
  return Math.max(0, (now.getTime() - createdAt.getTime()) / 86_400_000);
}

function automaticReview(input: AutomaticReviewInput): {
  decision: "allow" | "deny";
  riskScore: number;
  signals: FiatEligibilitySignal[];
} {
  const signals: FiatEligibilitySignal[] = [];
  const add = (
    hit: boolean,
    signal: Omit<FiatEligibilitySignal, "blocking"> & { blocking?: boolean },
  ) => {
    if (hit) signals.push({ ...signal, blocking: signal.blocking ?? false });
  };
  const accountAgeDays = ageDays(input.subject.created_at, input.now);
  const established = accountAgeDays >= 7;

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
  add(input.subject.is_suspected_alt, {
    key: "suspected_alt_account",
    detail: "The account is marked as a suspected alternate account.",
    points: 55,
    source: "account",
  });
  add(accountAgeDays < 1, {
    key: "account_younger_than_one_day",
    detail: "The account is less than one day old.",
    points: 30,
    source: "account",
  });
  add(accountAgeDays >= 1 && accountAgeDays < 7, {
    key: "account_younger_than_seven_days",
    detail: "The account is less than seven days old.",
    points: 15,
    source: "account",
  });

  const requestAge = input.now.getTime() - input.requestCreatedAt.getTime();
  add(
    requestAge > MAX_REQUEST_AGE_MS || requestAge < -MAX_FUTURE_SKEW_MS,
    {
      key: "stale_request",
      detail: "The backend request timestamp is outside the accepted window.",
      points: 100,
      blocking: true,
      source: "request",
    },
  );
  add(
    Boolean(
      input.subject.signup_ip
      && canonicalIp(input.subject.signup_ip) !== input.requestIp
    ),
    {
      key: "signup_ip_changed",
      detail: "The checkout IP differs from the signup IP.",
      points: established ? 10 : 25,
      source: "network",
    },
  );

  add(input.fingerprint.status !== "success", {
    key: "fingerprint_check_unavailable",
    detail: "The full Fingerprint event check did not succeed.",
    points: 100,
    blocking: true,
    source: "fingerprint",
  });
  add(input.proxycheck.status !== "success", {
    key: "ip_check_unavailable",
    detail: "The full independent IP check did not succeed.",
    points: 100,
    blocking: true,
    source: "ip",
  });

  if (input.fingerprint.status === "success") {
    const identity = input.fingerprintIdentity;
    add(identity.linkedId !== input.subject.id, {
      key: identity.linkedId
        ? "fingerprint_linked_id_mismatch"
        : "fingerprint_linked_id_missing",
      detail: identity.linkedId
        ? "The Fingerprint event is linked to another user."
        : "The Fingerprint event is not linked to the requested user.",
      points: 100,
      blocking: true,
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
    add(
      eventAge > MAX_REQUEST_AGE_MS || eventAge < -MAX_FUTURE_SKEW_MS,
      {
        key: "fingerprint_event_stale",
        detail: "The Fingerprint event is missing a fresh trusted timestamp.",
        points: 100,
        blocking: true,
        source: "fingerprint",
      },
    );
    add(identity.replayed, {
      key: "fingerprint_event_replayed",
      detail: "Fingerprint marked the event as replayed.",
      points: 100,
      blocking: true,
      source: "fingerprint",
    });
    add(
      Boolean(
        input.subject.visitor_id
        && identity.visitorId
        && input.subject.visitor_id !== identity.visitorId
      ),
      {
        key: "signup_fingerprint_changed",
        detail: "The checkout device differs from the signup device.",
        points: established ? 20 : 35,
        source: "fingerprint",
      },
    );
  }

  for (const providerSignal of input.fingerprint.signals) {
    add(providerSignal.points > 0, {
      key: providerSignal.key,
      detail: providerSignal.detail,
      points: providerSignal.points,
      blocking: HARD_FINGERPRINT_SIGNALS.has(providerSignal.key),
      source: "fingerprint",
    });
  }
  for (const providerSignal of input.proxycheck.signals) {
    add(providerSignal.points > 0, {
      key: providerSignal.key,
      detail: providerSignal.detail,
      points: providerSignal.points,
      source: "ip",
    });
  }

  add(input.network.sharedCheckoutVisitorUsers > 0, {
    key: "checkout_device_shared",
    detail: `${input.network.sharedCheckoutVisitorUsers} other account(s) use the checkout device.`,
    points: input.network.sharedCheckoutVisitorUsers >= 3 ? 70 : 40,
    source: "network",
  });
  add(input.network.sharedCurrentIpUsers >= 3, {
    key: "checkout_ip_shared",
    detail: `${input.network.sharedCurrentIpUsers} other account(s) signed up from the checkout IP.`,
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
      detail: `The account has an active ${input.activeCaseSeverity} Antifraud case.`,
      points: 60,
      source: "history",
    },
  );
  add(input.attempts10m >= 5, {
    key: "fiat_eligibility_velocity",
    detail: `${input.attempts10m} Fiat eligibility attempts were made in ten minutes.`,
    points: input.attempts10m >= 10 ? 70 : 35,
    source: "history",
  });
  add(input.deniedAttempts24h >= 3, {
    key: "repeated_fiat_denials",
    detail: `${input.deniedAttempts24h} Fiat eligibility attempts were denied in 24 hours.`,
    points: input.deniedAttempts24h >= 6 ? 60 : 25,
    source: "history",
  });

  const deduped = [...new Map(
    signals.map((signal) => [
      signal.key,
      {
        ...signal,
        points: Math.max(
          signal.points,
          ...signals
            .filter((candidate) => candidate.key === signal.key)
            .map((candidate) => candidate.points),
        ),
        blocking: signals.some(
          (candidate) => candidate.key === signal.key && candidate.blocking,
        ),
      },
    ]),
  ).values()];
  const trustCredit =
    established
    && input.subject.prior_paid_fiat > 0
    && !deduped.some((signal) => signal.blocking)
      ? Math.min(15, 5 + input.subject.prior_paid_fiat)
      : 0;
  if (trustCredit > 0) {
    deduped.push({
      key: "established_fiat_history",
      detail: `The established account has ${input.subject.prior_paid_fiat} completed Fiat deposit(s).`,
      points: -trustCredit,
      blocking: false,
      source: "history",
    });
  }
  const riskScore = clampScore(
    deduped.reduce((total, signal) => total + signal.points, 0),
  );
  const decision =
    deduped.some((signal) => signal.blocking)
    || riskScore >= AUTOMATIC_DENY_SCORE
      ? "deny"
      : "allow";
  return { decision, riskScore, signals: deduped };
}

async function loadSourceSubject(
  source: Pool,
  userId: string,
): Promise<SourceSubject | null> {
  const result = await source.query<SourceSubject>(
    `
      SELECT
        u.id, u.username, u.email, u.image, u.signup_ip, u.country,
        u.country_code, u.continent_code, u.state, u.city, u.affiliate_code,
        u.referred_by, u.is_suspected_alt,
        u.created_at AT TIME ZONE 'UTC' AS created_at,
        u.is_banned, u.is_locked, u.is_self_excluded,
        fp.request_id AS fingerprint_request_id,
        fp.visitor_id,
        fp.confidence AS fingerprint_confidence,
        fp.ip::text AS fingerprint_ip,
        ae.user_agent,
        COALESCE(cardinality(ufl.locked_deposits_fiat), 0) > 0 AS fiat_locked,
        COALESCE(cr.blocked, false) AS country_blocked,
        COALESCE(cardinality(cr.locked_deposits_fiat), 0) > 0
          AS country_fiat_locked,
        COALESCE(uk.kyc_required, false) AS kyc_required,
        COALESCE(uk.status::text, 'none') AS kyc_status,
        COALESCE(uk.admin_decision::text, 'pending') AS kyc_admin_decision,
        (
          SELECT COUNT(*)::int
          FROM fiat_deposit_intents fdi
          WHERE fdi.user_id = u.id
            AND fdi.paid_at IS NOT NULL
        ) AS prior_paid_fiat
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
        SELECT user_agent
        FROM audit_events
        WHERE user_id = u.id AND event_type = 'register'
        ORDER BY created_at DESC
        LIMIT 1
      ) ae ON true
      WHERE u.id = $1
      LIMIT 1
    `,
    [userId],
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
): Promise<NetworkEvidence> {
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

function requestHash(input: FiatEligibilityRequest, requestIp: string): string {
  return createHash("sha256")
    .update([
      input.env,
      input.createdAt,
      requestIp,
      input.fingerprint,
      input.userID,
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
          expires_at, created_at
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
      return {
        ...await active.promise,
        idempotent: true,
      };
    }
    const promise = this.assessOnce(input, now, requestIp, hash);
    this.inFlight.set(input.fingerprint, {
      requestHash: hash,
      promise,
    });
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
    const previous = await this.existing(input.fingerprint);
    if (previous) {
      if (previous.request_hash !== hash) throw new FingerprintReuseError();
      return storedDecision(previous, true);
    }

    const source = this.sourceFor(input.env);
    const subject = await loadSourceSubject(source, input.userID);
    if (!subject) {
      throw new Error("fiat_subject_not_found");
    }
    const requestCreatedAt = new Date(input.createdAt);
    const weights = await this.scoreWeights.get();
    const providerSubject: Signup = {
      ...subject,
      signup_ip: requestIp,
      fingerprint_ip: null,
      fingerprint_request_id: input.fingerprint,
    };
    const [fingerprint, proxycheck, fraudHistory, velocity] = await Promise.all([
      this.enrichment.fingerprintCheck(providerSubject, weights),
      this.enrichment.proxycheck(providerSubject, weights, "fiat-eligibility"),
      input.env === "prod"
        ? this.db.antifraud.query<{
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
          )
        : Promise.resolve({ rows: [] }),
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
    ]);
    const identity = fingerprintEventIdentity(fingerprint.response);
    const network = await loadNetworkEvidence(source, {
      userId: input.userID,
      requestIp,
      checkoutVisitorId: identity.visitorId,
    });
    const reviewed = automaticReview({
      now,
      requestCreatedAt,
      subject,
      requestIp,
      fingerprint,
      proxycheck,
      fingerprintIdentity: identity,
      network,
      signupRiskScore: fraudHistory.rows[0]?.signup_risk_score ?? 0,
      activeCaseSeverity:
        fraudHistory.rows[0]?.active_case_severity ?? null,
      attempts10m: velocity.rows[0]?.attempts_10m ?? 0,
      deniedAttempts24h: velocity.rows[0]?.denied_attempts_24h ?? 0,
    });
    const expiresAt = new Date(now.getTime() + DECISION_TTL_MS);
    const providerSignals = [
      ...fingerprint.signals,
      ...proxycheck.signals,
    ].map((signal: Signal) => ({
      key: signal.key,
      title: signal.title,
      detail: signal.detail,
      points: signal.points,
      payload: signal.payload ?? {},
    }));
    const inserted = await this.db.antifraud.query<StoredAssessment>(
      `
        INSERT INTO fiat_eligibility_assessments (
          environment, user_id, request_hash, request_created_at, request_ip,
          fingerprint_request_id, signup_ip, signup_visitor_id,
          checkout_visitor_id, account_age_days, fingerprint_status,
          proxycheck_status, risk_score, decision, reason_codes, signals,
          provider_evidence, expires_at
        )
        VALUES (
          $1, $2, $3, $4, $5::inet,
          $6, $7, $8,
          $9, $10, $11,
          $12, $13, $14, $15::text[], $16::jsonb,
          $17::jsonb, $18
        )
        ON CONFLICT (fingerprint_request_id) DO NOTHING
        RETURNING
          id, request_hash, decision, risk_score, reason_codes,
          expires_at, created_at
      `,
      [
        input.env,
        input.userID,
        hash,
        requestCreatedAt,
        requestIp,
        input.fingerprint,
        subject.signup_ip,
        subject.visitor_id,
        identity.visitorId,
        ageDays(subject.created_at, now),
        fingerprint.status,
        proxycheck.status,
        reviewed.riskScore,
        reviewed.decision,
        reviewed.signals
          .filter((signal) => signal.points > 0)
          .map((signal) => signal.key),
        JSON.stringify(reviewed.signals),
        JSON.stringify({
          fingerprint: {
            status: fingerprint.status,
            score: fingerprint.score ?? null,
            errorCode: fingerprint.errorCode ?? null,
            identity,
          },
          proxycheck: {
            status: proxycheck.status,
            score: proxycheck.score ?? null,
            errorCode: proxycheck.errorCode ?? null,
          },
          providerSignals,
          network,
        }),
        expiresAt,
      ],
    );
    const row = inserted.rows[0] ?? await this.existing(input.fingerprint);
    if (!row) throw new Error("fiat_eligibility_persistence_failed");
    if (row.request_hash !== hash) throw new FingerprintReuseError();
    return storedDecision(row, inserted.rows.length === 0);
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
    };
  }
}

export const fiatEligibilityInternals = {
  automaticReview,
  requestHash,
  AUTOMATIC_DENY_SCORE,
  MAX_REQUEST_AGE_MS,
};
