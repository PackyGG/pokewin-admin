import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Databases } from "./db.js";
import { normalizeEmailDomain } from "./fiat-email-domains.js";

const actorSchema = z.object({
  idempotencyKey: z.string().uuid(),
  actorId: z.string().trim().min(1).max(200),
  actorUsername: z.string().trim().min(1).max(100).optional(),
});

const createSchema = actorSchema.extend({
  domain: z.string().trim().min(1).max(253),
});

const updateSchema = actorSchema.extend({
  enabled: z.boolean(),
});

const catchHistoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  riskType: z
    .enum([
      "blacklisted_domain",
      "gmail_dot_fragmentation",
      "suspicious_deposit_cluster",
    ])
    .optional(),
  source: z.enum(["whop_checkout", "signup"]).optional(),
  lockStatus: z.enum(["locked", "pending"]).optional(),
  search: z.string().trim().max(100).optional(),
});

const SYSTEM_REASON = "Email domain blacklisted by staff";

type RuleRow = {
  id: string;
  domain: string;
  reason: string;
  enabled: boolean;
  created_by: string;
  updated_by: string;
  backfill_completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  match_count: number;
  affected_users: number;
  pending_locks: number;
};

async function listRules(db: Databases, ruleId?: string): Promise<RuleRow[]> {
  const result = await db.antifraud.query<RuleRow>(
    `
      SELECT
        b.id,
        b.domain,
        b.reason,
        b.enabled,
        b.created_by,
        b.updated_by,
        b.backfill_completed_at,
        b.created_at,
        b.updated_at,
        count(m.id)::int AS match_count,
        count(DISTINCT m.user_id)::int AS affected_users,
        count(m.id) FILTER (WHERE m.lock_delivered_at IS NULL)::int
          AS pending_locks
      FROM fiat_email_domain_blacklist b
      LEFT JOIN fiat_email_domain_matches m ON m.domain = b.domain
        AND m.match_type = 'blacklisted_domain'
      WHERE ($1::uuid IS NULL OR b.id = $1::uuid)
      GROUP BY b.id
      ORDER BY b.enabled DESC, b.created_at DESC
    `,
    [ruleId ?? null],
  );
  return result.rows;
}

function serializeRule(row: RuleRow) {
  return {
    id: row.id,
    domain: row.domain,
    reason: row.reason,
    enabled: row.enabled,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    backfillComplete: row.backfill_completed_at !== null,
    matchCount: row.match_count,
    affectedUsers: row.affected_users,
    pendingLocks: row.pending_locks,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function registerFiatEmailDomainRoutes(
  app: FastifyInstance,
  db: Databases,
): Promise<void> {
  app.get("/v1/fiat-email-domains", async () => ({
    data: (await listRules(db)).map(serializeRule),
  }));

  app.post("/v1/fiat-email-domains", async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const domain = normalizeEmailDomain(parsed.data.domain);
    if (!domain) {
      return reply.code(400).send({ error: "invalid_domain" });
    }

    const client = await db.antifraud.connect();
    let ruleId: string | null = null;
    let idempotent = false;
    try {
      await client.query("BEGIN");
      const prior = await client.query<{
        rule_id: string;
        action: string;
        actor_id: string;
        after_state: {
          domain?: unknown;
          reason?: unknown;
          enabled?: unknown;
        };
      }>(
        `
          SELECT rule_id, action, actor_id, after_state
          FROM fiat_email_domain_blacklist_audit
          WHERE idempotency_key = $1
        `,
        [parsed.data.idempotencyKey],
      );
      const priorAudit = prior.rows[0];
      if (priorAudit) {
        if (
          priorAudit.action !== "created" ||
          priorAudit.actor_id !== parsed.data.actorId ||
          priorAudit.after_state.domain !== domain ||
          priorAudit.after_state.reason !== SYSTEM_REASON ||
          priorAudit.after_state.enabled !== true
        ) {
          await client.query("ROLLBACK");
          return reply.code(409).send({ error: "idempotency_conflict" });
        }
        ruleId = priorAudit.rule_id;
        idempotent = true;
      } else {
        const inserted = await client.query<{ id: string }>(
          `
            INSERT INTO fiat_email_domain_blacklist (
              domain, reason, enabled, created_by, updated_by
            ) VALUES ($1,$2,true,$3,$3)
            ON CONFLICT (lower(domain)) DO NOTHING
            RETURNING id
          `,
          [domain, SYSTEM_REASON, parsed.data.actorId],
        );
        ruleId = inserted.rows[0]?.id ?? null;
        if (!ruleId) {
          await client.query("ROLLBACK");
          return reply.code(409).send({ error: "domain_exists" });
        }
        const state = {
          id: ruleId,
          domain,
          reason: SYSTEM_REASON,
          enabled: true,
        };
        await client.query(
          `
            INSERT INTO fiat_email_domain_blacklist_audit (
              rule_id, action, actor_id, actor_username, idempotency_key,
              after_state
            ) VALUES ($1,'created',$2,$3,$4,$5)
          `,
          [
            ruleId,
            parsed.data.actorId,
            parsed.data.actorUsername ?? null,
            parsed.data.idempotencyKey,
            state,
          ],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const row = ruleId ? (await listRules(db, ruleId))[0] : null;
    if (!row) return reply.code(500).send({ error: "rule_missing" });
    return reply.code(idempotent ? 200 : 201).send({
      data: { ...serializeRule(row), idempotent },
    });
  });

  app.put("/v1/fiat-email-domains/:id", async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const parsed = updateSchema.safeParse(request.body);
    if (!params.success || !parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }

    const client = await db.antifraud.connect();
    let idempotent = false;
    try {
      await client.query("BEGIN");
      const prior = await client.query<{
        rule_id: string;
        action: string;
        actor_id: string;
        after_state: {
          reason?: unknown;
          enabled?: unknown;
        };
      }>(
        `
          SELECT rule_id, action, actor_id, after_state
          FROM fiat_email_domain_blacklist_audit
          WHERE idempotency_key = $1
        `,
        [parsed.data.idempotencyKey],
      );
      const priorAudit = prior.rows[0];
      if (priorAudit) {
        if (
          priorAudit.rule_id !== params.data.id ||
          priorAudit.action !== "updated" ||
          priorAudit.actor_id !== parsed.data.actorId ||
          priorAudit.after_state.enabled !== parsed.data.enabled
        ) {
          await client.query("ROLLBACK");
          return reply.code(409).send({ error: "idempotency_conflict" });
        }
        idempotent = true;
      } else {
        const before = await client.query<{
          id: string;
          domain: string;
          reason: string;
          enabled: boolean;
        }>(
          `
            SELECT id, domain, reason, enabled
            FROM fiat_email_domain_blacklist
            WHERE id = $1
            FOR UPDATE
          `,
          [params.data.id],
        );
        const current = before.rows[0];
        if (!current) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: "not_found" });
        }
        await client.query(
          `
            UPDATE fiat_email_domain_blacklist
            SET
              enabled = $2,
              updated_by = $3,
              backfill_received_at = CASE
                WHEN NOT enabled AND $2::boolean THEN 'epoch'::timestamptz
                ELSE backfill_received_at
              END,
              backfill_source_id = CASE
                WHEN NOT enabled AND $2::boolean THEN ''
                ELSE backfill_source_id
              END,
              backfill_completed_at = CASE
                WHEN NOT enabled AND $2::boolean THEN NULL
                ELSE backfill_completed_at
              END,
              updated_at = now()
            WHERE id = $1
          `,
          [
            params.data.id,
            parsed.data.enabled,
            parsed.data.actorId,
          ],
        );
        await client.query(
          `
            INSERT INTO fiat_email_domain_blacklist_audit (
              rule_id, action, actor_id, actor_username, idempotency_key,
              before_state, after_state
            ) VALUES ($1,'updated',$2,$3,$4,$5,$6)
          `,
          [
            params.data.id,
            parsed.data.actorId,
            parsed.data.actorUsername ?? null,
            parsed.data.idempotencyKey,
            current,
            {
              ...current,
              enabled: parsed.data.enabled,
            },
          ],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const row = (await listRules(db, params.data.id))[0];
    if (!row) return reply.code(404).send({ error: "not_found" });
    return { data: { ...serializeRule(row), idempotent } };
  });

  app.get("/v1/fiat-email-catches", async (request) => {
    const query = catchHistoryQuerySchema.parse(request.query);
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (query.riskType) {
      values.push(query.riskType);
      conditions.push(`match_type = $${values.length}`);
    }
    if (query.source) {
      values.push(query.source);
      conditions.push(`match_source = $${values.length}`);
    }
    if (query.lockStatus) {
      conditions.push(
        query.lockStatus === "locked"
          ? "lock_delivered_at IS NOT NULL"
          : "lock_delivered_at IS NULL",
      );
    }
    if (query.search) {
      values.push(`%${query.search.toLowerCase()}%`);
      conditions.push(`(
        lower(user_id) LIKE $${values.length}
        OR lower(COALESCE(username, '')) LIKE $${values.length}
        OR lower(checkout_email) LIKE $${values.length}
        OR lower(COALESCE(deposit_intent_id, '')) LIKE $${values.length}
      )`);
    }
    const where = conditions.length > 0
      ? `WHERE ${conditions.join(" AND ")}`
      : "";
    const offset = (query.page - 1) * query.limit;
    const listValues = [...values, query.limit, offset];
    const [rows, total] = await Promise.all([
      db.antifraud.query<{
        id: string;
        user_id: string;
        username: string | null;
        deposit_intent_id: string | null;
        checkout_email: string;
        domain: string;
        match_type:
          | "blacklisted_domain"
          | "gmail_dot_fragmentation"
          | "suspicious_deposit_cluster";
        match_source: "whop_checkout" | "signup";
        lock_delivered_at: Date | null;
        occurred_at: Date;
      }>(
        `
          SELECT
            id, user_id, username, deposit_intent_id, checkout_email, domain,
            match_type, match_source, lock_delivered_at, occurred_at
          FROM fiat_email_domain_matches
          ${where}
          ORDER BY occurred_at DESC, id DESC
          LIMIT $${listValues.length - 1}
          OFFSET $${listValues.length}
        `,
        listValues,
      ),
      db.antifraud.query<{ count: number }>(
        `SELECT count(*)::int AS count
         FROM fiat_email_domain_matches
         ${where}`,
        values,
      ),
    ]);
    const count = total.rows[0]?.count ?? 0;
    return {
      data: rows.rows.map((row) => ({
        id: row.id,
        userId: row.user_id,
        username: row.username,
        depositIntentId: row.deposit_intent_id,
        checkoutEmail: row.checkout_email,
        domain: row.domain,
        riskType: row.match_type,
        source: row.match_source,
        withdrawalsLocked: row.lock_delivered_at !== null,
        occurredAt: row.occurred_at.toISOString(),
      })),
      pagination: {
        page: query.page,
        limit: query.limit,
        total: count,
        pages: Math.max(1, Math.ceil(count / query.limit)),
      },
    };
  });

  app.get("/v1/fiat-email-domain-matches", async (request, reply) => {
    const query = z
      .object({ intentIds: z.string().max(10_000) })
      .safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const intentIds = [...new Set(query.data.intentIds.split(",").filter(Boolean))];
    if (
      intentIds.length === 0 ||
      intentIds.length > 200 ||
      intentIds.some((id) => !z.string().uuid().safeParse(id).success)
    ) {
      return reply.code(400).send({ error: "invalid_intent_ids" });
    }
    const matches = await db.antifraud.query<{
      deposit_intent_id: string;
      checkout_email: string;
      domain: string;
      match_type:
        | "blacklisted_domain"
        | "gmail_dot_fragmentation"
        | "suspicious_deposit_cluster";
      occurred_at: Date;
      lock_delivered_at: Date | null;
    }>(
      `
        SELECT DISTINCT ON (deposit_intent_id)
          deposit_intent_id,
          checkout_email,
          domain,
          match_type,
          occurred_at,
          lock_delivered_at
        FROM fiat_email_domain_matches
        WHERE deposit_intent_id = ANY($1::text[])
        ORDER BY deposit_intent_id, occurred_at DESC
      `,
      [intentIds],
    );
    return {
      data: matches.rows.map((match) => ({
        intentId: match.deposit_intent_id,
        checkoutEmail: match.checkout_email,
        domain: match.domain,
        riskType: match.match_type,
        riskScore: 100,
        severity: "critical",
        withdrawalsLocked: match.lock_delivered_at !== null,
        occurredAt: match.occurred_at.toISOString(),
      })),
    };
  });
}
