import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Databases } from "./db.js";
import {
  WITHDRAWAL_RISK_MODEL_VERSION,
  type WithdrawalRiskService,
} from "./withdrawal-risk.js";
import {
  cachedCreatorUserIds,
  excludedUserIds,
  userIsCreator,
} from "./route-helpers.js";

const querySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z
    .enum([
      "pending",
      "processing",
      "shipped",
      "completed",
      "failed",
      "cancelled",
    ])
    .optional(),
  verdict: z.enum(["good", "review", "bad"]).optional(),
  reviewStatus: z
    .enum([
      "unreviewed",
      "in_review",
      "cleared",
      "block_recommended",
    ])
    .optional(),
  rail: z.enum(["fiat", "crypto"]).default("fiat"),
  lifecycle: z.enum(["pending", "confirmed", "all"]).default("pending"),
  search: z.string().trim().max(100).optional(),
});

const reviewStatuses = [
  "unreviewed",
  "in_review",
  "cleared",
  "block_recommended",
] as const;

const reviewBodySchema = z
  .object({
    action: z.enum(["start_review", "clear", "recommend_block"]),
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
function reviewStatusFor(
  action: z.infer<typeof reviewBodySchema>["action"],
): (typeof reviewStatuses)[number] {
  if (action === "start_review") return "in_review";
  if (action === "clear") return "cleared";
  return "block_recommended";
}

function visibleReviewStatus(status: string): string {
  return status === "escalated" ? "in_review" : status;
}

export async function registerWithdrawalRoutes(
  app: FastifyInstance,
  db: Databases,
  service: WithdrawalRiskService,
): Promise<void> {
  app.get("/v1/withdrawals", async (request) => {
    const query = querySchema.parse(request.query);
    const excluded = excludedUserIds(request.headers);
    const usesAssessmentFilter = Boolean(
      query.verdict || query.reviewStatus || query.rail || query.lifecycle,
    );
    const refreshed = await service.refreshPage(
      usesAssessmentFilter
        ? { ...query, page: 1, limit: 100, excludedUserIds: excluded }
        : { ...query, excludedUserIds: excluded },
    );
    const ignoredUserIds = [
      ...new Set([...excluded, ...(await cachedCreatorUserIds(db.source))]),
    ];

    const conditions: string[] = ["model_version=$1"];
    const values: unknown[] = [WITHDRAWAL_RISK_MODEL_VERSION];
    if (!usesAssessmentFilter) {
      values.push(refreshed.ids);
      conditions.push(`withdrawal_id=ANY($${values.length}::uuid[])`);
    }
    if (query.status) {
      values.push(query.status);
      conditions.push(`status=$${values.length}`);
    } else if (query.lifecycle === "pending") {
      conditions.push(`status IN ('pending','processing')`);
    } else if (query.lifecycle === "confirmed") {
      conditions.push(`status IN ('shipped','completed')`);
    }
    conditions.push(
      query.rail === "crypto" ? `method='crypto'` : `method<>'crypto'`,
    );
    if (query.verdict) {
      values.push(query.verdict);
      conditions.push(`verdict=$${values.length}`);
    }
    if (query.reviewStatus) {
      if (query.reviewStatus === "in_review") {
        conditions.push(`review_status IN ('in_review','escalated')`);
      } else {
        values.push(query.reviewStatus);
        conditions.push(`review_status=$${values.length}`);
      }
    }
    if (query.search) {
      values.push(`%${query.search.toLowerCase()}%`);
      conditions.push(`(
        lower(user_id) LIKE $${values.length}
        OR lower(COALESCE(username,'')) LIKE $${values.length}
        OR lower(COALESCE(email,'')) LIKE $${values.length}
      )`);
    }
    if (ignoredUserIds.length > 0) {
      values.push(ignoredUserIds);
      conditions.push(`user_id<>ALL($${values.length}::text[])`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const offset = usesAssessmentFilter ? (query.page - 1) * query.limit : 0;
    values.push(query.limit, offset);
    const summaryValues: unknown[] = [WITHDRAWAL_RISK_MODEL_VERSION];
    const summaryConditions = ["model_version=$1"];
    if (ignoredUserIds.length > 0) {
      summaryValues.push(ignoredUserIds);
      summaryConditions.push(`user_id<>ALL($2::text[])`);
    }
    const summaryWhere = `WHERE ${summaryConditions.join(" AND ")}`;
    const [rows, total, summary] = await Promise.all([
      db.antifraud.query(
        `
          SELECT withdrawal_id, user_id, username, email, avatar_url, method,
                 status, amount_usd::float8 AS amount_usd, asset_count,
                 requested_at, risk_score, verdict, summary, signals, flow,
                 source_breakdown, score_breakdown, flow_checks,
                 CASE WHEN review_status='escalated'
                   THEN 'in_review' ELSE review_status END AS review_status,
                 review_decision, reviewed_by,
                 reviewed_by_username, review_note, review_started_at,
                 reviewed_at, model_version, assessed_at
          FROM withdrawal_assessments
          ${where}
          ORDER BY requested_at DESC, withdrawal_id DESC
          LIMIT $${values.length - 1} OFFSET $${values.length}
        `,
        values,
      ),
      db.antifraud.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM withdrawal_assessments ${where}`,
        values.slice(0, -2),
      ),
      db.antifraud.query<{
        total: number;
        good: number;
        review: number;
        bad: number;
        unreviewed: number;
        in_review: number;
        block_recommended: number;
        amount_usd: number;
        fiat: number;
        crypto: number;
        pending_fiat: number;
        pending_crypto: number;
        confirmed_fiat: number;
        confirmed_crypto: number;
      }>(
        `
          SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE verdict='good')::int AS good,
            COUNT(*) FILTER (WHERE verdict='review')::int AS review,
            COUNT(*) FILTER (WHERE verdict='bad')::int AS bad,
            COUNT(*) FILTER (WHERE review_status='unreviewed')::int AS unreviewed,
            COUNT(*) FILTER (
              WHERE review_status IN ('in_review','escalated')
            )::int AS in_review,
            COUNT(*) FILTER (WHERE review_status='block_recommended')::int
              AS block_recommended,
            COUNT(*) FILTER (WHERE method<>'crypto')::int AS fiat,
            COUNT(*) FILTER (WHERE method='crypto')::int AS crypto,
            COUNT(*) FILTER (
              WHERE method<>'crypto' AND status IN ('pending','processing')
            )::int AS pending_fiat,
            COUNT(*) FILTER (
              WHERE method='crypto' AND status IN ('pending','processing')
            )::int AS pending_crypto,
            COUNT(*) FILTER (
              WHERE method<>'crypto' AND status IN ('shipped','completed')
            )::int AS confirmed_fiat,
            COUNT(*) FILTER (
              WHERE method='crypto' AND status IN ('shipped','completed')
            )::int AS confirmed_crypto,
            COALESCE(SUM(amount_usd),0)::float8 AS amount_usd
          FROM withdrawal_assessments
          ${summaryWhere}
        `,
        summaryValues,
      ),
    ]);
    const count = usesAssessmentFilter
      ? (total.rows[0]?.count ?? 0)
      : refreshed.total;
    return {
      data: rows.rows,
      pagination: {
        page: query.page,
        limit: query.limit,
        total: count,
        pages: Math.max(1, Math.ceil(count / query.limit)),
      },
      summary: summary.rows[0] ?? {
        total: 0,
        good: 0,
        review: 0,
        bad: 0,
        unreviewed: 0,
        in_review: 0,
        block_recommended: 0,
        amount_usd: 0,
        fiat: 0,
        crypto: 0,
        pending_fiat: 0,
        pending_crypto: 0,
        confirmed_fiat: 0,
        confirmed_crypto: 0,
      },
    };
  });

  app.get("/v1/withdrawals/:id", async (request, reply) => {
    const { id } = idSchema.parse(request.params);
    const excluded = new Set(excludedUserIds(request.headers));
    const [assessment, trail] = await Promise.all([
      db.antifraud.query<{
        withdrawal_id: string;
        user_id: string;
        requested_at: string;
        amount_usd: number;
      }>(
        `
          SELECT withdrawal_id, user_id, username, email, avatar_url, method,
                 status, amount_usd::float8 AS amount_usd, asset_count,
                 requested_at, risk_score, verdict, summary, signals, flow,
                 source_breakdown, score_breakdown, flow_checks,
                 CASE WHEN review_status='escalated'
                   THEN 'in_review' ELSE review_status END AS review_status,
                 review_decision, reviewed_by,
                 reviewed_by_username, review_note, review_started_at,
                 reviewed_at, model_version, assessed_at
          FROM withdrawal_assessments
          WHERE withdrawal_id=$1
        `,
        [id],
      ),
      db.antifraud.query(
        `
          SELECT id, withdrawal_id,
                 CASE WHEN action='escalate' THEN 'start_review' ELSE action END
                   AS action,
                 actor_id, actor_username, note,
                 created_at
          FROM withdrawal_review_events
          WHERE withdrawal_id=$1
          ORDER BY created_at DESC, id DESC
          LIMIT 100
        `,
        [id],
      ),
    ]);
    const row = assessment.rows[0];
    if (!row) return reply.code(404).send({ error: "not_found" });
    if (
      excluded.has(row.user_id) ||
      (await userIsCreator(db.source, row.user_id))
    ) {
      return reply.code(404).send({ error: "not_found" });
    }
    const timeline = await service.loadTimeline({
      withdrawalId: row.withdrawal_id,
      userId: row.user_id,
      requestedAt: row.requested_at,
      amountUsd: Number(row.amount_usd),
    });
    return {
      data: {
        assessment: row,
        timeline,
        reviewEvents: trail.rows,
      },
    };
  });

  app.post(
    "/v1/withdrawals/:id/review",
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: "1 minute",
        },
      },
    },
    async (request, reply) => {
      const { id } = idSchema.parse(request.params);
      const body = reviewBodySchema.parse(request.body);
      const excluded = new Set(excludedUserIds(request.headers));
      const nextStatus = reviewStatusFor(body.action);
      const note = body.note?.trim() || null;
      const visible = await db.antifraud.query<{ user_id: string }>(
        `SELECT user_id FROM withdrawal_assessments WHERE withdrawal_id=$1`,
        [id],
      );
      const visibleRow = visible.rows[0];
      if (
        !visibleRow ||
        excluded.has(visibleRow.user_id) ||
        (await userIsCreator(db.source, visibleRow.user_id))
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
          `
          SELECT review_status, user_id
          FROM withdrawal_assessments
          WHERE withdrawal_id=$1
          FOR UPDATE
        `,
          [id],
        );
        const row = current.rows[0];
        if (!row || row.user_id !== visibleRow.user_id) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: "not_found" });
        }
        const replay = await client.query<{
          withdrawal_id: string;
          action: string;
          actor_id: string;
          actor_username: string | null;
          note: string | null;
        }>(
          `
          SELECT withdrawal_id, action, actor_id, actor_username, note
          FROM withdrawal_review_events
          WHERE idempotency_key=$1
        `,
          [body.idempotencyKey],
        );
        const existing = replay.rows[0];
        if (existing) {
          const exact =
            existing.withdrawal_id === id &&
            existing.action === body.action &&
            existing.actor_id === body.actorId &&
            existing.actor_username === (body.actorUsername ?? null) &&
            existing.note === note;
          await client.query("COMMIT");
          return exact
            ? { success: true, idempotent: true }
            : reply.code(409).send({ error: "idempotency_conflict" });
        }
        if (visibleReviewStatus(row.review_status) !== body.expectedStatus) {
          await client.query("ROLLBACK");
          return reply.code(409).send({ error: "review_state_changed" });
        }

        await client.query(
          `
          UPDATE withdrawal_assessments
          SET review_status=$2,
              review_decision=$3,
              reviewed_by=$4,
              reviewed_by_username=$5,
              review_note=COALESCE($6, review_note),
              review_started_at=COALESCE(review_started_at, now()),
              reviewed_at=CASE WHEN $2='in_review' THEN NULL ELSE now() END
          WHERE withdrawal_id=$1
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
          INSERT INTO withdrawal_review_events(
            withdrawal_id, action, actor_id, actor_username, note,
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
