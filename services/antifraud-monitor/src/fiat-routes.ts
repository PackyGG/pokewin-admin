import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Databases } from "./db.js";
import {
  FIAT_ASSESSMENT_STATUSES,
  type FiatRiskService,
} from "./fiat-risk.js";
import { normalizeWhopPaymentMethod } from "./whop-payment-method.js";

const reviewStatuses = [
  "unreviewed",
  "in_review",
  "cleared",
  "escalated",
  "hold_recommended",
] as const;

const querySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(FIAT_ASSESSMENT_STATUSES).optional(),
  verdict: z.enum(["good", "review", "bad"]).optional(),
  reviewStatus: z.enum(reviewStatuses).optional(),
  search: z.string().trim().max(100).optional(),
  excludeKycRequired: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional()
    .default(false),
});

const reviewBodySchema = z
  .object({
    action: z.enum([
      "start_review",
      "clear",
      "escalate",
      "recommend_hold",
    ]),
    actorId: z.string().min(1).max(100),
    actorUsername: z.string().trim().min(1).max(100).optional(),
    note: z.string().trim().max(1_000).optional(),
    expectedStatus: z.enum(reviewStatuses),
    idempotencyKey: z.string().uuid(),
  })
  .superRefine((value, context) => {
    if (value.action !== "start_review" && (value.note?.length ?? 0) < 4) {
      context.addIssue({
        code: "custom",
        path: ["note"],
        message: "Write what you concluded before recording this decision.",
      });
    }
  });

const idSchema = z.object({ id: z.string().uuid() });
const excludedUsersHeaderSchema = z
  .string()
  .min(2)
  .max(100_000)
  .transform((value, context): unknown => {
    try {
      return JSON.parse(value);
    } catch {
      context.addIssue({
        code: "custom",
        message: "Invalid excluded-users header.",
      });
      return z.NEVER;
    }
  })
  .pipe(z.array(z.string().trim().min(1).max(100)));

function excludedUserIds(headers: Record<string, unknown>): string[] {
  return excludedUsersHeaderSchema.parse(headers["x-antifraud-excluded-users"]);
}

async function creatorUserIdsForAssessments(db: Databases): Promise<string[]> {
  const assessed = await db.antifraud.query<{ user_id: string }>(
    "SELECT DISTINCT user_id FROM fiat_deposit_assessments",
  );
  const userIds = assessed.rows.map((row) => row.user_id);
  if (userIds.length === 0) return [];
  const creators = await db.source.query<{ id: string }>(
    `
      SELECT id
      FROM "user"
      WHERE id=ANY($1::text[])
        AND (
          role::text='creator'
          OR 'creator'=ANY(COALESCE(roles::text[], ARRAY[]::text[]))
        )
    `,
    [userIds],
  );
  return creators.rows.map((row) => row.id);
}

async function userIsCreator(db: Databases, userId: string): Promise<boolean> {
  const result = await db.source.query<{ creator: boolean }>(
    `
      SELECT (
        role::text='creator'
        OR 'creator'=ANY(COALESCE(roles::text[], ARRAY[]::text[]))
      ) AS creator
      FROM "user"
      WHERE id=$1
    `,
    [userId],
  );
  return result.rows[0]?.creator ?? false;
}

function nextReviewStatus(
  action: z.infer<typeof reviewBodySchema>["action"],
): (typeof reviewStatuses)[number] {
  if (action === "start_review") return "in_review";
  if (action === "clear") return "cleared";
  if (action === "escalate") return "escalated";
  return "hold_recommended";
}

const assessmentSelect = `
  deposit_intent_id, user_id, username, email, avatar_url, provider,
  provider_payment_status, status, currency,
  requested_amount_usd::float8 AS requested_amount_usd,
  credited_amount_usd::float8 AS credited_amount_usd,
  customer_total_usd::float8 AS customer_total_usd,
  provider_net_usd::float8 AS provider_net_usd,
  occurred_at, source_updated_at, provider_risk_score, three_ds_verified,
  risk_score, verdict, recommendation, summary, signals, provider_evidence,
  funding_evidence, behavior_evidence, account_evidence, score_breakdown,
  flow_checks, review_status, review_decision, reviewed_by,
  reviewed_by_username, review_note, review_started_at, reviewed_at,
  score_version, assessed_at
`;

export async function registerFiatRoutes(
  app: FastifyInstance,
  db: Databases,
  service: FiatRiskService,
): Promise<void> {
  app.get("/v1/fiat-deposits", async (request) => {
    const query = querySchema.parse(request.query);
    const excluded = excludedUserIds(request.headers);
    const usesAssessmentFilter = Boolean(query.verdict || query.reviewStatus);
    const refreshed = await service.refresh({
      status: query.status,
      search: query.search,
      excludedUserIds: excluded,
      limit: 100,
    });
    const ignored = [
      ...new Set([...excluded, ...(await creatorUserIdsForAssessments(db))]),
    ];
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (!usesAssessmentFilter) {
      values.push(refreshed.ids);
      conditions.push(`deposit_intent_id=ANY($${values.length}::uuid[])`);
    }
    if (query.status) {
      values.push(query.status);
      conditions.push(`status=$${values.length}`);
    } else {
      values.push(FIAT_ASSESSMENT_STATUSES);
      conditions.push(`status=ANY($${values.length}::text[])`);
    }
    if (query.verdict) {
      values.push(query.verdict);
      conditions.push(`verdict=$${values.length}`);
    }
    if (query.reviewStatus) {
      values.push(query.reviewStatus);
      conditions.push(`review_status=$${values.length}`);
    }
    if (query.excludeKycRequired) {
      conditions.push(
        `COALESCE((account_evidence->>'kycRequired')::boolean,false)=false`,
      );
    }
    if (query.search) {
      values.push(`%${query.search.toLowerCase()}%`);
      const generalSearchPosition = values.length;
      values.push(
        `%${normalizeWhopPaymentMethod(query.search) ?? query.search.toLowerCase()}%`,
      );
      const paymentMethodSearchPosition = values.length;
      conditions.push(`(
        lower(deposit_intent_id::text) LIKE $${generalSearchPosition}
        OR lower(user_id) LIKE $${generalSearchPosition}
        OR lower(COALESCE(username,'')) LIKE $${generalSearchPosition}
        OR lower(COALESCE(email,'')) LIKE $${generalSearchPosition}
        OR lower(COALESCE(
          provider_evidence->>'paymentMethodType',
          ''
        )) LIKE $${paymentMethodSearchPosition}
      )`);
    }
    if (ignored.length > 0) {
      values.push(ignored);
      conditions.push(`user_id<>ALL($${values.length}::text[])`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const offset = (query.page - 1) * query.limit;
    const listValues = [...values, query.limit, offset];
    const summaryValues: unknown[] = [FIAT_ASSESSMENT_STATUSES];
    const summaryConditions = ["status=ANY($1::text[])"];
    if (query.excludeKycRequired) {
      summaryConditions.push(
        `COALESCE((account_evidence->>'kycRequired')::boolean,false)=false`,
      );
    }
    if (ignored.length > 0) {
      summaryValues.push(ignored);
      summaryConditions.push(
        `user_id<>ALL($${summaryValues.length}::text[])`,
      );
    }
    const summaryWhere = `WHERE ${summaryConditions.join(" AND ")}`;

    const [rows, total, summary] = await Promise.all([
      db.antifraud.query(
        `
          SELECT ${assessmentSelect}
          FROM fiat_deposit_assessments
          ${where}
          ORDER BY occurred_at DESC, deposit_intent_id DESC
          LIMIT $${listValues.length - 1} OFFSET $${listValues.length}
        `,
        listValues,
      ),
      db.antifraud.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count
         FROM fiat_deposit_assessments ${where}`,
        values,
      ),
      db.antifraud.query(
        `
          SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE verdict='good')::int AS good,
            COUNT(*) FILTER (WHERE verdict='review')::int AS review,
            COUNT(*) FILTER (WHERE verdict='bad')::int AS bad,
            COUNT(*) FILTER (WHERE review_status='unreviewed')::int
              AS unreviewed,
            COUNT(*) FILTER (WHERE review_status='in_review')::int
              AS in_review,
            COUNT(*) FILTER (WHERE review_status='escalated')::int
              AS escalated,
            COUNT(*) FILTER (WHERE review_status='hold_recommended')::int
              AS hold_recommended,
            COUNT(*) FILTER (WHERE provider_risk_score>=60)::int
              AS provider_high_risk,
            COUNT(*) FILTER (WHERE three_ds_verified=false)::int
              AS three_ds_failed,
            COUNT(*) FILTER (WHERE status='disputed')::int AS disputed,
            COALESCE(SUM(credited_amount_usd),0)::float8 AS amount_usd
          FROM fiat_deposit_assessments
          ${summaryWhere}
        `,
        summaryValues,
      ),
    ]);
    const count = total.rows[0]?.count ?? 0;
    return {
      data: rows.rows,
      pagination: {
        page: query.page,
        limit: query.limit,
        total: count,
        pages: Math.max(1, Math.ceil(count / query.limit)),
      },
      summary: summary.rows[0],
    };
  });

  app.get("/v1/fiat-deposits/:id", async (request, reply) => {
    const { id } = idSchema.parse(request.params);
    const excluded = new Set(excludedUserIds(request.headers));
    let assessment = await db.antifraud.query<{
      deposit_intent_id: string;
      user_id: string;
      occurred_at: string;
      credited_amount_usd: number;
    }>(
      `SELECT ${assessmentSelect}
       FROM fiat_deposit_assessments WHERE deposit_intent_id=$1`,
      [id],
    );
    if (!assessment.rows[0]) {
      await service.refresh({
        search: id,
        excludedUserIds: [...excluded],
        limit: 1,
      });
      assessment = await db.antifraud.query(
        `SELECT ${assessmentSelect}
         FROM fiat_deposit_assessments WHERE deposit_intent_id=$1`,
        [id],
      );
    }
    const row = assessment.rows[0];
    if (
      !row ||
      excluded.has(row.user_id) ||
      (await userIsCreator(db, row.user_id))
    ) {
      return reply.code(404).send({ error: "not_found" });
    }
    const [timeline, trail] = await Promise.all([
      service.loadTimeline({
        intentId: row.deposit_intent_id,
        userId: row.user_id,
        occurredAt: row.occurred_at,
        amountUsd: Number(row.credited_amount_usd),
      }),
      db.antifraud.query(
        `
          SELECT id, deposit_intent_id, action, actor_id, actor_username,
                 note, created_at
          FROM fiat_deposit_review_events
          WHERE deposit_intent_id=$1
          ORDER BY created_at DESC, id DESC
          LIMIT 100
        `,
        [id],
      ),
    ]);
    return {
      data: { assessment: row, timeline, reviewEvents: trail.rows },
    };
  });

  app.post(
    "/v1/fiat-deposits/:id/review",
    {
      config: {
        rateLimit: { max: 30, timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      const { id } = idSchema.parse(request.params);
      const body = reviewBodySchema.parse(request.body);
      const excluded = new Set(excludedUserIds(request.headers));
      const note = body.note?.trim() || null;
      const visible = await db.antifraud.query<{ user_id: string }>(
        `SELECT user_id FROM fiat_deposit_assessments WHERE deposit_intent_id=$1`,
        [id],
      );
      const visibleRow = visible.rows[0];
      if (
        !visibleRow ||
        excluded.has(visibleRow.user_id) ||
        (await userIsCreator(db, visibleRow.user_id))
      ) {
        return reply.code(404).send({ error: "not_found" });
      }
      const client = await db.antifraud.connect();
      try {
        await client.query("BEGIN");
        const current = await client.query<{
          review_status: string;
          user_id: string;
        }>(
          `SELECT review_status, user_id
           FROM fiat_deposit_assessments
           WHERE deposit_intent_id=$1 FOR UPDATE`,
          [id],
        );
        const row = current.rows[0];
        if (!row || row.user_id !== visibleRow.user_id) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: "not_found" });
        }
        const replay = await client.query<{
          deposit_intent_id: string;
          action: string;
          actor_id: string;
          actor_username: string | null;
          note: string | null;
        }>(
          `SELECT deposit_intent_id, action, actor_id, actor_username, note
           FROM fiat_deposit_review_events WHERE idempotency_key=$1`,
          [body.idempotencyKey],
        );
        const existing = replay.rows[0];
        if (existing) {
          const exact =
            existing.deposit_intent_id === id &&
            existing.action === body.action &&
            existing.actor_id === body.actorId &&
            existing.actor_username === (body.actorUsername ?? null) &&
            existing.note === note;
          await client.query("COMMIT");
          return exact
            ? { success: true, idempotent: true }
            : reply.code(409).send({ error: "idempotency_conflict" });
        }
        if (row.review_status !== body.expectedStatus) {
          await client.query("ROLLBACK");
          return reply.code(409).send({ error: "review_state_changed" });
        }
        const nextStatus = nextReviewStatus(body.action);
        await client.query(
          `
            UPDATE fiat_deposit_assessments
            SET review_status=$2,
                review_decision=$3,
                reviewed_by=$4,
                reviewed_by_username=$5,
                review_note=COALESCE($6, review_note),
                review_started_at=COALESCE(review_started_at, now()),
                reviewed_at=CASE WHEN $2='in_review' THEN NULL ELSE now() END
            WHERE deposit_intent_id=$1
          `,
          [
            id,
            nextStatus,
            body.action === "start_review" ? null : body.action,
            body.actorId,
            body.actorUsername ?? null,
            note,
          ],
        );
        await client.query(
          `
            INSERT INTO fiat_deposit_review_events(
              deposit_intent_id, action, actor_id, actor_username, note,
              idempotency_key
            ) VALUES ($1,$2,$3,$4,$5,$6)
          `,
          [
            id,
            body.action,
            body.actorId,
            body.actorUsername ?? null,
            note,
            body.idempotencyKey,
          ],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      return { success: true };
    },
  );
}
