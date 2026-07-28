import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Databases } from "./db.js";
import { normalizeCountryCode, type RiskyLocationStore } from "./risky-locations.js";

const actorSchema = z.object({
  idempotencyKey: z.string().uuid(),
  actorId: z.string().trim().min(1).max(200),
  actorUsername: z.string().trim().min(1).max(100).optional(),
});

const createSchema = actorSchema.extend({
  countryCode: z.string().trim().length(2),
  monitorDurationMinutes: z.number().int().min(1).max(60),
});

const updateSchema = actorSchema.extend({
  enabled: z.boolean(),
  monitorDurationMinutes: z.number().int().min(1).max(60),
});

type LocationRow = {
  country_code: string;
  monitor_duration_seconds: number;
  enabled: boolean;
  created_by: string;
  updated_by: string;
  created_at: Date;
  updated_at: Date;
};

type AuditRow = {
  country_code: string;
  action: "created" | "updated";
  actor_id: string;
  actor_username: string | null;
  after_state: {
    enabled?: unknown;
    monitorDurationMinutes?: unknown;
  };
};

function isExactReplay(
  prior: AuditRow,
  expected: {
    countryCode: string;
    action: AuditRow["action"];
    actorId: string;
    actorUsername?: string;
    enabled: boolean;
    monitorDurationMinutes: number;
  },
): boolean {
  return (
    prior.country_code === expected.countryCode &&
    prior.action === expected.action &&
    prior.actor_id === expected.actorId &&
    prior.actor_username === (expected.actorUsername ?? null) &&
    prior.after_state.enabled === expected.enabled &&
    prior.after_state.monitorDurationMinutes ===
      expected.monitorDurationMinutes
  );
}

function serialize(row: LocationRow) {
  return {
    countryCode: row.country_code,
    monitorDurationMinutes: row.monitor_duration_seconds / 60,
    enabled: row.enabled,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function findLocations(
  db: Databases,
  countryCode?: string,
): Promise<LocationRow[]> {
  const result = await db.antifraud.query<LocationRow>(
    `
      SELECT
        country_code, monitor_duration_seconds, enabled,
        created_by, updated_by, created_at, updated_at
      FROM risky_locations
      WHERE ($1::text IS NULL OR country_code = $1)
      ORDER BY enabled DESC, country_code
    `,
    [countryCode ?? null],
  );
  return result.rows;
}

export async function registerRiskyLocationRoutes(
  app: FastifyInstance,
  db: Databases,
  store: RiskyLocationStore,
): Promise<void> {
  app.get("/v1/risky-locations", async () => ({
    data: (await findLocations(db)).map(serialize),
  }));

  app.post("/v1/risky-locations", async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    const countryCode = parsed.success
      ? normalizeCountryCode(parsed.data.countryCode)
      : null;
    if (!parsed.success || !countryCode) {
      return reply.code(400).send({ error: "invalid_request" });
    }

    const client = await db.antifraud.connect();
    let idempotent = false;
    try {
      await client.query("BEGIN");
      const prior = await client.query<AuditRow>(
        `
          SELECT country_code, action, actor_id, actor_username, after_state
          FROM risky_location_audit
          WHERE idempotency_key=$1
        `,
        [parsed.data.idempotencyKey],
      );
      if (prior.rows[0]) {
        if (
          !isExactReplay(prior.rows[0], {
            countryCode,
            action: "created",
            actorId: parsed.data.actorId,
            actorUsername: parsed.data.actorUsername,
            enabled: true,
            monitorDurationMinutes: parsed.data.monitorDurationMinutes,
          })
        ) {
          await client.query("ROLLBACK");
          return reply.code(409).send({ error: "idempotency_conflict" });
        }
        idempotent = true;
      } else {
        const inserted = await client.query<LocationRow>(
          `
            INSERT INTO risky_locations(
              country_code, monitor_duration_seconds, created_by, updated_by
            ) VALUES ($1,$2,$3,$3)
            ON CONFLICT (country_code) DO NOTHING
            RETURNING *
          `,
          [
            countryCode,
            parsed.data.monitorDurationMinutes * 60,
            parsed.data.actorId,
          ],
        );
        const created = inserted.rows[0];
        if (!created) {
          await client.query("ROLLBACK");
          return reply.code(409).send({ error: "country_exists" });
        }
        await client.query(
          `
            INSERT INTO risky_location_audit(
              country_code, action, actor_id, actor_username,
              idempotency_key, after_state
            ) VALUES ($1,'created',$2,$3,$4,$5)
          `,
          [
            countryCode,
            parsed.data.actorId,
            parsed.data.actorUsername ?? null,
            parsed.data.idempotencyKey,
            serialize(created),
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

    store.invalidate();
    const row = (await findLocations(db, countryCode))[0];
    if (!row) return reply.code(500).send({ error: "location_missing" });
    return reply.code(idempotent ? 200 : 201).send({
      data: { ...serialize(row), idempotent },
    });
  });

  app.put("/v1/risky-locations/:countryCode", async (request, reply) => {
    const params = z
      .object({ countryCode: z.string().trim().length(2) })
      .safeParse(request.params);
    const parsed = updateSchema.safeParse(request.body);
    const countryCode = params.success
      ? normalizeCountryCode(params.data.countryCode)
      : null;
    if (!parsed.success || !countryCode) {
      return reply.code(400).send({ error: "invalid_request" });
    }

    const client = await db.antifraud.connect();
    let idempotent = false;
    try {
      await client.query("BEGIN");
      const prior = await client.query<AuditRow>(
        `
          SELECT country_code, action, actor_id, actor_username, after_state
          FROM risky_location_audit
          WHERE idempotency_key=$1
        `,
        [parsed.data.idempotencyKey],
      );
      if (prior.rows[0]) {
        if (
          !isExactReplay(prior.rows[0], {
            countryCode,
            action: "updated",
            actorId: parsed.data.actorId,
            actorUsername: parsed.data.actorUsername,
            enabled: parsed.data.enabled,
            monitorDurationMinutes: parsed.data.monitorDurationMinutes,
          })
        ) {
          await client.query("ROLLBACK");
          return reply.code(409).send({ error: "idempotency_conflict" });
        }
        idempotent = true;
      } else {
        const before = await client.query<LocationRow>(
          `SELECT * FROM risky_locations WHERE country_code=$1 FOR UPDATE`,
          [countryCode],
        );
        const current = before.rows[0];
        if (!current) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: "not_found" });
        }
        const updated = await client.query<LocationRow>(
          `
            UPDATE risky_locations
            SET enabled=$2, monitor_duration_seconds=$3,
                updated_by=$4, updated_at=now()
            WHERE country_code=$1
            RETURNING *
          `,
          [
            countryCode,
            parsed.data.enabled,
            parsed.data.monitorDurationMinutes * 60,
            parsed.data.actorId,
          ],
        );
        await client.query(
          `
            INSERT INTO risky_location_audit(
              country_code, action, actor_id, actor_username,
              idempotency_key, before_state, after_state
            ) VALUES ($1,'updated',$2,$3,$4,$5,$6)
          `,
          [
            countryCode,
            parsed.data.actorId,
            parsed.data.actorUsername ?? null,
            parsed.data.idempotencyKey,
            serialize(current),
            serialize(updated.rows[0] as LocationRow),
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

    store.invalidate();
    const row = (await findLocations(db, countryCode))[0];
    if (!row) return reply.code(404).send({ error: "not_found" });
    return { data: { ...serialize(row), idempotent } };
  });
}
