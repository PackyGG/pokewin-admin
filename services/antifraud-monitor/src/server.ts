import { timingSafeEqual } from "node:crypto";

import cors from "@fastify/cors";
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
import { topRainWinners } from "./source.js";

const config = loadConfig();
const app = Fastify({
  logger: {
    level: config.NODE_ENV === "production" ? "info" : "debug",
    redact: [
      "req.headers.authorization",
      "req.query.ticket",
      "FINGERPRINT_SECRET_API_KEY",
      "PROXYCHECK_API_KEY",
      "API_TOKEN",
    ],
  },
  trustProxy: true,
  requestTimeout: 15_000,
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
  origin: config.ALLOWED_ORIGINS.split(",").map((value) => value.trim()).filter(Boolean),
  credentials: true,
});
await app.register(swagger, {
  openapi: {
    info: {
      title: "Packy Antifraud Monitor API",
      version: "0.1.0",
    },
  },
});
await app.register(websocket);

app.addHook("onRequest", async (request, reply) => {
  if (
    request.url === "/health" ||
    request.url === "/ready" ||
    request.url.startsWith("/v1/live")
  ) {
    return;
  }
  const authorization = request.headers.authorization ?? "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";
  if (!safeTokenEqual(token, config.API_TOKEN)) {
    return reply.code(401).send({ error: "unauthorized" });
  }
});

app.get("/health", async () => ({ status: "ok" }));
app.get("/ready", async (_request, reply) => {
  try {
    await assertDatabaseConnections(db);
    return { status: "ready" };
  } catch {
    return reply.code(503).send({ status: "not_ready" });
  }
});

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

app.get("/v1/cases", async (request) => {
  const query = z.object({
    status: z.string().optional(),
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
        SELECT c.*, s.*
        FROM cases c JOIN subjects s ON s.user_id = c.user_id
        WHERE c.id = $1
      `,
      [id],
    ),
    db.antifraud.query(
      "SELECT * FROM risk_events WHERE case_id=$1 ORDER BY occurred_at, recorded_at",
      [id],
    ),
    db.antifraud.query(
      "SELECT pc.* FROM provider_checks pc JOIN cases c ON c.user_id=pc.user_id WHERE c.id=$1 ORDER BY checked_at",
      [id],
    ),
    db.antifraud.query(
      "SELECT * FROM monitor_sessions WHERE case_id=$1 ORDER BY started_at",
      [id],
    ),
    db.antifraud.query(
      "SELECT * FROM staff_actions WHERE case_id=$1 ORDER BY created_at",
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

app.put("/v1/rules/:id", async (request, reply) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
  const body = z.object({
    name: z.string().min(1).max(100).optional(),
    description: z.string().max(500).optional(),
    enabled: z.boolean().optional(),
    sequence: z.array(z.string().min(1)).min(1).max(20).optional(),
    excludeBefore: z.array(z.string().min(1)).max(20).optional(),
    windowSeconds: z.number().int().min(1).max(86_400).optional(),
    scoreDelta: z.number().int().min(-500).max(500).optional(),
    actionType: z.enum(["manual_review", "escalate"]).optional(),
  }).parse(request.body);
  const result = await db.antifraud.query(
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
  if (!result.rows[0]) return reply.code(404).send({ error: "not_found" });
  await live.publish("rule.updated", { rule: result.rows[0] });
  return { data: result.rows[0] };
});

app.post("/v1/cases/:id/decision", async (request, reply) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
  const body = z.object({
    decision: z.enum(["in_review", "escalated", "resolved_safe", "resolved_fraud"]),
    actorId: z.string().min(1),
    actorUsername: z.string().optional(),
    reason: z.string().min(1).max(1000),
  }).parse(request.body);
  const status = body.decision.startsWith("resolved_")
    ? "resolved"
    : body.decision === "escalated"
      ? "escalated"
      : "in_review";
  const result = await db.antifraud.query<{ user_id: string }>(
    `
      UPDATE cases
      SET status=$2, resolution=$3, updated_at=now(),
          resolved_at=CASE WHEN $2='resolved' THEN now() ELSE NULL END
      WHERE id=$1
      RETURNING user_id
    `,
    [id, status, body.decision],
  );
  const row = result.rows[0];
  if (!row) return reply.code(404).send({ error: "not_found" });
  await db.antifraud.query(
    `
      INSERT INTO staff_actions(
        case_id,user_id,action_type,status,actor_id,actor_username,reason,completed_at
      ) VALUES ($1,$2,$3,'completed',$4,$5,$6,now())
    `,
    [id, row.user_id, body.decision, body.actorId, body.actorUsername, body.reason],
  );
  await live.publish("case.decided", {
    caseId: id,
    userId: row.user_id,
    decision: body.decision,
    actorUsername: body.actorUsername,
  });
  return { success: true };
});

app.get("/v1/top-rain", async (request) => {
  const { limit } = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(10),
  }).parse(request.query);
  return { data: await topRainWinners(db.source, limit) };
});

app.post("/v1/ws/tickets", async (request) => {
  const actor = z.object({
    actorId: z.string().min(1),
    actorUsername: z.string().optional(),
  }).parse(request.body);
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
  const parsed = z.object({ ticket: z.string().min(20) }).safeParse(request.query);
  if (!parsed.success || !(await live.consumeTicket(parsed.data.ticket))) {
    socket.close(1008, "Invalid or expired ticket");
    return;
  }
  live.addClient(socket);
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
