import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";

import type { Databases } from "./db.js";
import type { FiatEligibilityEnvironment } from "./fiat-eligibility-auth.js";

const environmentSchema = z.enum(["dev", "prod"]);
const paramsSchema = z.object({ userId: z.string().trim().min(1).max(100) });
const querySchema = z.object({ environment: environmentSchema.default("prod") });
const updateSchema = z.object({
  environment: environmentSchema.default("prod"),
  enabled: z.boolean(),
  reason: z.string().trim().min(4).max(500),
  actorId: z.string().trim().min(1).max(200),
  actorUsername: z.string().trim().min(1).max(100).optional(),
  idempotencyKey: z.uuid(),
}).strict();

type OverrideRow = {
  environment: FiatEligibilityEnvironment;
  user_id: string;
  enabled: boolean;
  reason: string;
  updated_by: string;
  updated_by_username: string | null;
  updated_at: Date;
};

export type FiatEligibilityOverride = {
  environment: FiatEligibilityEnvironment;
  userId: string;
  enabled: boolean;
  reason: string | null;
  updatedBy: string | null;
  updatedByUsername: string | null;
  updatedAt: string | null;
};

function serialize(
  environment: FiatEligibilityEnvironment,
  userId: string,
  row?: OverrideRow,
): FiatEligibilityOverride {
  return {
    environment,
    userId,
    enabled: row?.enabled ?? false,
    reason: row?.reason ?? null,
    updatedBy: row?.updated_by ?? null,
    updatedByUsername: row?.updated_by_username ?? null,
    updatedAt: row?.updated_at.toISOString() ?? null,
  };
}

async function loadOverride(
  pool: pg.Pool | pg.PoolClient,
  environment: FiatEligibilityEnvironment,
  userId: string,
): Promise<OverrideRow | undefined> {
  const result = await pool.query<OverrideRow>(
    `SELECT environment,user_id,enabled,reason,updated_by,
            updated_by_username,updated_at
       FROM fiat_eligibility_overrides
      WHERE environment=$1 AND user_id=$2`,
    [environment, userId],
  );
  return result.rows[0];
}

export async function fiatEligibilityOverrideEnabled(
  pool: pg.Pool,
  environment: FiatEligibilityEnvironment,
  userId: string,
): Promise<boolean> {
  return (await loadOverride(pool, environment, userId))?.enabled === true;
}

export async function registerFiatEligibilityOverrideRoutes(
  app: FastifyInstance,
  db: Databases,
): Promise<void> {
  app.get("/v1/fiat-eligibility/overrides/:userId", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const query = querySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const row = await loadOverride(
      db.antifraud,
      query.data.environment,
      params.data.userId,
    );
    return {
      data: serialize(query.data.environment, params.data.userId, row),
    };
  });

  app.put("/v1/fiat-eligibility/overrides/:userId", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const parsed = updateSchema.safeParse(request.body);
    if (!params.success || !parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }

    const client = await db.antifraud.connect();
    let idempotent = false;
    try {
      await client.query("BEGIN");
      const prior = await client.query<{
        environment: FiatEligibilityEnvironment;
        user_id: string;
        enabled: boolean;
        reason: string;
        actor_id: string;
      }>(
        `SELECT environment,user_id,enabled,reason,actor_id
           FROM fiat_eligibility_override_audit
          WHERE idempotency_key=$1`,
        [parsed.data.idempotencyKey],
      );
      const previous = prior.rows[0];
      if (previous) {
        if (
          previous.environment !== parsed.data.environment
          || previous.user_id !== params.data.userId
          || previous.enabled !== parsed.data.enabled
          || previous.reason !== parsed.data.reason
          || previous.actor_id !== parsed.data.actorId
        ) {
          await client.query("ROLLBACK");
          return reply.code(409).send({ error: "idempotency_conflict" });
        }
        idempotent = true;
      } else {
        await client.query(
          `INSERT INTO fiat_eligibility_overrides (
             environment,user_id,enabled,reason,created_by,
             created_by_username,updated_by,updated_by_username
           ) VALUES ($1,$2,$3,$4,$5,$6,$5,$6)
           ON CONFLICT (environment,user_id) DO UPDATE SET
             enabled=EXCLUDED.enabled,
             reason=EXCLUDED.reason,
             updated_by=EXCLUDED.updated_by,
             updated_by_username=EXCLUDED.updated_by_username,
             updated_at=now()`,
          [
            parsed.data.environment,
            params.data.userId,
            parsed.data.enabled,
            parsed.data.reason,
            parsed.data.actorId,
            parsed.data.actorUsername ?? null,
          ],
        );
        await client.query(
          `INSERT INTO fiat_eligibility_override_audit (
             environment,user_id,enabled,reason,actor_id,actor_username,
             idempotency_key
           ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            parsed.data.environment,
            params.data.userId,
            parsed.data.enabled,
            parsed.data.reason,
            parsed.data.actorId,
            parsed.data.actorUsername ?? null,
            parsed.data.idempotencyKey,
          ],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    const row = await loadOverride(
      db.antifraud,
      parsed.data.environment,
      params.data.userId,
    );
    if (!row) return reply.code(500).send({ error: "persistence_failed" });
    return {
      data: {
        ...serialize(parsed.data.environment, params.data.userId, row),
        idempotent,
      },
    };
  });
}
