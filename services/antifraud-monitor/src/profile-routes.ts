import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Databases } from "./db.js";

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  search: z.string().trim().max(100).optional(),
  outcome: z
    .enum(["clear", "monitor", "review_required", "incomplete", "unknown"])
    .optional(),
  blocklist: z.string().uuid().optional(),
});

export async function registerProfileRoutes(
  app: FastifyInstance,
  db: Databases,
): Promise<void> {
  app.get("/v1/profiles", async (request) => {
    const query = listQuerySchema.parse(request.query);
    const search = query.search ? `${query.search.toLowerCase()}%` : null;
    const offset = (query.page - 1) * query.limit;
    const [profiles, count] = await Promise.all([
      db.antifraud.query<{
        user_id: string;
        username: string | null;
        email: string | null;
        avatar_url: string | null;
        country_code: string | null;
        source_created_at: Date;
        score: number;
        raw_score: number;
        severity: string;
        outcome: string;
        completeness: string;
        confidence: number;
        policy_matches: unknown;
        assessed_at: Date;
        updated_at: Date;
      }>(
        `
          SELECT
            p.user_id,s.username,s.email,s.avatar_url,s.country_code,
            s.source_created_at,p.score,p.raw_score,p.severity,p.outcome,
            p.completeness,p.confidence,p.policy_matches,p.assessed_at,
            p.updated_at
          FROM antifraud_profiles p
          JOIN subjects s ON s.user_id=p.user_id
          WHERE ($1::text IS NULL OR p.outcome=$1)
            AND (
              $5::uuid IS NULL
              OR EXISTS (
                SELECT 1 FROM identifier_blocklist_matches bm
                WHERE bm.user_id=p.user_id AND bm.blocklist_id=$5
              )
            )
            AND (
              $2::text IS NULL
              OR lower(p.user_id) LIKE $2
              OR lower(COALESCE(s.username,'')) LIKE $2
              OR lower(COALESCE(s.email,'')) LIKE $2
            )
          ORDER BY p.score DESC,p.assessed_at DESC,p.user_id
          LIMIT $3 OFFSET $4
        `,
        [query.outcome ?? null, search, query.limit, offset, query.blocklist ?? null],
      ),
      db.antifraud.query<{ count: number }>(
        `
          SELECT count(*)::int AS count
          FROM antifraud_profiles p
          JOIN subjects s ON s.user_id=p.user_id
          WHERE ($1::text IS NULL OR p.outcome=$1)
            AND (
              $3::uuid IS NULL
              OR EXISTS (
                SELECT 1 FROM identifier_blocklist_matches bm
                WHERE bm.user_id=p.user_id AND bm.blocklist_id=$3
              )
            )
            AND (
              $2::text IS NULL
              OR lower(p.user_id) LIKE $2
              OR lower(COALESCE(s.username,'')) LIKE $2
              OR lower(COALESCE(s.email,'')) LIKE $2
            )
        `,
        [query.outcome ?? null, search, query.blocklist ?? null],
      ),
    ]);
    const total = count.rows[0]?.count ?? 0;
    return {
      data: profiles.rows.map((row) => ({
        userId: row.user_id,
        username: row.username,
        email: row.email,
        avatarUrl: row.avatar_url,
        countryCode: row.country_code,
        accountCreatedAt: row.source_created_at.toISOString(),
        score: row.score,
        rawScore: row.raw_score,
        severity: row.severity,
        outcome: row.outcome,
        completeness: row.completeness,
        confidence: row.confidence,
        policyMatches: row.policy_matches,
        assessedAt: row.assessed_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      })),
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        pages: Math.max(1, Math.ceil(total / query.limit)),
      },
    };
  });

  app.get("/v1/profiles/:userId", async (request, reply) => {
    const params = z
      .object({ userId: z.string().min(1).max(100) })
      .safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_user" });
    const userId = params.data.userId;
    const [profile, account, assessments, providers, relationships, matches] =
      await Promise.all([
        db.antifraud.query<{
          user_id: string;
          username: string | null;
          email: string | null;
          avatar_url: string | null;
          signup_ip: string | null;
          country: string | null;
          country_code: string | null;
          state: string | null;
          city: string | null;
          source_created_at: Date;
          assessment_version: string;
          raw_score: number;
          score: number;
          severity: string;
          outcome: string;
          completeness: string;
          confidence: number;
          provider_status: unknown;
          policy_matches: unknown;
          recommended_actions: unknown;
          explanation: unknown;
          assessed_at: Date;
        }>(
          `
            SELECT
              p.user_id,s.username,s.email,s.avatar_url,s.signup_ip,s.country,
              s.country_code,s.state,s.city,s.source_created_at,
              p.assessment_version,p.raw_score,p.score,p.severity,p.outcome,
              p.completeness,p.confidence,p.provider_status,p.policy_matches,
              p.recommended_actions,p.explanation,p.assessed_at
            FROM antifraud_profiles p
            JOIN subjects s ON s.user_id=p.user_id
            WHERE p.user_id=$1
          `,
          [userId],
        ),
        db.source.query<{
          id: string;
          is_banned: boolean;
          banned_reason: string | null;
          banned_at: Date | null;
          is_locked: boolean;
          locked_reason: string | null;
        }>(
          `SELECT id,is_banned,banned_reason,banned_at,is_locked,locked_reason
           FROM "user" WHERE id=$1`,
          [userId],
        ),
        db.antifraud.query<{
          id: string;
          assessment_version: string;
          score: number;
          raw_score: number;
          severity: string;
          outcome: string;
          completeness: string;
          confidence: number;
          policy_matches: unknown;
          recommended_actions: unknown;
          assessed_at: Date;
        }>(
          `
            SELECT id,assessment_version,score,raw_score,severity,outcome,
              completeness,confidence,policy_matches,recommended_actions,
              assessed_at
            FROM profile_assessment_history
            WHERE user_id=$1
            ORDER BY assessed_at DESC,id DESC
            LIMIT 50
          `,
          [userId],
        ),
        db.antifraud.query<{
          id: string;
          provider: string;
          outcome: string;
          failure_kind: string | null;
          provider_score: string | null;
          normalized_signals: unknown;
          observed_at: Date;
        }>(
          `
            SELECT id,provider,outcome,failure_kind,provider_score,
              normalized_signals,observed_at
            FROM profile_provider_evidence
            WHERE user_id=$1
            ORDER BY observed_at DESC,id DESC
            LIMIT 100
          `,
          [userId],
        ),
        db.antifraud.query<{
          id: string;
          related_user_id: string | null;
          relationship_type: string;
          confidence: string;
          occurrence_count: number;
          first_observed_at: Date;
          last_observed_at: Date;
          evidence: unknown;
        }>(
          `
            SELECT id,related_user_id,relationship_type,confidence,
              occurrence_count,first_observed_at,last_observed_at,evidence
            FROM account_relationship_evidence
            WHERE subject_user_id=$1
            ORDER BY last_observed_at DESC,id DESC
            LIMIT 100
          `,
          [userId],
        ),
        db.antifraud.query<{
          id: string;
          kind: string;
          value: string;
          match_context: string;
          resulting_action: string;
          matched_at: Date;
          reason: string;
        }>(
          `
            SELECT
              m.id,b.kind,
              CASE
                WHEN b.kind='ip' AND b.match_mode='exact' THEN host(b.ip_network)
                WHEN b.kind='ip' THEN b.ip_network::text
                ELSE b.fingerprint_id
              END AS value,
              m.match_context,m.resulting_action,m.matched_at,b.reason
            FROM identifier_blocklist_matches m
            JOIN identifier_blocklists b ON b.id=m.blocklist_id
            WHERE m.user_id=$1
            ORDER BY m.matched_at DESC,m.id DESC
            LIMIT 100
          `,
          [userId],
        ),
      ]);
    const row = profile.rows[0];
    if (!row) return reply.code(404).send({ error: "not_found" });
    const status = account.rows[0];
    return {
      data: {
        profile: {
          userId: row.user_id,
          username: row.username,
          email: row.email,
          avatarUrl: row.avatar_url,
          signupIp: row.signup_ip,
          country: row.country,
          countryCode: row.country_code,
          state: row.state,
          city: row.city,
          accountCreatedAt: row.source_created_at.toISOString(),
          assessmentVersion: row.assessment_version,
          rawScore: row.raw_score,
          score: row.score,
          severity: row.severity,
          outcome: row.outcome,
          completeness: row.completeness,
          confidence: row.confidence,
          providerStatus: row.provider_status,
          policyMatches: row.policy_matches,
          recommendedActions: row.recommended_actions,
          explanation: row.explanation,
          assessedAt: row.assessed_at.toISOString(),
          isBanned: status?.is_banned ?? null,
          bannedReason: status?.banned_reason ?? null,
          bannedAt: status?.banned_at?.toISOString() ?? null,
          isLocked: status?.is_locked ?? null,
          lockedReason: status?.locked_reason ?? null,
        },
        assessments: assessments.rows.map((item) => ({
          ...item,
          assessed_at: item.assessed_at.toISOString(),
        })),
        providers: providers.rows.map((item) => ({
          ...item,
          provider_score:
            item.provider_score === null ? null : Number(item.provider_score),
          observed_at: item.observed_at.toISOString(),
        })),
        relationships: relationships.rows.map((item) => ({
          ...item,
          confidence: Number(item.confidence),
          first_observed_at: item.first_observed_at.toISOString(),
          last_observed_at: item.last_observed_at.toISOString(),
        })),
        blocklistMatches: matches.rows.map((item) => ({
          ...item,
          matched_at: item.matched_at.toISOString(),
        })),
      },
    };
  });

  app.get("/v1/banned-users", async (request) => {
    const query = listQuerySchema.pick({ page: true, limit: true, search: true })
      .parse(request.query);
    const search = query.search ? `${query.search.toLowerCase()}%` : null;
    const offset = (query.page - 1) * query.limit;
    const roles = ["user", "creator", "admin", "support"];
    const [users, count] = await Promise.all([
      db.source.query<{
        id: string;
        username: string | null;
        email: string | null;
        image: string | null;
        country_code: string | null;
        banned_reason: string | null;
        banned_at: Date | null;
        created_at: Date;
      }>(
        `
          SELECT id,username,email,image,country_code,banned_reason,banned_at,
            created_at
          FROM "user"
          WHERE role::text=ANY($1::text[]) AND is_banned=true
            AND (
              $2::text IS NULL
              OR lower(id) LIKE $2
              OR lower(COALESCE(username,'')) LIKE $2
              OR lower(COALESCE(email,'')) LIKE $2
            )
          ORDER BY banned_at DESC NULLS LAST,created_at DESC,id
          LIMIT $3 OFFSET $4
        `,
        [roles, search, query.limit, offset],
      ),
      db.source.query<{ count: number }>(
        `
          SELECT count(*)::int AS count FROM "user"
          WHERE role::text=ANY($1::text[]) AND is_banned=true
            AND (
              $2::text IS NULL
              OR lower(id) LIKE $2
              OR lower(COALESCE(username,'')) LIKE $2
              OR lower(COALESCE(email,'')) LIKE $2
            )
        `,
        [roles, search],
      ),
    ]);
    const total = count.rows[0]?.count ?? 0;
    return {
      data: users.rows.map((row) => ({
        userId: row.id,
        username: row.username,
        email: row.email,
        avatarUrl: row.image,
        countryCode: row.country_code,
        banReason: row.banned_reason,
        bannedAt: row.banned_at?.toISOString() ?? null,
        accountCreatedAt: row.created_at.toISOString(),
      })),
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        pages: Math.max(1, Math.ceil(total / query.limit)),
      },
    };
  });
}
