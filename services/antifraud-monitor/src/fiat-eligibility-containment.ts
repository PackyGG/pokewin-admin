import type pg from "pg";

import type { FiatEligibilityBlocklistMatch } from "./fiat-eligibility-policy.js";
import { severity } from "./scoring.js";

/**
 * Durable containment for an automatically denied Fiat checkout.
 *
 * The endpoint itself NEVER writes to the game database. It records a
 * `fiat_eligibility_containment` risk event in the Antifraud database inside the
 * same transaction that stores the assessment, and the existing signed
 * ingest-delivery path hands that event to the dashboard, which applies the
 * MAIN lock under an advisory lock with its own audit trail. Consequences of
 * that split, all of them wanted:
 *
 *   • the backend gets its deny in provider latency, never waiting on a write;
 *   • the lock retries until the dashboard accepts it, so a transient MAIN
 *     outage delays containment instead of losing it;
 *   • a re-sent event cannot re-lock an account staff already released, because
 *     the dashboard dedupes on the event id.
 *
 * `subjects` is upserted first: `risk_events.user_id` is a foreign key to it,
 * and a checkout can be the first time this service ever sees an account.
 */

export const FIAT_ELIGIBILITY_CONTAINMENT_EVENT =
  "fiat_eligibility_containment";
const CONTAINMENT_SOURCE = "fiat_eligibility";
/** Floor the dashboard re-checks before it will apply a lock. */
const CONTAINMENT_SCORE = 100;

export type ContainmentSubject = {
  id: string;
  username: string | null;
  email: string | null;
  image: string | null;
  signup_ip: string | null;
  country: string | null;
  country_code: string | null;
  continent_code: string | null;
  state: string | null;
  city: string | null;
  affiliate_code: string | null;
  referred_by: string | null;
  created_at: Date;
};

export type ContainmentInput = {
  assessmentId: string;
  environment: "dev" | "prod";
  subject: ContainmentSubject;
  reasonCodes: readonly string[];
  riskScore: number;
  occurredAt: Date;
  blocklistMatches: readonly FiatEligibilityBlocklistMatch[];
  evidence: Record<string, unknown>;
};

function containmentDetail(reasonCodes: readonly string[]): string {
  return (
    "An automatic Fiat checkout assessment matched "
    + `${reasonCodes.length} containment rule`
    + `${reasonCodes.length === 1 ? "" : "s"} (${reasonCodes.join(", ")}). `
    + "Fiat deposits and withdrawals require an idempotent lock."
  ).slice(0, 1000);
}

/**
 * Queue containment for one denied assessment. Must run inside the caller's
 * transaction so the assessment row and the containment command commit
 * together — a stored deny with no queued lock, or a lock with no assessment to
 * justify it, would both be wrong.
 *
 * Returns the risk-event id, or null when an identical event already exists
 * (same assessment delivered twice).
 */
export async function queueFiatEligibilityContainment(
  client: pg.PoolClient,
  input: ContainmentInput,
): Promise<string | null> {
  if (input.environment !== "prod") {
    throw new Error("fiat_containment_prod_only");
  }
  if (input.reasonCodes.length === 0) {
    throw new Error("fiat_containment_requires_reason");
  }

  await client.query(
    `
      INSERT INTO subjects (
        user_id, username, email, avatar_url, signup_ip, country,
        country_code, continent_code, state, city, affiliate_code,
        referred_by, source_created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (user_id) DO UPDATE SET
        username = COALESCE(EXCLUDED.username, subjects.username),
        email = COALESCE(EXCLUDED.email, subjects.email),
        avatar_url = COALESCE(EXCLUDED.avatar_url, subjects.avatar_url),
        signup_ip = COALESCE(EXCLUDED.signup_ip, subjects.signup_ip),
        country = COALESCE(EXCLUDED.country, subjects.country),
        country_code = COALESCE(EXCLUDED.country_code, subjects.country_code),
        continent_code =
          COALESCE(EXCLUDED.continent_code, subjects.continent_code),
        state = COALESCE(EXCLUDED.state, subjects.state),
        city = COALESCE(EXCLUDED.city, subjects.city),
        affiliate_code =
          COALESCE(EXCLUDED.affiliate_code, subjects.affiliate_code),
        referred_by = COALESCE(EXCLUDED.referred_by, subjects.referred_by),
        updated_at = now()
    `,
    [
      input.subject.id,
      input.subject.username,
      input.subject.email,
      input.subject.image,
      input.subject.signup_ip,
      input.subject.country,
      input.subject.country_code,
      input.subject.continent_code,
      input.subject.state,
      input.subject.city,
      input.subject.affiliate_code,
      input.subject.referred_by,
      input.subject.created_at,
    ],
  );

  const caseResult = await client.query<{ id: string }>(
    `
      INSERT INTO cases (
        user_id, subject_type, status, severity, score, peak_score, summary
      ) VALUES (
        $1, 'account', 'open', $2, $3, $3,
        'Automatic Fiat checkout containment'
      )
      ON CONFLICT (user_id) WHERE subject_type = 'account'
        AND status IN ('open','monitoring','in_review','escalated')
      DO UPDATE SET
        score = GREATEST(cases.score, EXCLUDED.score),
        peak_score = GREATEST(cases.peak_score, EXCLUDED.peak_score),
        severity = CASE
          WHEN cases.peak_score >= EXCLUDED.peak_score THEN cases.severity
          ELSE EXCLUDED.severity
        END,
        updated_at = now()
      RETURNING id
    `,
    [input.subject.id, severity(CONTAINMENT_SCORE), CONTAINMENT_SCORE],
  );
  const caseId = caseResult.rows[0]?.id;
  if (!caseId) throw new Error("fiat_containment_case_not_created");

  const inserted = await client.query<{ id: string }>(
    `
      INSERT INTO risk_events (
        case_id, session_id, user_id, event_type, source, source_ref,
        score_delta, score_after, title, detail, payload, occurred_at
      ) VALUES (
        $1,NULL,$2,'${FIAT_ELIGIBILITY_CONTAINMENT_EVENT}',
        '${CONTAINMENT_SOURCE}',$3,0,$4,
        'Automatic Fiat checkout containment',$5,$6::jsonb,$7
      )
      ON CONFLICT (source, source_ref) WHERE source_ref IS NOT NULL
      DO NOTHING
      RETURNING id
    `,
    [
      caseId,
      input.subject.id,
      `fiat-eligibility-containment:${input.assessmentId}`,
      CONTAINMENT_SCORE,
      containmentDetail(input.reasonCodes),
      JSON.stringify({
        containmentRequired: true,
        environment: input.environment,
        assessmentId: input.assessmentId,
        reasonCodes: [...input.reasonCodes],
        assessmentRiskScore: input.riskScore,
        ...input.evidence,
      }),
      input.occurredAt,
    ],
  );

  // Operator-blocklist hits are recorded against the rule that fired so the
  // blocklist workspace shows checkout enforcement, not only signup matches.
  for (const match of input.blocklistMatches) {
    await client.query(
      `
        INSERT INTO identifier_blocklist_matches (
          blocklist_id, user_id, source_ref, match_context, resulting_action,
          evidence, matched_at
        ) VALUES (
          $1,$2,$3,'fiat_checkout','locked',
          jsonb_build_object('kind',$4::text,'value',$5::text),
          $6
        )
        ON CONFLICT (blocklist_id, user_id, source_ref) DO NOTHING
      `,
      [
        match.id,
        input.subject.id,
        `fiat-eligibility:${input.assessmentId}`,
        match.kind,
        match.value,
        input.occurredAt,
      ],
    );
  }

  return inserted.rows[0]?.id ?? null;
}
