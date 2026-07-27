import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Databases } from "./db.js";
import type { WithdrawalRiskService } from "./withdrawal-risk.js";

const querySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z
    .enum(["pending", "processing", "shipped", "completed", "failed", "cancelled"])
    .optional(),
  verdict: z.enum(["good", "review", "bad"]).optional(),
  search: z.string().trim().max(100).optional(),
});

export async function registerWithdrawalRoutes(
  app: FastifyInstance,
  db: Databases,
  service: WithdrawalRiskService,
): Promise<void> {
  app.get("/v1/withdrawals", async (request) => {
    const query = querySchema.parse(request.query);
    const refreshed = await service.refreshPage(
      query.verdict
        ? { ...query, page: 1, limit: 100 }
        : query,
    );

    const conditions: string[] = [];
    const values: unknown[] = [];
    if (!query.verdict) {
      values.push(refreshed.ids);
      conditions.push(`withdrawal_id=ANY($${values.length}::uuid[])`);
    }
    if (query.status) {
      values.push(query.status);
      conditions.push(`status=$${values.length}`);
    }
    if (query.verdict) {
      values.push(query.verdict);
      conditions.push(`verdict=$${values.length}`);
    }
    if (query.search) {
      values.push(`%${query.search.toLowerCase()}%`);
      conditions.push(`(
        lower(user_id) LIKE $${values.length}
        OR lower(COALESCE(username,'')) LIKE $${values.length}
        OR lower(COALESCE(email,'')) LIKE $${values.length}
      )`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const offset = query.verdict ? (query.page - 1) * query.limit : 0;
    values.push(query.limit, offset);
    const [rows, total, summary] = await Promise.all([
      db.antifraud.query(
        `
          SELECT withdrawal_id, user_id, username, email, avatar_url, method,
                 status, amount_usd::float8 AS amount_usd, asset_count,
                 requested_at, risk_score, verdict, summary, signals, flow,
                 source_breakdown, assessed_at
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
        amount_usd: number;
      }>(
        `
          SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE verdict='good')::int AS good,
            COUNT(*) FILTER (WHERE verdict='review')::int AS review,
            COUNT(*) FILTER (WHERE verdict='bad')::int AS bad,
            COALESCE(SUM(amount_usd),0)::float8 AS amount_usd
          FROM withdrawal_assessments
        `,
      ),
    ]);
    const count = query.verdict
      ? total.rows[0]?.count ?? 0
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
        amount_usd: 0,
      },
    };
  });
}
