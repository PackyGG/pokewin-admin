import { createHash } from "node:crypto";

import type pg from "pg";

import type { EnrichmentResult } from "./enrichment.js";
import {
  networkClusterKeys,
  type ProfileAssessment,
} from "./profile-risk.js";
import type { Signup } from "./types.js";

type Queryable = {
  query(sql: string, values?: unknown[]): Promise<unknown>;
};

export async function persistSignupIdentitySnapshot(
  db: Queryable,
  signup: Signup,
): Promise<void> {
  const network = networkClusterKeys(signup.signup_ip);
  await db.query(
    `
      INSERT INTO signup_identity_snapshots (
        user_id, source_created_at, earliest_auth_provider,
        auth_provider_timeline, signup_ip, ipv6_subnet_64, ipv6_subnet_56,
        ipv6_subnet_48, fingerprint_request_id, fingerprint_visitor_id,
        fingerprint_confidence, affiliate_code, referred_by, country_code,
        is_creator
      ) VALUES (
        $1,$2,$3,$4::jsonb,$5::inet,$6::cidr,$7::cidr,$8::cidr,$9,$10,$11,
        $12,$13,$14,$15
      )
      ON CONFLICT (user_id) DO NOTHING
    `,
    [
      signup.id,
      signup.created_at,
      signup.auth_provider ?? null,
      JSON.stringify(signup.auth_providers ?? []),
      network.exact,
      network.family === 6 ? network.subnet : null,
      network.family === 6 ? network.evidenceSubnet : null,
      network.family === 6 ? network.baselineSubnet : null,
      signup.fingerprint_request_id,
      signup.visitor_id,
      signup.fingerprint_confidence,
      signup.affiliate_code,
      signup.referred_by,
      signup.country_code,
      signup.is_creator ?? false,
    ],
  );
}

export async function persistProviderEvidence(
  db: Queryable,
  userId: string,
  result: EnrichmentResult,
  occurrenceKey: string,
): Promise<void> {
  const evidenceKey = createHash("sha256")
    .update(
      JSON.stringify([
        occurrenceKey,
        result.provider,
        result.lookupKey,
        result.requestId ?? null,
      ]),
    )
    .digest("hex");
  await db.query(
    `
      INSERT INTO profile_provider_evidence (
        user_id, provider, lookup_key, evidence_key, request_id, outcome, failure_kind,
        raw_evidence, normalized_signals, provider_score, observed_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,now())
      ON CONFLICT (user_id, provider, evidence_key) DO NOTHING
    `,
    [
      userId,
      result.provider,
      result.lookupKey,
      evidenceKey,
      result.requestId ?? null,
      result.status,
      result.status === "failed" ? classifyProviderFailure(result.errorCode) : null,
      // EnrichmentResult.response is the allowlisted, sanitized parser output.
      // This boundary must never receive or persist an unrestricted upstream body.
      JSON.stringify(result.response ?? null),
      JSON.stringify(result.signals),
      result.score ?? null,
    ],
  );
}

function classifyProviderFailure(
  errorCode: string | undefined,
): "timeout" | "rate_limited" | "authentication" | "invalid_response" | "upstream" | "unknown" {
  const code = errorCode?.toLowerCase() ?? "";
  if (/timeout|abort/.test(code)) return "timeout";
  if (/429|rate/.test(code)) return "rate_limited";
  if (/401|403|auth|key/.test(code)) return "authentication";
  if (/parse|invalid|schema/.test(code)) return "invalid_response";
  if (/5\d\d|upstream/.test(code)) return "upstream";
  return "unknown";
}

export async function persistProfileAssessment(
  client: pg.PoolClient,
  input: {
    userId: string;
    sourceRef: string;
    assessment: ProfileAssessment;
    assessedAt: Date;
  },
): Promise<string> {
  const assessment = input.assessment;
  const history = await client.query<{ id: string }>(
    `
      INSERT INTO profile_assessment_history (
        user_id, assessment_version, source_ref, raw_score, score, severity,
        outcome, completeness, confidence, provider_status, policy_matches,
        recommended_actions, monitor_duration_seconds, explanation, assessed_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,
        $13,$14::jsonb,$15
      )
      ON CONFLICT (user_id, assessment_version, source_ref) DO UPDATE SET
        raw_score = EXCLUDED.raw_score,
        score = EXCLUDED.score,
        severity = EXCLUDED.severity,
        outcome = EXCLUDED.outcome,
        completeness = EXCLUDED.completeness,
        confidence = EXCLUDED.confidence,
        provider_status = EXCLUDED.provider_status,
        policy_matches = EXCLUDED.policy_matches,
        recommended_actions = EXCLUDED.recommended_actions,
        monitor_duration_seconds = EXCLUDED.monitor_duration_seconds,
        explanation = EXCLUDED.explanation,
        assessed_at = EXCLUDED.assessed_at
      RETURNING id
    `,
    [
      input.userId,
      assessment.version,
      input.sourceRef,
      assessment.rawScore,
      assessment.score,
      assessment.severity,
      assessment.outcome,
      assessment.completeness,
      assessment.confidence,
      JSON.stringify(assessment.providerStatus),
      JSON.stringify(assessment.policyMatches),
      JSON.stringify(assessment.recommendedActions),
      assessment.monitorDurationSeconds,
      JSON.stringify(assessment.explanation),
      input.assessedAt,
    ],
  );
  const assessmentId = history.rows[0]?.id;
  if (!assessmentId) throw new Error("Profile assessment history write failed");

  await client.query(
    `
      INSERT INTO antifraud_profiles (
        user_id, current_assessment_id, assessment_version, raw_score, score,
        severity, outcome, completeness, confidence, provider_status,
        policy_matches, recommended_actions, monitor_duration_seconds,
        explanation, assessed_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,
        $13,$14::jsonb,$15,now()
      )
      ON CONFLICT (user_id) DO UPDATE SET
        current_assessment_id = EXCLUDED.current_assessment_id,
        assessment_version = EXCLUDED.assessment_version,
        raw_score = EXCLUDED.raw_score,
        score = EXCLUDED.score,
        severity = EXCLUDED.severity,
        outcome = EXCLUDED.outcome,
        completeness = EXCLUDED.completeness,
        confidence = EXCLUDED.confidence,
        provider_status = EXCLUDED.provider_status,
        policy_matches = EXCLUDED.policy_matches,
        recommended_actions = EXCLUDED.recommended_actions,
        monitor_duration_seconds = EXCLUDED.monitor_duration_seconds,
        explanation = EXCLUDED.explanation,
        assessed_at = EXCLUDED.assessed_at,
        updated_at = now()
    `,
    [
      input.userId,
      assessmentId,
      assessment.version,
      assessment.rawScore,
      assessment.score,
      assessment.severity,
      assessment.outcome,
      assessment.completeness,
      assessment.confidence,
      JSON.stringify(assessment.providerStatus),
      JSON.stringify(assessment.policyMatches),
      JSON.stringify(assessment.recommendedActions),
      assessment.monitorDurationSeconds,
      JSON.stringify(assessment.explanation),
      input.assessedAt,
    ],
  );
  await client.query(
    "DELETE FROM profile_assessment_signals WHERE assessment_id=$1",
    [assessmentId],
  );
  for (const signal of assessment.signals) {
    await client.query(
      `
        INSERT INTO profile_assessment_signals (
          assessment_id, signal_key, category, title, detail, raw_points,
          effective_points, hard_policy, evidence_only, suppressed_reason,
          observed_at, payload
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
        ON CONFLICT (assessment_id, signal_key) DO UPDATE SET
          category = EXCLUDED.category,
          title = EXCLUDED.title,
          detail = EXCLUDED.detail,
          raw_points = GREATEST(
            profile_assessment_signals.raw_points,
            EXCLUDED.raw_points
          ),
          effective_points = GREATEST(
            profile_assessment_signals.effective_points,
            EXCLUDED.effective_points
          ),
          hard_policy = COALESCE(
            profile_assessment_signals.hard_policy,
            EXCLUDED.hard_policy
          ),
          evidence_only = (
            profile_assessment_signals.evidence_only
            AND EXCLUDED.evidence_only
          ),
          suppressed_reason = COALESCE(
            profile_assessment_signals.suppressed_reason,
            EXCLUDED.suppressed_reason
          ),
          observed_at = LEAST(
            profile_assessment_signals.observed_at,
            EXCLUDED.observed_at
          ),
          payload = profile_assessment_signals.payload || EXCLUDED.payload
      `,
      [
        assessmentId,
        signal.key,
        signal.category,
        signal.title,
        signal.detail,
        signal.points,
        signal.effectivePoints,
        signal.hardPolicy ?? null,
        signal.evidenceOnly ?? false,
        signal.suppressedReason ?? null,
        signal.observedAt,
        JSON.stringify(signal.payload ?? {}),
      ],
    );
  }
  return assessmentId;
}
