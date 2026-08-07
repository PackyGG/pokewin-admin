import { isDeepStrictEqual } from "node:util";

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Databases } from "./db.js";

const listSchema = z.object({
  status: z.enum(["pending", "resolved"]).default("pending"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const mutationSchema = z.object({
  idempotencyKey: z.string().uuid(),
  actorId: z.string().trim().min(1).max(200),
  actorUsername: z.string().trim().min(1).max(100).optional(),
  reason: z.string().trim().min(3).max(500),
});

const paramsSchema = z.object({
  userId: z.string().trim().min(1).max(200),
});

type FailureRow = {
  user_id: string;
  error_text: string;
  failure_count: number;
  first_failed_at: Date | string;
  last_failed_at: Date | string;
  resolved_at: Date | string | null;
  resolved_by: string | null;
  resolution_note: string | null;
};

type AuditRow = {
  action: string;
  target_id: string;
  actor_id: string;
  actor_username: string | null;
  request_state: unknown;
  after_state: FailureRow | null;
};

type FailureAction = "signup_failure.retry" | "signup_failure.resolve";

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function publicFailure(errorText: string): {
  errorCode: string;
  errorSummary: string;
} {
  if (errorText.includes("signup_alert_outbox_score_check")) {
    return {
      errorCode: "signup_alert_score_contract",
      errorSummary: "The signup alert score was rejected by its data contract.",
    };
  }
  if (errorText.startsWith("Provider enrichment unavailable:")) {
    return {
      errorCode: "provider_enrichment_unavailable",
      errorSummary: "A signup enrichment provider was unavailable.",
    };
  }
  if (errorText === "Stored signup payload is invalid") {
    return {
      errorCode: "invalid_stored_payload",
      errorSummary: "The stored signup payload could not be replayed.",
    };
  }
  return {
    errorCode: "signup_assessment_failed",
    errorSummary: "The signup assessment could not be completed.",
  };
}

function serialize(row: FailureRow) {
  return {
    userId: row.user_id,
    ...publicFailure(row.error_text),
    failureCount: row.failure_count,
    firstFailedAt: iso(row.first_failed_at),
    lastFailedAt: iso(row.last_failed_at),
    status: row.resolved_at ? "resolved" as const : "pending" as const,
    resolvedAt: row.resolved_at ? iso(row.resolved_at) : null,
    resolvedBy: row.resolved_by,
    resolutionNote: row.resolution_note,
  };
}

function isExactReplay(
  prior: AuditRow,
  expected: {
    action: FailureAction;
    userId: string;
    actorId: string;
    actorUsername: string | null;
    reason: string;
  },
): boolean {
  return (
    prior.action === expected.action &&
    prior.target_id === expected.userId &&
    prior.actor_id === expected.actorId &&
    prior.actor_username === expected.actorUsername &&
    isDeepStrictEqual(prior.request_state, {
      userId: expected.userId,
      actorId: expected.actorId,
      actorUsername: expected.actorUsername,
      reason: expected.reason,
    })
  );
}

const selectColumns = `
  user_id, error_text, failure_count, first_failed_at, last_failed_at,
  resolved_at, resolved_by, resolution_note
`;

export async function registerSignupFailureRoutes(
  app: FastifyInstance,
  db: Databases,
): Promise<void> {
  app.get("/v1/operations/signup-failures", async (request, reply) => {
    const parsed = listSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const resolved = parsed.data.status === "resolved";
    const result = await db.antifraud.query<FailureRow>(
      `
        SELECT ${selectColumns}
        FROM signup_ingestion_failures
        WHERE resolved_at IS ${resolved ? "NOT NULL" : "NULL"}
        ORDER BY last_failed_at DESC, user_id
        LIMIT $1
      `,
      [parsed.data.limit],
    );
    return { data: result.rows.map(serialize) };
  });

  for (const action of ["retry", "resolve"] as const) {
    app.post(
      `/v1/operations/signup-failures/:userId/${action}`,
      async (request, reply) => {
        const params = paramsSchema.safeParse(request.params);
        const body = mutationSchema.safeParse(request.body);
        if (!params.success || !body.success) {
          return reply.code(400).send({ error: "invalid_request" });
        }

        const auditAction: FailureAction =
          action === "retry"
            ? "signup_failure.retry"
            : "signup_failure.resolve";
        const actorUsername = body.data.actorUsername ?? null;
        const requestState = {
          userId: params.data.userId,
          actorId: body.data.actorId,
          actorUsername,
          reason: body.data.reason,
        };
        const client = await db.antifraud.connect();
        try {
          await client.query("BEGIN");
          // Serialize requests sharing a key before reading the audit row. A
          // unique constraint alone turns simultaneous identical requests into
          // a 500 for the loser instead of an idempotent replay response.
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
            [body.data.idempotencyKey],
          );
          const prior = await client.query<AuditRow>(
            `
              SELECT
                action, target_id, actor_id, actor_username,
                request_state, after_state
              FROM service_audit_events
              WHERE idempotency_key=$1
            `,
            [body.data.idempotencyKey],
          );
          const existing = prior.rows[0];
          if (existing) {
            if (
              !isExactReplay(existing, {
                action: auditAction,
                userId: params.data.userId,
                actorId: body.data.actorId,
                actorUsername,
                reason: body.data.reason,
              }) ||
              !existing.after_state
            ) {
              await client.query("ROLLBACK");
              return reply.code(409).send({ error: "idempotency_conflict" });
            }
            await client.query("COMMIT");
            return { data: serialize(existing.after_state), idempotent: true };
          }

          const before = await client.query<FailureRow>(
            `
              SELECT ${selectColumns}
              FROM signup_ingestion_failures
              WHERE user_id=$1
              FOR UPDATE
            `,
            [params.data.userId],
          );
          const previous = before.rows[0];
          if (!previous) {
            await client.query("ROLLBACK");
            return reply.code(404).send({ error: "not_found" });
          }

          const updated = await client.query<FailureRow>(
            action === "retry"
              ? `
                  UPDATE signup_ingestion_failures
                  SET failure_count=0,
                      last_failed_at=to_timestamp(0),
                      resolved_at=NULL,
                      resolved_by=NULL,
                      resolution_note=NULL
                  WHERE user_id=$1
                  RETURNING ${selectColumns}
                `
              : `
                  UPDATE signup_ingestion_failures
                  SET resolved_at=now(),
                      resolved_by=$2,
                      resolution_note=$3
                  WHERE user_id=$1
                  RETURNING ${selectColumns}
                `,
            action === "retry"
              ? [params.data.userId]
              : [
                  params.data.userId,
                  body.data.actorId,
                  body.data.reason,
                ],
          );
          const current = updated.rows[0];
          if (!current) {
            await client.query("ROLLBACK");
            return reply.code(404).send({ error: "not_found" });
          }

          await client.query(
            `
              INSERT INTO service_audit_events(
                idempotency_key, actor_id, actor_username, action,
                target_type, target_id, request_state, before_state, after_state
              ) VALUES ($1,$2,$3,$4,'signup_ingestion_failure',$5,$6,$7,$8)
            `,
            [
              body.data.idempotencyKey,
              body.data.actorId,
              actorUsername,
              auditAction,
              params.data.userId,
              requestState,
              previous,
              current,
            ],
          );
          await client.query("COMMIT");
          return { data: serialize(current), idempotent: false };
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      },
    );
  }
}
