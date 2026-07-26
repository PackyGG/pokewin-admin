import { timingSafeEqual } from "node:crypto";

import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { z } from "zod";

import { loadConfig } from "./config.js";
import {
  assertDatabaseConnections,
  closeDatabases,
  createDatabases,
} from "./db.js";
import { LiveBus } from "./live.js";
import { migrate } from "./migrate.js";
import { MonitorEngine } from "./monitor.js";
import {
  ACTIVITY_SCORE_DEFINITIONS,
  PROVIDER_SCORE_DEFINITIONS,
  SEVERITY_BANDS,
  SIGNUP_SCORE_DEFINITIONS,
} from "./score-catalog.js";
import { topRainWinners } from "./source.js";

const config = loadConfig();
const allowedOrigins = new Set(
  config.ALLOWED_ORIGINS.split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => new URL(value).origin),
);
const app = Fastify({
  logger: {
    level: config.NODE_ENV === "production" ? "info" : "debug",
    redact: [
      "req.headers.authorization",
      "req.headers.sec-websocket-protocol",
      "req.query.ticket",
      "FINGERPRINT_SECRET_API_KEY",
      "PROXYCHECK_API_KEY",
      "API_TOKEN",
    ],
  },
  trustProxy: 1,
  requestTimeout: 15_000,
  bodyLimit: 256 * 1024,
  routerOptions: {
    maxParamLength: 100,
  },
});
const db = createDatabases(config);
const live = new LiveBus(config.REDIS_URL);
const engine = new MonitorEngine(config, db, live, app.log);

function safeTokenEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

await app.register(cors, {
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) {
      callback(null, true);
      return;
    }
    callback(null, false);
  },
  credentials: false,
  methods: ["GET", "POST", "PUT"],
  allowedHeaders: ["authorization", "content-type", "accept"],
  maxAge: 600,
});
await app.register(helmet, {
  contentSecurityPolicy: false,
});
await app.register(rateLimit, {
  global: true,
  max: config.API_RATE_LIMIT_PER_MINUTE,
  timeWindow: "1 minute",
  ban: 5,
});
await app.register(swagger, {
  openapi: {
    info: {
      title: "Packy Antifraud Monitor API",
      version: "0.1.0",
    },
  },
});
await app.register(websocket, {
  options: {
    maxPayload: 128 * 1024,
    perMessageDeflate: false,
  },
});

app.addHook("onSend", async (request, reply, payload) => {
  if (request.url === "/health" || request.url.startsWith("/v1/")) {
    reply.header("Cache-Control", "no-store");
  }
  return payload;
});

app.addHook("onRequest", async (request, reply) => {
  const origin = request.headers.origin;
  if (
    (origin && !allowedOrigins.has(origin)) ||
    request.headers["sec-fetch-site"] === "cross-site"
  ) {
    return reply.code(403).send({ error: "origin_not_allowed" });
  }

  const pathname = request.url.split("?", 1)[0];
  if (
    pathname === "/health" ||
    (request.method === "GET" && pathname === "/v1/live")
  ) {
    return;
  }
  const authorization = request.headers.authorization ?? "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";
  const needsAdminToken =
    (request.method === "PUT" && request.url.startsWith("/v1/rules/")) ||
    (request.method === "POST" && request.url.includes("/decision"));
  const authorized = needsAdminToken
    ? safeTokenEqual(token, config.API_ADMIN_TOKEN)
    : safeTokenEqual(token, config.API_TOKEN) ||
      safeTokenEqual(token, config.API_ADMIN_TOKEN);
  if (!authorized) {
    return reply.code(401).send({ error: "unauthorized" });
  }
});

app.get("/health", async () => {
  const poller = engine.healthSnapshot();
  return {
    status: poller.status === "degraded" ? "degraded" : "ok",
    poller: {
      status: poller.status,
      leader: poller.leader,
      lastSuccessfulTickAt: poller.lastSuccessfulTickAt,
      consecutiveFailures: poller.consecutiveFailures,
    },
  };
});
app.get("/ready", async (_request, reply) => {
  try {
    await assertDatabaseConnections(db);
    const poller = engine.healthSnapshot();
    if (poller.status === "starting" || poller.status === "degraded") {
      return reply.code(503).send({ status: "not_ready", poller });
    }
    return { status: "ready", poller };
  } catch {
    return reply.code(503).send({ status: "not_ready" });
  }
});

app.get("/v1/operations/poller", async () => ({
  data: engine.healthSnapshot(),
}));

app.get("/v1/monitors/live", async () => {
  const result = await db.antifraud.query(
    `
      SELECT
        ms.id AS session_id, ms.case_id, ms.user_id, s.username,
        ms.started_at, ms.ends_at, ms.current_score, ms.peak_score,
        ms.event_count, c.severity
      FROM monitor_sessions ms
      JOIN cases c ON c.id = ms.case_id
      JOIN subjects s ON s.user_id = ms.user_id
      WHERE ms.status = 'active'
      ORDER BY ms.current_score DESC, ms.started_at
      LIMIT 200
    `,
  );
  return { data: result.rows };
});

app.get("/v1/signups", async (request) => {
  const query = z.object({
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }).parse(request.query);
  const offset = (query.page - 1) * query.limit;
  const [rows, summary] = await Promise.all([
    db.antifraud.query(
      `
        SELECT
          s.user_id, s.username, s.email, s.avatar_url, s.signup_ip::text,
          s.country, s.country_code, s.state, s.city, s.affiliate_code,
          s.referred_by, s.source_created_at,
          COALESCE(sa.score, 0)::int AS score,
          COALESCE(sa.severity, 'low') AS severity,
          COALESCE(sa.signals, '[]'::jsonb) AS signals,
          sa.assessed_at,
          fingerprint.status AS fingerprint_status,
          fingerprint.score AS fingerprint_score,
          COALESCE(fingerprint.signals, '[]'::jsonb) AS fingerprint_signals,
          proxycheck.status AS proxycheck_status,
          proxycheck.score AS proxycheck_score,
          COALESCE(proxycheck.signals, '[]'::jsonb) AS proxycheck_signals,
          latest_case.id AS case_id,
          latest_case.status AS case_status,
          latest_case.severity AS case_severity,
          latest_monitor.status AS monitor_status,
          latest_monitor.ends_at AS monitor_ends_at
        FROM subjects s
        LEFT JOIN signup_assessments sa ON sa.user_id = s.user_id
        LEFT JOIN LATERAL (
          SELECT status, score::float8 AS score, signals
          FROM provider_checks
          WHERE user_id = s.user_id AND provider = 'fingerprint'
          ORDER BY checked_at DESC
          LIMIT 1
        ) fingerprint ON true
        LEFT JOIN LATERAL (
          SELECT status, score::float8 AS score, signals
          FROM provider_checks
          WHERE user_id = s.user_id AND provider = 'proxycheck'
          ORDER BY checked_at DESC
          LIMIT 1
        ) proxycheck ON true
        LEFT JOIN LATERAL (
          SELECT id, status, severity
          FROM cases
          WHERE user_id = s.user_id
          ORDER BY updated_at DESC
          LIMIT 1
        ) latest_case ON true
        LEFT JOIN LATERAL (
          SELECT status, ends_at
          FROM monitor_sessions
          WHERE user_id = s.user_id
          ORDER BY started_at DESC
          LIMIT 1
        ) latest_monitor ON true
        ORDER BY s.source_created_at DESC, s.user_id DESC
        LIMIT $1 OFFSET $2
      `,
      [query.limit, offset],
    ),
    db.antifraud.query<{
      total: number;
      assessed: number;
      attention: number;
      monitoring: number;
    }>(
      `
        SELECT
          COUNT(*)::int AS total,
          COUNT(sa.user_id)::int AS assessed,
          COUNT(*) FILTER (WHERE sa.score >= $1)::int AS attention,
          COUNT(*) FILTER (
            WHERE EXISTS (
              SELECT 1 FROM monitor_sessions ms
              WHERE ms.user_id = s.user_id AND ms.status = 'active'
            )
          )::int AS monitoring
        FROM subjects s
        LEFT JOIN signup_assessments sa ON sa.user_id = s.user_id
      `,
      [config.MONITOR_START_SCORE],
    ),
  ]);
  return {
    data: rows.rows,
    pagination: {
      page: query.page,
      limit: query.limit,
      total: summary.rows[0]?.total ?? 0,
      pages: Math.max(
        1,
        Math.ceil((summary.rows[0]?.total ?? 0) / query.limit),
      ),
    },
    summary: summary.rows[0] ?? {
      total: 0,
      assessed: 0,
      attention: 0,
      monitoring: 0,
    },
  };
});

app.get("/v1/cases", async (request) => {
  const query = z.object({
    status: z.enum([
      "open",
      "monitoring",
      "in_review",
      "escalated",
      "resolved",
    ]).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }).parse(request.query);
  const values: unknown[] = [];
  const where = query.status
    ? (values.push(query.status), `WHERE c.status = $${values.length}`)
    : "";
  values.push(query.limit);
  const result = await db.antifraud.query(
    `
      SELECT c.*, s.username, s.email, s.signup_ip::text, s.country_code, s.city
      FROM cases c
      JOIN subjects s ON s.user_id = c.user_id
      ${where}
      ORDER BY
        CASE c.severity
          WHEN 'critical' THEN 4 WHEN 'high' THEN 3
          WHEN 'medium' THEN 2 ELSE 1
        END DESC,
        c.updated_at DESC
      LIMIT $${values.length}
    `,
    values,
  );
  return { data: result.rows };
});

app.get("/v1/cases/:id", async (request, reply) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
  const [caseResult, events, checks, sessions, actions] = await Promise.all([
    db.antifraud.query(
      `
        SELECT
          c.id, c.user_id, c.status, c.severity, c.score, c.peak_score,
          c.summary, c.assigned_to, c.resolution, c.opened_at, c.updated_at,
          c.resolved_at, s.username, s.email, s.signup_ip::text,
          s.country_code, s.state, s.city, s.source_created_at
        FROM cases c JOIN subjects s ON s.user_id = c.user_id
        WHERE c.id = $1
      `,
      [id],
    ),
    db.antifraud.query(
      `SELECT id, case_id, session_id, user_id, event_type, source, source_ref,
              score_delta, score_after, title, detail, occurred_at, recorded_at
         FROM risk_events
        WHERE case_id=$1
        ORDER BY occurred_at, recorded_at
        LIMIT 500`,
      [id],
    ),
    db.antifraud.query(
      `SELECT pc.id, pc.user_id, pc.provider, pc.request_id, pc.status,
              pc.score, pc.signals, pc.error_code, pc.checked_at, pc.expires_at
         FROM provider_checks pc
         JOIN cases c ON c.user_id=pc.user_id
        WHERE c.id=$1
        ORDER BY checked_at
        LIMIT 100`,
      [id],
    ),
    db.antifraud.query(
      `SELECT id, case_id, user_id, status, started_at, ends_at, ended_at,
              initial_score, current_score, peak_score, event_count
         FROM monitor_sessions
        WHERE case_id=$1
        ORDER BY started_at
        LIMIT 100`,
      [id],
    ),
    db.antifraud.query(
      `SELECT id, case_id, user_id, action_type, status, actor_id,
              actor_username, reason, created_at, completed_at
         FROM staff_actions
        WHERE case_id=$1
        ORDER BY created_at
        LIMIT 200`,
      [id],
    ),
  ]);
  if (!caseResult.rows[0]) return reply.code(404).send({ error: "not_found" });
  return {
    data: {
      case: caseResult.rows[0],
      events: events.rows,
      providerChecks: checks.rows,
      sessions: sessions.rows,
      actions: actions.rows,
    },
  };
});

app.get("/v1/rules", async () => {
  const result = await db.antifraud.query(
    "SELECT * FROM rule_definitions ORDER BY priority, name",
  );
  return { data: result.rows };
});

app.put("/v1/rules/:id", {
  config: {
    rateLimit: {
      max: config.API_WRITE_RATE_LIMIT_PER_MINUTE,
      timeWindow: "1 minute",
    },
  },
}, async (request, reply) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
  const body = z.object({
    idempotencyKey: z.string().uuid(),
    name: z.string().min(1).max(100).optional(),
    description: z.string().max(500).optional(),
    enabled: z.boolean().optional(),
    sequence: z.array(z.string().min(1).max(100)).min(1).max(20).optional(),
    excludeBefore: z.array(z.string().min(1).max(100)).max(20).optional(),
    windowSeconds: z.number().int().min(1).max(86_400).optional(),
    scoreDelta: z.number().int().min(-500).max(500).optional(),
    actionType: z.enum(["manual_review", "escalate"]).optional(),
  }).strict().refine(
    (value) => Object.keys(value).some((key) => key !== "idempotencyKey"),
    { message: "At least one rule field must be supplied" },
  ).parse(request.body);

  const client = await db.antifraud.connect();
  let updated: Record<string, unknown>;
  try {
    await client.query("BEGIN");
    const duplicate = await client.query(
      "SELECT 1 FROM service_audit_events WHERE idempotency_key=$1",
      [body.idempotencyKey],
    );
    if (duplicate.rows[0]) {
      const current = await client.query(
        "SELECT * FROM rule_definitions WHERE id=$1",
        [id],
      );
      await client.query("COMMIT");
      if (!current.rows[0]) return reply.code(404).send({ error: "not_found" });
      return { data: current.rows[0], idempotent: true };
    }
    const before = await client.query(
      "SELECT * FROM rule_definitions WHERE id=$1 FOR UPDATE",
      [id],
    );
    if (!before.rows[0]) {
      await client.query("ROLLBACK");
      return reply.code(404).send({ error: "not_found" });
    }
    const result = await client.query(
      `
        UPDATE rule_definitions SET
          name=COALESCE($2,name),
          description=COALESCE($3,description),
          enabled=COALESCE($4,enabled),
          sequence=COALESCE($5,sequence),
          exclude_before=COALESCE($6,exclude_before),
          window_seconds=COALESCE($7,window_seconds),
          score_delta=COALESCE($8,score_delta),
          action_type=COALESCE($9,action_type),
          updated_at=now()
        WHERE id=$1 RETURNING *
      `,
      [
        id,
        body.name ?? null,
        body.description ?? null,
        body.enabled ?? null,
        body.sequence ? JSON.stringify(body.sequence) : null,
        body.excludeBefore ? JSON.stringify(body.excludeBefore) : null,
        body.windowSeconds ?? null,
        body.scoreDelta ?? null,
        body.actionType ?? null,
      ],
    );
    updated = result.rows[0] as Record<string, unknown>;
    await client.query(
      `INSERT INTO service_audit_events(
         idempotency_key, actor_id, action, target_type, target_id,
         before_state, after_state
       ) VALUES ($1,'service:admin-api','rule.update','rule',$2,$3::jsonb,$4::jsonb)`,
      [
        body.idempotencyKey,
        id,
        JSON.stringify(before.rows[0]),
        JSON.stringify(updated),
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await live.publish("rule.updated", { rule: updated });
  return { data: updated };
});

app.post("/v1/cases/:id/decision", {
  config: {
    rateLimit: {
      max: config.API_WRITE_RATE_LIMIT_PER_MINUTE,
      timeWindow: "1 minute",
    },
  },
}, async (request, reply) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
  const body = z.object({
    decision: z.enum(["in_review", "escalated", "resolved_safe", "resolved_fraud"]),
    idempotencyKey: z.string().uuid(),
    reason: z.string().trim().min(1).max(1000),
  }).strict().parse(request.body);
  const status = body.decision.startsWith("resolved_")
    ? "resolved"
    : body.decision === "escalated"
      ? "escalated"
      : "in_review";
  const client = await db.antifraud.connect();
  let userId: string;
  try {
    await client.query("BEGIN");
    const duplicate = await client.query<{ user_id: string }>(
      "SELECT user_id FROM staff_actions WHERE idempotency_key=$1",
      [body.idempotencyKey],
    );
    if (duplicate.rows[0]) {
      await client.query("COMMIT");
      return { success: true, idempotent: true };
    }
    const current = await client.query<{ user_id: string; status: string }>(
      "SELECT user_id, status FROM cases WHERE id=$1 FOR UPDATE",
      [id],
    );
    const row = current.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return reply.code(404).send({ error: "not_found" });
    }
    if (row.status === "resolved") {
      await client.query("ROLLBACK");
      return reply.code(409).send({ error: "case_already_resolved" });
    }
    userId = row.user_id;
    await client.query(
      `UPDATE cases
          SET status=$2, resolution=$3, updated_at=now(),
              resolved_at=CASE WHEN $2='resolved' THEN now() ELSE NULL END
        WHERE id=$1`,
      [id, status, body.decision],
    );
    await client.query(
      `
        INSERT INTO staff_actions(
          case_id,user_id,action_type,status,actor_id,reason,
          idempotency_key,completed_at
        ) VALUES ($1,$2,$3,'completed','service:admin-api',$4,$5,now())
      `,
      [id, userId, body.decision, body.reason, body.idempotencyKey],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await live.publish("case.decided", {
    caseId: id,
    userId,
    decision: body.decision,
  });
  return { success: true };
});

app.get("/v1/top-rain", async (request) => {
  const { limit } = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(10),
  }).parse(request.query);
  return { data: await topRainWinners(db.source, limit) };
});

app.post("/v1/ws/tickets", {
  config: {
    rateLimit: {
      max: config.WS_TICKET_RATE_LIMIT_PER_MINUTE,
      timeWindow: "1 minute",
    },
  },
}, async (request) => {
  const actor = z.object({
    actorId: z.string().min(1).max(100),
    actorUsername: z.string().max(100).optional(),
  }).strict().parse(request.body);
  const ticket = await live.createTicket(actor);
  return {
    data: {
      ticket,
      websocketUrl: `${config.PUBLIC_BASE_URL.replace(/^http/, "ws")}/v1/live`,
      expiresInSeconds: 30,
    },
  };
});

app.get("/v1/live", { websocket: true }, async (socket, request) => {
  const origin = request.headers.origin;
  if (!origin || !allowedOrigins.has(origin)) {
    socket.close(1008, "Origin not allowed");
    return;
  }
  const protocolHeader = request.headers["sec-websocket-protocol"];
  const protocol = typeof protocolHeader === "string"
    ? protocolHeader.split(",").map((value) => value.trim()).find(
      (value) => value.startsWith("antifraud-ticket."),
    )
    : undefined;
  const rawTicket = protocol?.slice("antifraud-ticket.".length);
  const parsed = z.string().regex(/^[A-Za-z0-9_-]{40,100}$/).safeParse(rawTicket);
  const ticket = parsed.success ? await live.consumeTicket(parsed.data) : null;
  if (!ticket) {
    socket.close(1008, "Invalid or expired ticket");
    return;
  }
  if (!live.addClient(socket, ticket.actorId)) {
    socket.close(1013, "Too many live connections");
  }
});

app.get("/v1/scoring", async () => {
  const rules = await db.antifraud.query(
    `SELECT id, key, name, description, enabled, trigger, sequence,
            exclude_before, window_seconds, score_delta, action_type, priority,
            updated_at
       FROM rule_definitions
      ORDER BY priority, name`,
  );
  return {
    data: {
      monitorStartScore: config.MONITOR_START_SCORE,
      monitorDurationSeconds: config.MONITOR_DURATION_SECONDS,
      severityBands: SEVERITY_BANDS,
      signupSignals: SIGNUP_SCORE_DEFINITIONS,
      providerSignals: PROVIDER_SCORE_DEFINITIONS,
      activitySignals: ACTIVITY_SCORE_DEFINITIONS,
      behaviorRules: rules.rows,
    },
  };
});

app.setErrorHandler((error, _request, reply) => {
  if (error instanceof z.ZodError) {
    return reply.code(400).send({
      error: "invalid_request",
      issues: error.issues,
    });
  }
  app.log.error({ err: error }, "Unhandled request error");
  return reply.code(500).send({ error: "internal_error" });
});

app.addHook("onClose", async () => {
  await engine.stop();
  await live.close();
  await closeDatabases(db);
});

await migrate(db.antifraud);
await assertDatabaseConnections(db);
await engine.start();
await app.listen({ port: config.PORT, host: "0.0.0.0" });
