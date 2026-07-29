import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Config } from "./config.js";
import type { Databases } from "./db.js";
import {
  CREATOR_WINDOW_KEYS,
  NetworkRiskService,
} from "./network-risk.js";

const uuid = z.string().uuid();
const windowSchema = z.enum(CREATOR_WINDOW_KEYS);
const pageSchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

function requestedBy(body: unknown): {
  actorId?: string;
  actorUsername?: string;
} {
  return z.object({
    actorId: z.string().trim().min(1).max(100).optional(),
    actorUsername: z.string().trim().min(1).max(100).optional(),
  }).strict().parse(body);
}

export async function registerNetworkRoutes(
  app: FastifyInstance,
  db: Databases,
  service: NetworkRiskService,
  config: Config,
): Promise<void> {
  app.get("/v1/networks/search", async (request) => {
    const { q } = z.object({
      q: z.string().trim().min(2).max(100),
    }).parse(request.query);
    const prefix = `${q.toLowerCase()}%`;
    const result = await db.source.query(
      `
        SELECT id, username, email, image, country_code, created_at AT TIME ZONE 'UTC' AS created_at
        FROM "user"
        WHERE id=$1
           OR lower(username) LIKE $2
           OR lower(email)=$3
        ORDER BY
          CASE WHEN id=$1 THEN 0 WHEN lower(username)=lower($1) THEN 1 ELSE 2 END,
          created_at DESC
        LIMIT 20
      `,
      [q, prefix, q.toLowerCase()],
    );
    return { data: result.rows };
  });

  app.get("/v1/networks/accounts/:userId", async (request, reply) => {
    const { userId } = z.object({
      userId: z.string().trim().min(1).max(100),
    }).parse(request.params);
    const snapshot = await db.antifraud.query(
      `
        SELECT ns.*
        FROM network_snapshots ns
        WHERE ns.id = (
          SELECT n.snapshot_id
          FROM network_nodes n
          JOIN network_snapshots candidate ON candidate.id=n.snapshot_id
          WHERE n.user_id=$1
          ORDER BY candidate.scanned_at DESC
          LIMIT 1
        )
      `,
      [userId],
    );
    const row = snapshot.rows[0];
    if (row) return { data: row };
    const exists = await db.source.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM "user" WHERE id=$1) AS exists`,
      [userId],
    );
    if (!exists.rows[0]?.exists) {
      return reply.code(404).send({ error: "not_found" });
    }
    const jobId = await service.enqueueAccount(userId);
    return reply.code(202).send({ data: null, jobId, status: "queued" });
  });

  app.get("/v1/networks/:snapshotId/graph", async (request, reply) => {
    const { snapshotId } = z.object({ snapshotId: uuid }).parse(request.params);
    const query = pageSchema.extend({
      limit: z.coerce.number().int().min(1).max(2_000).default(500),
    }).parse(request.query);
    const offset = (query.page - 1) * query.limit;
    const snapshot = await db.antifraud.query(
      "SELECT * FROM network_snapshots WHERE id=$1",
      [snapshotId],
    );
    if (!snapshot.rows[0]) return reply.code(404).send({ error: "not_found" });
    const nodes = await db.antifraud.query(
      `
        WITH account_page AS (
          SELECT node_key
          FROM network_nodes
          WHERE snapshot_id=$1 AND node_type='account'
          ORDER BY (user_id=(SELECT root_user_id FROM network_snapshots WHERE id=$1)) DESC,
                   degree DESC, node_key
          LIMIT $2 OFFSET $3
        ),
        connector_keys AS (
          SELECT DISTINCT e.target_key AS node_key
          FROM network_edges e
          WHERE e.snapshot_id=$1 AND e.source_key IN (SELECT node_key FROM account_page)
        )
        SELECT node_key AS key, node_type AS type, user_id, label, metadata, degree
        FROM network_nodes
        WHERE snapshot_id=$1
          AND (
            node_key IN (SELECT node_key FROM account_page)
            OR node_key IN (SELECT node_key FROM connector_keys)
          )
        ORDER BY
          CASE node_type WHEN 'account' THEN 0 WHEN 'ip' THEN 1 ELSE 2 END,
          degree DESC, node_key
        LIMIT 2000
      `,
      [snapshotId, query.limit, offset],
    );
    const nodeKeys = nodes.rows.map((node) => String(node.key));
    const edges = nodeKeys.length > 0
      ? await db.antifraud.query(
          `
            SELECT source_key AS source, target_key AS target, edge_type AS type
            FROM network_edges
            WHERE snapshot_id=$1
              AND source_key=ANY($2::text[])
            LIMIT 20_000
          `,
          [snapshotId, nodeKeys],
        )
      : { rows: [] };
    return {
      data: {
        snapshot: snapshot.rows[0],
        nodes: nodes.rows,
        edges: edges.rows,
      },
      pagination: {
        page: query.page,
        limit: query.limit,
        total: Number(snapshot.rows[0].account_count ?? 0),
        pages: Math.max(
          1,
          Math.ceil(Number(snapshot.rows[0].account_count ?? 0) / query.limit),
        ),
      },
    };
  });

  app.get(
    "/v1/networks/:snapshotId/nodes/:nodeKey/reveal",
    async (request, reply) => {
      const { snapshotId, nodeKey } = z.object({
        snapshotId: uuid,
        nodeKey: z.string().min(1).max(100),
      }).parse(request.params);
      const result = await db.antifraud.query<{ exact_value: string }>(
        `
          SELECT exact_value
          FROM network_node_secrets
          WHERE snapshot_id=$1 AND node_key=$2
        `,
        [snapshotId, nodeKey],
      );
      const value = result.rows[0]?.exact_value;
      return value
        ? { data: { value } }
        : reply.code(404).send({ error: "not_found" });
    },
  );

  app.post("/v1/networks/accounts/:userId/rescan", {
    config: {
      rateLimit: {
        max: config.API_WRITE_RATE_LIMIT_PER_MINUTE,
        timeWindow: "1 minute",
      },
    },
  }, async (request, reply) => {
    const { userId } = z.object({
      userId: z.string().trim().min(1).max(100),
    }).parse(request.params);
    const actor = requestedBy(request.body);
    const jobId = await service.enqueueAccount(
      userId,
      actor.actorUsername ?? actor.actorId,
    );
    return reply.code(202).send({ data: { jobId, status: "queued" } });
  });

  app.get("/v1/network-scans/:jobId", async (request, reply) => {
    const { jobId } = z.object({ jobId: uuid }).parse(request.params);
    const result = await db.antifraud.query(
      `
        SELECT id, target_kind, target_id, window_days, status, error_text,
               created_at, started_at, completed_at
        FROM network_scan_jobs WHERE id=$1
      `,
      [jobId],
    );
    return result.rows[0]
      ? { data: result.rows[0] }
      : reply.code(404).send({ error: "not_found" });
  });

  app.post("/v1/network-cases", {
    config: {
      rateLimit: {
        max: config.API_WRITE_RATE_LIMIT_PER_MINUTE,
        timeWindow: "1 minute",
      },
    },
  }, async (request, reply) => {
    const body = z.object({
      snapshotId: uuid,
      reason: z.string().trim().min(1).max(1_000),
      idempotencyKey: uuid,
      actorId: z.string().trim().min(1).max(100),
      actorUsername: z.string().trim().min(1).max(100).optional(),
    }).strict().parse(request.body);
    const client = await db.antifraud.connect();
    try {
      await client.query("BEGIN");
      const snapshot = await client.query<{
        root_user_id: string;
        network_key: string;
        score: number;
        severity: string;
      }>(
        `
          SELECT root_user_id, network_key, score, severity
          FROM network_snapshots WHERE id=$1 FOR UPDATE
        `,
        [body.snapshotId],
      );
      const row = snapshot.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: "not_found" });
      }
      const caseResult = await client.query<{ id: string }>(
        `
          INSERT INTO cases(
            user_id, subject_type, network_key, network_snapshot_id,
            status, severity, score, peak_score, summary
          ) VALUES ($1,'network',$2,$3,'open',$4,$5,$5,$6)
          ON CONFLICT (network_key)
            WHERE subject_type='network'
              AND network_key IS NOT NULL
              AND status IN ('open','monitoring','in_review','escalated')
          DO UPDATE SET
            network_snapshot_id=EXCLUDED.network_snapshot_id,
            score=GREATEST(cases.score, EXCLUDED.score),
            peak_score=GREATEST(cases.peak_score, EXCLUDED.peak_score),
            severity=EXCLUDED.severity,
            updated_at=now()
          RETURNING id
        `,
        [
          row.root_user_id,
          row.network_key,
          body.snapshotId,
          row.severity,
          row.score,
          body.reason,
        ],
      );
      const caseId = caseResult.rows[0]?.id;
      if (!caseId) throw new Error("Failed to open network case");
      await client.query(
        `
          INSERT INTO network_case_members(case_id, user_id, is_root)
          SELECT $1, user_id, user_id=$2
          FROM network_nodes
          WHERE snapshot_id=$3 AND user_id IS NOT NULL
          ON CONFLICT (case_id, user_id) DO NOTHING
        `,
        [caseId, row.root_user_id, body.snapshotId],
      );
      await client.query(
        `
          INSERT INTO staff_actions(
            case_id, user_id, action_type, status, actor_id, actor_username,
            reason, idempotency_key, completed_at
          ) VALUES ($1,$2,'network_case_opened','completed',$3,$4,$5,$6,now())
          ON CONFLICT (idempotency_key) DO NOTHING
        `,
        [
          caseId,
          row.root_user_id,
          body.actorId,
          body.actorUsername ?? null,
          body.reason,
          body.idempotencyKey,
        ],
      );
      await client.query("COMMIT");
      return { data: { caseId } };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.get("/v1/creator-fraud", async (request) => {
    const query = pageSchema.extend({
      window: windowSchema.default("30d"),
      search: z.string().trim().max(100).optional(),
    }).parse(request.query);
    const offset = (query.page - 1) * query.limit;
    const search = query.search ? `%${query.search.toLowerCase()}%` : null;
    const identityMatches = search
      ? await db.source.query<{ id: string }>(
          `
            SELECT DISTINCT u.id
            FROM "user" u
            JOIN affiliate_codes ac ON ac.user_id=u.id
            WHERE lower(COALESCE(u.display_username,'')) LIKE $1
               OR lower(COALESCE(u.username,'')) LIKE $1
               OR lower(COALESCE(u.email,'')) LIKE $1
            LIMIT 500
          `,
          [search],
        )
      : { rows: [] };
    const matchingCreatorIds = identityMatches.rows.map((row) => row.id);
    const [assessments, total] = await Promise.all([
      db.antifraud.query(
        `
          SELECT *
          FROM creator_fraud_assessments
          WHERE window_key=$1
            AND (
              $2::text IS NULL
              OR lower(creator_user_id) LIKE $2
              OR lower(codes::text) LIKE $2
              OR creator_user_id=ANY($5::text[])
            )
          ORDER BY score DESC, assessed_at DESC, creator_user_id
          LIMIT $3 OFFSET $4
        `,
        [query.window, search, query.limit, offset, matchingCreatorIds],
      ),
      db.antifraud.query<{ count: number }>(
        `
          SELECT COUNT(*)::int AS count
          FROM creator_fraud_assessments
          WHERE window_key=$1
            AND (
              $2::text IS NULL
              OR lower(creator_user_id) LIKE $2
              OR lower(codes::text) LIKE $2
              OR creator_user_id=ANY($3::text[])
            )
        `,
        [query.window, search, matchingCreatorIds],
      ),
    ]);
    if (search === null && (total.rows[0]?.count ?? 0) === 0) {
      await service.enqueueCreatorReconciliation(query.window);
    }
    const creatorIds = assessments.rows.map((row) =>
      String(row.creator_user_id)
    );
    const identities = creatorIds.length
      ? await db.source.query(
          `
            SELECT id, username, display_username, email, image, country_code
            FROM "user" WHERE id=ANY($1::text[])
          `,
          [creatorIds],
        )
      : { rows: [] };
    const byId = new Map(
      identities.rows.map((row) => [String(row.id), row]),
    );
    return {
      data: assessments.rows.map((row) => ({
        ...row,
        creator: byId.get(String(row.creator_user_id)) ?? null,
      })),
      pagination: {
        page: query.page,
        limit: query.limit,
        total: total.rows[0]?.count ?? 0,
        pages: Math.max(
          1,
          Math.ceil((total.rows[0]?.count ?? 0) / query.limit),
        ),
      },
    };
  });

  app.get("/v1/creator-fraud/:creatorId", async (request, reply) => {
    const { creatorId } = z.object({
      creatorId: z.string().trim().min(1).max(100),
    }).parse(request.params);
    const { window } = z.object({
      window: windowSchema.default("30d"),
    }).parse(request.query);
    const result = await db.antifraud.query(
      `
        SELECT * FROM creator_fraud_assessments
        WHERE creator_user_id=$1 AND window_key=$2
      `,
      [creatorId, window],
    );
    if (!result.rows[0]) {
      const jobId = await service.enqueueCreator(creatorId, window);
      return reply.code(202).send({ data: null, jobId, status: "queued" });
    }
    const creator = await db.source.query(
      `
        SELECT id, username, display_username, email, image, country_code
        FROM "user" WHERE id=$1
      `,
      [creatorId],
    );
    return { data: { ...result.rows[0], creator: creator.rows[0] ?? null } };
  });

  app.post("/v1/creator-fraud/:creatorId/rescan", {
    config: {
      rateLimit: {
        max: config.API_WRITE_RATE_LIMIT_PER_MINUTE,
        timeWindow: "1 minute",
      },
    },
  }, async (request, reply) => {
    const { creatorId } = z.object({
      creatorId: z.string().trim().min(1).max(100),
    }).parse(request.params);
    const body = z.object({
      window: windowSchema.default("30d"),
      actorId: z.string().trim().min(1).max(100).optional(),
      actorUsername: z.string().trim().min(1).max(100).optional(),
    }).strict().parse(request.body);
    const jobId = await service.enqueueCreator(
      creatorId,
      body.window,
      body.actorUsername ?? body.actorId,
    );
    return reply.code(202).send({ data: { jobId, status: "queued" } });
  });

  app.get("/v1/analysis-rules", async () => {
    const result = await db.antifraud.query(
      `
        SELECT key, category, name, description, enabled, points,
               threshold::float8 AS threshold, updated_by, updated_at
        FROM analysis_rules
        ORDER BY category, name
      `,
    );
    return { data: result.rows };
  });

  app.put("/v1/analysis-rules/:key", {
    config: {
      rateLimit: {
        max: config.API_WRITE_RATE_LIMIT_PER_MINUTE,
        timeWindow: "1 minute",
      },
    },
  }, async (request, reply) => {
    const { key } = z.object({
      key: z.string().trim().min(1).max(100),
    }).parse(request.params);
    const body = z.object({
      enabled: z.boolean(),
      points: z.number().int().min(-500).max(500),
      threshold: z.number().min(0).max(1_000_000),
      actorId: z.string().trim().min(1).max(100),
      actorUsername: z.string().trim().min(1).max(100).optional(),
    }).strict().parse(request.body);
    const result = await db.antifraud.query(
      `
        UPDATE analysis_rules
        SET enabled=$2, points=$3, threshold=$4, updated_by=$5, updated_at=now()
        WHERE key=$1
        RETURNING key, category, name, description, enabled, points,
                  threshold::float8 AS threshold, updated_by, updated_at
      `,
      [
        key,
        body.enabled,
        body.points,
        body.threshold,
        body.actorUsername ?? body.actorId,
      ],
    );
    return result.rows[0]
      ? { data: result.rows[0] }
      : reply.code(404).send({ error: "not_found" });
  });
}
