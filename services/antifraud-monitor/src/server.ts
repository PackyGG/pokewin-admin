import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import websocket from "@fastify/websocket";
import { isDeepStrictEqual } from "node:util";
import {
  isListLoaded as isDisposableEmailListLoaded,
  preload as preloadDisposableEmailDomains,
} from "@visulima/disposable-email-domains";
import Fastify from "fastify";
import { z } from "zod";

import { serviceRequestAuthorized } from "./auth.js";
import { loadConfig } from "./config.js";
import {
  assertDatabaseConnections,
  closeDatabases,
  createDatabases,
} from "./db.js";
import {
  sameDecisionIdentity,
  type StoredDecisionIdentity,
} from "./decision-idempotency.js";
import { LiveBus, STREAM_ID_PATTERN } from "./live.js";
import { migrate } from "./migrate.js";
import { MonitorEngine } from "./monitor.js";
import {
  isDocumentedMonitorEvent,
  MONITOR_EVENT_CATALOG,
  unavailableMonitorEvents,
} from "./event-catalog.js";
import { registerNetworkRoutes } from "./network-routes.js";
import { registerFiatEmailDomainRoutes } from "./fiat-email-domain-routes.js";
import { registerRiskyLocationRoutes } from "./risky-location-routes.js";
import { NetworkRiskService } from "./network-risk.js";
import { pollerStalledFor } from "./poller-health.js";
import { createPromiseCache } from "./promise-cache.js";
import {
  caseDecisionSchema,
  ruleCreateSchema,
  ruleUpdateSchema,
  scoreWeightUpdateSchema,
} from "./request-schemas.js";
import {
  sameRuleUpdateIdentity,
  type StoredRuleUpdateIdentity,
} from "./rule-idempotency.js";
import { sanitizedRuntimeConfig } from "./runtime-config.js";
import { registerFiatRoutes } from "./fiat-routes.js";
import { FiatRiskService } from "./fiat-risk.js";
import { IngestDelivery } from "./ingest-delivery.js";
import {
  activityScoreDefinitions,
  isScoreWeightKey,
  providerScoreDefinitions,
  SEVERITY_BANDS,
  signupScoreDefinitions,
} from "./score-catalog.js";
import {
  ScoreWeightConflictError,
  ScoreWeightStore,
} from "./score-weight-store.js";
import { topRainWinners } from "./source.js";
import {
  clientErrorStatus,
  ticketRateLimitKey,
} from "./transport-limits.js";
import { registerWithdrawalRoutes } from "./withdrawal-routes.js";
import { WithdrawalRiskService } from "./withdrawal-risk.js";

// Naive timestamps read from either database must be interpreted as UTC even
// when the container image ships a local zone. The pools pin the session
// TimeZone too; this pins the Node process.
process.env.TZ ??= "UTC";

const config = loadConfig();
const SECRET_VALUES = [
  config.FINGERPRINT_SECRET_API_KEY,
  config.PROXYCHECK_API_KEY,
  config.API_TOKEN,
  config.API_ADMIN_TOKEN,
  config.SOURCE_DATABASE_URL,
  config.ANTIFRAUD_DATABASE_URL,
  config.REDIS_URL,
  config.ANTIFRAUD_INGEST_SECRET,
  config.ANTIFRAUD_DISCORD_WEBHOOK_URL,
  config.ANTIFRAUD_WITHDRAWAL_HOLD_DISCORD_WEBHOOK_URL,
  config.FIAT_ALERT_DISCORD_WEBHOOK_URL,
  config.FIAT_HIGH_RISK_DISCORD_WEBHOOK_URL,
  config.FIAT_EMAIL_BLACKLIST_DISCORD_WEBHOOK_URL,
].filter(
  (value): value is string =>
    typeof value === "string" && value.length >= 8,
);

function scrubSecrets(value: string): string {
  return SECRET_VALUES.reduce(
    (text, secret) => text.replaceAll(secret, "[redacted]"),
    value,
  );
}
const allowedOrigins = new Set(
  config.ALLOWED_ORIGINS.split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => new URL(value).origin),
);
const app = Fastify({
  logger: {
    level: config.NODE_ENV === "production" ? "info" : "debug",
    // `redact` takes object PATHS, not values. Secret VALUES that leak into an
    // error message or stack are scrubbed by the serializer below instead.
    redact: [
      "req.headers.authorization",
      "req.headers.sec-websocket-protocol",
      "req.query.ticket",
    ],
    serializers: {
      err(error: Error & { code?: unknown }) {
        return {
          type: error.name ?? "Error",
          message: scrubSecrets(error.message ?? String(error)),
          stack: scrubSecrets(error.stack ?? ""),
          ...(typeof error.code === "string"
            ? { code: scrubSecrets(error.code) }
            : {}),
        };
      },
    },
  },
  trustProxy: 1,
  requestTimeout: 15_000,
  bodyLimit: 256 * 1024,
  routerOptions: {
    maxParamLength: 100,
  },
});
const db = createDatabases(config);
const live = new LiveBus(config.REDIS_URL, app.log);
const scoreWeights = new ScoreWeightStore(db.antifraud);
const networkRisk = new NetworkRiskService(db, app.log);
const withdrawalRisk = new WithdrawalRiskService(db, app.log);
const fiatRisk = new FiatRiskService(db);
const ingestDelivery = new IngestDelivery(
  config,
  db.antifraud,
  app.log,
);
const engine = new MonitorEngine(
  config,
  db,
  live,
  scoreWeights,
  app.log,
  (userId) => networkRisk.enqueueAccount(userId).then(() => undefined),
);
let shuttingDown = false;

/** Lookback that bounds the resolved tail of the case list. */
const CASES_RECENT_DAYS = 30;
/** Fallback audit actor when a caller does not identify the human operator. */
const SERVICE_ACTOR_ID = "service:admin-api";
const TOP_RAIN_CACHE_MS = 30_000;
type TopRainRow = Awaited<ReturnType<typeof topRainWinners>>[number];
const cachedTopRain = createPromiseCache<number, TopRainRow[]>(
  (limit) => topRainWinners(db.source, limit),
  TOP_RAIN_CACHE_MS,
);

function ruleEventError(
  sequence: string[],
  excludeBefore: string[],
  enabled: boolean,
): { code: string; events: string[] } | null {
  const eventKeys = [...sequence, ...excludeBefore];
  const undocumented = [...new Set(
    eventKeys.filter((key) => !isDocumentedMonitorEvent(key)),
  )];
  if (undocumented.length > 0) {
    return { code: "unknown_events", events: undocumented };
  }
  const unavailable = enabled ? unavailableMonitorEvents(eventKeys) : [];
  return unavailable.length > 0
    ? { code: "events_not_live", events: unavailable }
    : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

async function publishCommittedMutation(
  type: string,
  data: Record<string, unknown>,
): Promise<void> {
  try {
    await live.publish(type, data);
  } catch (error) {
    app.log.warn(
      { err: error, liveEvent: type },
      "Committed antifraud mutation could not be broadcast",
    );
  }
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
    // Logged so an ALLOWED_ORIGINS misconfiguration is distinguishable from a
    // network or auth failure instead of surfacing as a generic client error.
    request.log.warn(
      {
        origin: origin ?? null,
        allowedOrigins: [...allowedOrigins],
        secFetchSite: request.headers["sec-fetch-site"] ?? null,
      },
      "Rejected antifraud request: origin not in ALLOWED_ORIGINS",
    );
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
  if (!serviceRequestAuthorized(request.method, pathname ?? "", token, config)) {
    return reply.code(401).send({ error: "unauthorized" });
  }
});

app.get("/health", async (_request, reply) => {
  const poller = engine.healthSnapshot();
  const stalledForMs = pollerStalledFor(
    poller,
    config.POLLER_LIVENESS_TIMEOUT_MS,
  );
  const body = {
    status: stalledForMs !== null
      ? "stalled"
      : poller.status === "degraded"
        ? "degraded"
        : "ok",
    stalledForMs,
    poller: {
      status: poller.status,
      leader: poller.leader,
      lastSuccessfulTickAt: poller.lastSuccessfulTickAt,
      consecutiveFailures: poller.consecutiveFailures,
      signupsRecovered: poller.signupsRecovered,
      signupFailuresPending: poller.signupFailuresPending,
    },
  };
  // A wedged engine must fail the platform healthcheck so the process is
  // restarted instead of serving a permanently silent monitor.
  if (stalledForMs !== null) return reply.code(503).send(body);
  return body;
});
app.get("/ready", async (_request, reply) => {
  try {
    await assertDatabaseConnections(db);
    const poller = engine.healthSnapshot();
    const liveStatus = { subscribed: live.isSubscribed() };
    if (
      poller.status === "starting" ||
      poller.status === "degraded" ||
      !liveStatus.subscribed
    ) {
      return reply.code(503).send({ status: "not_ready", poller, live: liveStatus });
    }
    return { status: "ready", poller, live: liveStatus };
  } catch {
    return reply.code(503).send({ status: "not_ready" });
  }
});

app.get("/v1/operations/poller", async () => ({
  data: engine.healthSnapshot(),
}));

/**
 * Authoritative deployed configuration for admin status surfaces. This is
 * intentionally presence-only except for recipient ids compiled into this
 * service; URLs, tokens, provider keys and webhook secrets never leave Railway.
 */
app.get("/v1/operations/config", async () => ({
  data: sanitizedRuntimeConfig(config, allowedOrigins.size),
}));

app.get("/v1/monitors/live", async () => {
  const result = await db.antifraud.query(
    `
      SELECT
        ms.id AS session_id, ms.case_id, ms.user_id, s.username,
        ms.started_at, ms.ends_at, ms.current_score, ms.peak_score,
        ms.event_count, c.severity,
        (
          SELECT pc.signals
          FROM provider_checks pc
          WHERE pc.user_id = ms.user_id
            AND pc.provider = 'proxycheck'
          ORDER BY pc.checked_at DESC
          LIMIT 1
        ) AS proxycheck_signals
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

app.get("/v1/signups/unseen-count", async (request) => {
  const query = z
    .object({
      since: z.iso.datetime(),
      until: z.iso.datetime(),
    })
    .refine(
      ({ since, until }) => Date.parse(until) >= Date.parse(since),
      { message: "until must not precede since" },
    )
    .parse(request.query);
  const result = await db.antifraud.query<{ count: number }>(
    `
      SELECT LEAST(COUNT(*), 100)::int AS count
      FROM subjects
      WHERE source_created_at > $1::timestamptz
        AND source_created_at <= $2::timestamptz
    `,
    [query.since, query.until],
  );
  return { data: { count: result.rows[0]?.count ?? 0 } };
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
  // `cases` grows one row per monitored signup and is never pruned, so the list
  // is always bounded: live cases plus anything touched in the recent window.
  // The ordering matches the cases_severity_rank_updated_idx expression index.
  const conditions = [
    `(c.status <> 'resolved' OR c.updated_at >= now() - interval '${CASES_RECENT_DAYS} days')`,
  ];
  const values: unknown[] = [];
  if (query.status) {
    values.push(query.status);
    conditions.push(`c.status = $${values.length}`);
  }
  values.push(query.limit);
  const result = await db.antifraud.query(
    `
      SELECT
        c.*, s.username, s.email, s.signup_ip::text, s.country_code, s.city,
        (
          SELECT pc.signals
          FROM provider_checks pc
          WHERE pc.user_id = c.user_id
            AND pc.provider = 'proxycheck'
          ORDER BY pc.checked_at DESC
          LIMIT 1
        ) AS proxycheck_signals
      FROM cases c
      JOIN subjects s ON s.user_id = c.user_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY
        (CASE c.severity
          WHEN 'critical' THEN 4 WHEN 'high' THEN 3
          WHEN 'medium' THEN 2 ELSE 1
        END) DESC,
        c.updated_at DESC
      LIMIT $${values.length}
    `,
    values,
  );
  return { data: result.rows };
});

app.get("/v1/cases/:id", async (request, reply) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
  const [caseResult, events, checks, sessions, actions, members, matches] = await Promise.all([
    db.antifraud.query(
      `
        SELECT
          c.id, c.user_id, c.status, c.severity, c.score, c.peak_score,
          c.summary, c.assigned_to, c.resolution, c.opened_at, c.updated_at,
          c.resolved_at, c.subject_type, c.network_key, c.network_snapshot_id,
          s.username, s.email, s.signup_ip::text,
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
    db.antifraud.query(
      `SELECT ncm.user_id, ncm.is_root, s.username, s.avatar_url
         FROM network_case_members ncm
         LEFT JOIN subjects s ON s.user_id=ncm.user_id
        WHERE ncm.case_id=$1
        ORDER BY ncm.is_root DESC, COALESCE(s.username, ncm.user_id)
        LIMIT 5000`,
      [id],
    ),
    db.antifraud.query(
      `SELECT
          rm.id, rm.session_id, rd.key AS rule_key,
          COALESCE(rm.evidence->>'ruleName', rd.name) AS rule_name,
          COALESCE((rm.evidence->>'scoreDelta')::int, rd.score_delta) AS score_delta,
          COALESCE(rm.evidence->>'actionType', rd.action_type) AS action_type,
          COALESCE(rm.evidence->'sequence', rd.sequence) AS sequence,
          rm.matched_at
         FROM rule_matches rm
         JOIN rule_definitions rd ON rd.id=rm.rule_id
        WHERE rm.case_id=$1
        ORDER BY rm.matched_at
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
      members: members.rows,
      matches: matches.rows,
    },
  };
});

app.get("/v1/events", async () => ({
  data: MONITOR_EVENT_CATALOG,
}));

app.get("/v1/rules", async () => {
  const result = await db.antifraud.query(
    "SELECT * FROM rule_definitions ORDER BY priority, name",
  );
  return { data: result.rows };
});

app.post("/v1/rules", {
  config: {
    rateLimit: {
      max: config.API_WRITE_RATE_LIMIT_PER_MINUTE,
      timeWindow: "1 minute",
    },
  },
}, async (request, reply) => {
  const body = ruleCreateSchema.parse(request.body);
  const eventError = ruleEventError(
    body.sequence,
    body.excludeBefore,
    body.enabled,
  );
  if (eventError) return reply.code(400).send({ error: eventError.code, events: eventError.events });

  const actorId = body.actorId ?? SERVICE_ACTOR_ID;
  const actorUsername = body.actorUsername ?? null;
  const {
    idempotencyKey: _idempotencyKey,
    actorId: _actorId,
    actorUsername: _actorUsername,
    ...changes
  } = body;
  const requestIdentity = { actorId, actorUsername, changes };
  const client = await db.antifraud.connect();
  let created: Record<string, unknown>;
  let idempotent = false;
  try {
    await client.query("BEGIN");
    const duplicate = await client.query<{
      action: string;
      actor_id: string;
      actor_username: string | null;
      request_state: unknown;
      after_state: Record<string, unknown> | null;
    }>(
      `SELECT action, actor_id, actor_username, request_state, after_state
         FROM service_audit_events
        WHERE idempotency_key=$1`,
      [body.idempotencyKey],
    );
    const existing = duplicate.rows[0];
    if (existing) {
      if (
        existing.action !== "rule.create" ||
        existing.actor_id !== actorId ||
        existing.actor_username !== actorUsername ||
        !isDeepStrictEqual(existing.request_state, requestIdentity) ||
        !existing.after_state
      ) {
        await client.query("COMMIT");
        return reply.code(409).send({ error: "idempotency_conflict" });
      }
      created = existing.after_state;
      idempotent = true;
      await client.query("COMMIT");
    } else {
      const result = await client.query(
        `
          INSERT INTO rule_definitions(
            key, name, description, enabled, trigger, sequence, exclude_before,
            window_seconds, score_delta, action_type, priority
          ) VALUES (
            'custom-' || gen_random_uuid()::text,$1,$2,$3,'sequence',$4::jsonb,
            $5::jsonb,$6,$7,$8,
            (SELECT COALESCE(MAX(priority), 0) + 10 FROM rule_definitions)
          )
          RETURNING *
        `,
        [
          body.name,
          body.description,
          body.enabled,
          JSON.stringify(body.sequence),
          JSON.stringify(body.excludeBefore),
          body.windowSeconds,
          body.scoreDelta,
          body.actionType,
        ],
      );
      created = result.rows[0] as Record<string, unknown>;
      await client.query(
        `INSERT INTO service_audit_events(
           idempotency_key, actor_id, actor_username, action, target_type,
           target_id, request_state, before_state, after_state
         ) VALUES (
           $1,$2,$3,'rule.create','rule',$4,$5::jsonb,NULL,$6::jsonb
         )`,
        [
          body.idempotencyKey,
          actorId,
          actorUsername,
          created.id,
          JSON.stringify(requestIdentity),
          JSON.stringify(created),
        ],
      );
      await client.query("COMMIT");
    }
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  engine.invalidateRules();
  if (!idempotent) await publishCommittedMutation("rule.created", { rule: created });
  return { data: created, idempotent };
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
  const body = ruleUpdateSchema.parse(request.body);
  const actorId = body.actorId ?? SERVICE_ACTOR_ID;
  const actorUsername = body.actorUsername ?? null;
  const {
    idempotencyKey: _idempotencyKey,
    actorId: _actorId,
    actorUsername: _actorUsername,
    ...changes
  } = body;
  const requestIdentity = {
    targetId: id,
    actorId,
    actorUsername,
    changes,
  };

  const client = await db.antifraud.connect();
  let updated: Record<string, unknown>;
  try {
    await client.query("BEGIN");
    const duplicate = await client.query<StoredRuleUpdateIdentity>(
      `SELECT action, target_id, actor_id, actor_username, request_state
         FROM service_audit_events
        WHERE idempotency_key=$1`,
      [body.idempotencyKey],
    );
    const existing = duplicate.rows[0];
    if (existing) {
      if (!sameRuleUpdateIdentity(existing, requestIdentity)) {
        await client.query("COMMIT");
        return reply.code(409).send({ error: "idempotency_conflict" });
      }
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
    const currentRule = before.rows[0] as Record<string, unknown>;
    const nextSequence = body.sequence ?? stringArray(currentRule.sequence);
    const nextExcludeBefore =
      body.excludeBefore ?? stringArray(currentRule.exclude_before);
    const nextEnabled =
      body.enabled ?? currentRule.enabled === true;
    const eventError = ruleEventError(
      nextSequence,
      nextExcludeBefore,
      nextEnabled,
    );
    if (eventError) {
      await client.query("ROLLBACK");
      return reply.code(400).send({
        error: eventError.code,
        events: eventError.events,
      });
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
         idempotency_key, actor_id, actor_username, action, target_type,
         target_id, request_state, before_state, after_state
       ) VALUES (
         $1,$2,$3,'rule.update','rule',$4,$5::jsonb,$6::jsonb,$7::jsonb
       )`,
      [
        body.idempotencyKey,
        actorId,
        actorUsername,
        id,
        JSON.stringify(requestIdentity),
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
  engine.invalidateRules();
  await publishCommittedMutation("rule.updated", { rule: updated });
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
  const body = caseDecisionSchema.parse(request.body);
  const status = body.decision.startsWith("resolved_")
    ? "resolved"
    : body.decision === "escalated"
      ? "escalated"
      : "in_review";
  const client = await db.antifraud.connect();
  let userId: string;
  try {
    await client.query("BEGIN");
    const actorId = body.actorId ?? SERVICE_ACTOR_ID;
    const actorUsername = body.actorUsername ?? null;
    const duplicate = await client.query<StoredDecisionIdentity>(
      `SELECT case_id, action_type, actor_id, actor_username, reason
         FROM staff_actions
        WHERE idempotency_key=$1`,
      [body.idempotencyKey],
    );
    const existing = duplicate.rows[0];
    if (existing) {
      const exactReplay = sameDecisionIdentity(existing, {
        caseId: id,
        decision: body.decision,
        actorId,
        actorUsername,
        reason: body.reason,
      });
      await client.query("COMMIT");
      return exactReplay
        ? { success: true, idempotent: true }
        : reply.code(409).send({ error: "idempotency_conflict" });
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
          case_id,user_id,action_type,status,actor_id,actor_username,reason,
          idempotency_key,completed_at
        ) VALUES ($1,$2,$3,'completed',$4,$5,$6,$7,now())
      `,
      [
        id,
        userId,
        body.decision,
        actorId,
        actorUsername,
        body.reason,
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
  await publishCommittedMutation("case.decided", {
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
  return { data: await cachedTopRain(limit) };
});

app.post("/v1/ws/tickets", {
  config: {
    rateLimit: {
      max: config.WS_TICKET_RATE_LIMIT_PER_MINUTE,
      timeWindow: "1 minute",
      hook: "preHandler",
      keyGenerator: ticketRateLimitKey,
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

/**
 * Bounded catch-up for a client that missed frames (the admin SSE proxy is torn
 * down at least every 5 minutes by its serverless duration cap). `after` is the
 * last live-frame id the client saw; omit it for the most recent events.
 */
app.get("/v1/live/replay", async (request) => {
  const query = z.object({
    after: z.string().regex(STREAM_ID_PATTERN).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(200),
  }).parse(request.query);
  const events = await live.replay(query.after ?? null, query.limit);
  return {
    data: events,
    cursor: events[events.length - 1]?.id ?? query.after ?? null,
  };
});

app.get("/v1/live", { websocket: true }, async (socket, request) => {
  const origin = request.headers.origin;
  if (!origin || !allowedOrigins.has(origin)) {
    request.log.warn(
      { origin: origin ?? null, allowedOrigins: [...allowedOrigins] },
      "Rejected antifraud live websocket: origin not in ALLOWED_ORIGINS",
    );
    socket.close(1008, "origin_not_allowed");
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
    socket.close(1008, "invalid_ticket");
    return;
  }
  if (!live.addClient(socket, ticket.actorId)) {
    request.log.warn(
      { actorId: ticket.actorId },
      "Rejected antifraud live websocket: actor connection capacity reached",
    );
    socket.close(1013, "connection_capacity");
  }
});

app.get("/v1/scoring", async () => {
  const [rules, weights] = await Promise.all([
    db.antifraud.query(
      `SELECT id, key, name, description, enabled, trigger, sequence,
              exclude_before, window_seconds, score_delta, action_type, priority,
              updated_at
         FROM rule_definitions
        ORDER BY priority, name`,
    ),
    scoreWeights.get(),
  ]);
  return {
    data: {
      monitorStartScore: config.MONITOR_START_SCORE,
      monitorDurationSeconds: config.MONITOR_DURATION_SECONDS,
      severityBands: SEVERITY_BANDS,
      signupSignals: signupScoreDefinitions(weights),
      providerSignals: providerScoreDefinitions(weights),
      activitySignals: activityScoreDefinitions(weights),
      behaviorRules: rules.rows,
    },
  };
});

app.put("/v1/scoring/:key", {
  config: {
    rateLimit: {
      max: config.API_WRITE_RATE_LIMIT_PER_MINUTE,
      timeWindow: "1 minute",
    },
  },
}, async (request, reply) => {
  const { key } = z.object({ key: z.string() }).parse(request.params);
  if (!isScoreWeightKey(key)) {
    return reply.code(404).send({ error: "not_found" });
  }
  const body = scoreWeightUpdateSchema.parse(request.body);
  try {
    const updated = await scoreWeights.update({
      key,
      points: body.points,
      actorId: body.actorId ?? SERVICE_ACTOR_ID,
      actorUsername: body.actorUsername ?? null,
      idempotencyKey: body.idempotencyKey,
    });
    return { data: updated };
  } catch (error) {
    if (error instanceof ScoreWeightConflictError) {
      return reply.code(409).send({ error: "idempotency_conflict" });
    }
    throw error;
  }
});

await registerNetworkRoutes(app, db, networkRisk, config);
await registerFiatEmailDomainRoutes(app, db);
await registerRiskyLocationRoutes(app, db, engine.riskyLocations);
await registerWithdrawalRoutes(app, db, withdrawalRisk);
await registerFiatRoutes(app, db, fiatRisk);

app.setErrorHandler((error, request, reply) => {
  if (error instanceof z.ZodError) {
    return reply.code(400).send({
      error: "invalid_request",
      issues: error.issues,
    });
  }
  const clientStatus = clientErrorStatus(error);
  if (clientStatus !== null) {
    request.log.warn(
      { statusCode: clientStatus },
      "Antifraud API request rejected",
    );
    return reply.code(clientStatus).send({
      error: clientStatus === 429 ? "rate_limited" : "request_rejected",
    });
  }
  app.log.error({ err: error }, "Unhandled request error");
  return reply.code(500).send({ error: "internal_error" });
});

app.addHook("onClose", async () => {
  shuttingDown = true;
  withdrawalRisk.stop();
  await ingestDelivery.stop();
  await engine.stop();
  await networkRisk.stop();
  await live.close();
  await closeDatabases(db);
});

await migrate(db.antifraud);
await db.antifraud.query("SELECT 1");
await preloadDisposableEmailDomains();
if (!isDisposableEmailListLoaded()) {
  throw new Error("Disposable email domain list failed to load");
}
// Fail the boot when the live channel cannot be subscribed: a green service
// publishing into a channel with zero subscribers is silently broken.
await live.start();
await ingestDelivery.start();
await networkRisk.start();
withdrawalRisk.start();
await app.listen({ port: config.PORT, host: "0.0.0.0" });

// The MAIN mirror role is shared with other read-only consumers and can
// temporarily exhaust its connection allowance during a rolling deployment.
// Keep the API and durable Antifraud DB online while the poller retries. The
// /ready route remains 503 until both databases and the poller are healthy.
void (async () => {
  let failures = 0;
  while (!shuttingDown) {
    try {
      await engine.start();
      app.log.info(
        failures > 0 ? { failures } : undefined,
        "Antifraud source poller started",
      );
      return;
    } catch (error) {
      failures += 1;
      const retryInMs = Math.min(30_000, 1_000 * (2 ** Math.min(failures - 1, 5)));
      app.log.warn(
        { err: error, failures, retryInMs },
        "Antifraud source poller startup deferred",
      );
      await new Promise((resolve) => setTimeout(resolve, retryInMs));
    }
  }
})();
