import { createHash } from "node:crypto";

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
import * as Sentry from "@sentry/node";
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
import { LiveBus, STREAM_ID_PATTERN, TICKET_TTL_SECONDS } from "./live.js";
import { migrate } from "./migrate.js";
import { MonitorEngine } from "./monitor.js";
import {
  isDocumentedMonitorEvent,
  MONITOR_EVENT_CATALOG,
  NON_ACTIONABLE_REWARD_ENROLLMENT_EVENTS,
  unavailableMonitorEvents,
} from "./event-catalog.js";
import { registerNetworkRoutes } from "./network-routes.js";
import { registerFiatEmailDomainRoutes } from "./fiat-email-domain-routes.js";
import { registerIdentifierBlocklistRoutes } from "./identifier-blocklist-routes.js";
import { registerProfileRoutes } from "./profile-routes.js";
import { registerSignupFailureRoutes } from "./signup-failure-routes.js";
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
import { notificationRouteStatuses } from "./notification-routes.js";
import { registerFiatRoutes } from "./fiat-routes.js";
import { FIAT_ASSESSMENT_STATUSES, FiatRiskService } from "./fiat-risk.js";
import { cachedCreatorUserIds, excludedUserIds } from "./route-helpers.js";
import { EnrichmentService } from "./enrichment.js";
import { FiatEligibilityAccess } from "./fiat-eligibility-auth.js";
import {
  authenticateFiatEligibilityRequest,
  FIAT_ELIGIBILITY_PATH,
  registerFiatEligibilityRoutes,
} from "./fiat-eligibility-routes.js";
import { FiatEligibilityService } from "./fiat-eligibility.js";
import { registerFiatEligibilityOverrideRoutes } from "./fiat-eligibility-overrides.js";
import { FiatDepositAccessClient } from "./fiat-deposit-access.js";
import { FiatDepositAccessControl } from "./fiat-deposit-access-control.js";
import {
  isUnauthenticatedEosRandomBlockRequest,
  registerEosRandomBlockRoutes,
} from "./eos-random-block-routes.js";
import { DevBattleOutcomeSimulator } from "./battle-outcome-simulator.js";
import { PgBattleTestConfigStore } from "./battle-test-config.js";
import { IngestDelivery } from "./ingest-delivery.js";
import {
  activityScoreDefinitions,
  isScoreWeightKey,
  providerScoreDefinitions,
  type ScoreDefinition,
  SEVERITY_BANDS,
  signupScoreDefinitions,
} from "./score-catalog.js";
import { clampRiskScore } from "./scoring.js";
import type { LiveEventType } from "./types.js";
import {
  ScoreWeightConflictError,
  ScoreWeightStaleError,
  ScoreWeightStore,
} from "./score-weight-store.js";
import { topRainWinners } from "./source.js";
import {
  clientErrorStatus,
  createFixedWindowIpLimiter,
  ticketRateLimitKey,
} from "./transport-limits.js";
import { SumsubClient } from "./sumsub-client.js";
import { registerSumsubRoutes } from "./sumsub-routes.js";
import { KycCountryReviewService } from "./kyc-country-reviews.js";
import { DashboardOpsTick } from "./ops-tick.js";
import { DiscordAlerts } from "./discord.js";
import { MaxMindService, registerMaxMindAlertRoute } from "./maxmind.js";
import {
  bootstrapProviderAccessConfig,
  missingProviderCredentials,
  sendProviderAccessIssue,
} from "./provider-access-alerts.js";

// Naive timestamps read from either database must be interpreted as UTC even
// when the container image ships a local zone. The pools pin the session
// TimeZone too; this pins the Node process.
process.env.TZ ??= "UTC";

function observe(report: () => void): void {
  try {
    report();
  } catch {
    // Request handling must remain independent of the telemetry transport.
  }
}

const bootstrapAccessConfig = bootstrapProviderAccessConfig(process.env);
const missingAccessIssues = missingProviderCredentials(process.env);
if (bootstrapAccessConfig && missingAccessIssues.length > 0) {
  const bootstrapLog = {
    warn: (context: unknown, message?: string) => console.warn(message, context),
    error: (context: unknown, message?: string) => console.error(message, context),
  };
  await Promise.all(
    missingAccessIssues.map((issue) =>
      sendProviderAccessIssue(bootstrapAccessConfig, bootstrapLog, issue)
    ),
  );
}

const config = loadConfig();
const SECRET_VALUES = [
  config.FINGERPRINT_SECRET_API_KEY,
  config.PROXYCHECK_API_KEY,
  config.MAXMIND_LICENSE_KEY,
  config.MAXMIND_ALERT_WEBHOOK_SECRET,
  config.API_TOKEN,
  config.API_ADMIN_TOKEN,
  config.FIAT_ELIGIBILITY_DEV_API_KEY,
  config.FIAT_ELIGIBILITY_PROD_API_KEY,
  config.SOURCE_DATABASE_URL,
  config.FIAT_ELIGIBILITY_DEV_SOURCE_DATABASE_URL,
  config.BATTLE_TEST_DEV_DATABASE_URL,
  config.BATTLE_TEST_DEV_SERVER_SEED_PEPPER,
  config.ANTIFRAUD_DATABASE_URL,
  config.REDIS_URL,
  config.ANTIFRAUD_INGEST_SECRET,
  config.SUMSUB_ADMIN_TOKEN,
  config.SUMSUB_ADMIN_KEY,
  config.ADMIN_API_KEY,
  config.xbypasssecret,
  config.XBYPASSSECRET,
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
const battleTestConfig = new PgBattleTestConfigStore(db.antifraud);
const live = new LiveBus(config.REDIS_URL, app.log, {
  // Durable publish fallback: frames Redis rejects are parked in the
  // Antifraud-DB live_outbox and republished by the bus drain loop.
  outboxPool: db.antifraud,
  maxConnectionsPerActor: config.LIVE_MAX_CONNECTIONS_PER_ACTOR,
  maxConnections: config.LIVE_MAX_CONNECTIONS,
  sessionMaxAgeMs:
    config.LIVE_SESSION_MAX_AGE_MINUTES !== undefined
      ? config.LIVE_SESSION_MAX_AGE_MINUTES * 60_000
      : undefined,
});
const scoreWeights = new ScoreWeightStore(db.antifraud);
const networkRisk = new NetworkRiskService(db, app.log);
const discordAlerts = new DiscordAlerts(config, app.log);
const reportProviderAccessIssue = (
  issue: Parameters<typeof sendProviderAccessIssue>[2],
) => sendProviderAccessIssue(config, app.log, issue);
const maxmind = new MaxMindService(
  config,
  db.antifraud,
  app.log,
  reportProviderAccessIssue,
);
const fiatRisk = new FiatRiskService(db, maxmind);
const fiatEligibilityAccess = new FiatEligibilityAccess(config);
const enrichment = new EnrichmentService(config, reportProviderAccessIssue);
const fiatEligibility = new FiatEligibilityService(
  db,
  scoreWeights,
  enrichment,
  config.FIAT_ELIGIBILITY_GLOBALLY_ENABLED,
  config.FIAT_ELIGIBILITY_CONTAINMENT_ENABLED,
);
const sumsub =
  config.SUMSUB_ADMIN_TOKEN && config.SUMSUB_ADMIN_KEY
    ? new SumsubClient({
        token: config.SUMSUB_ADMIN_TOKEN,
        secretKey: config.SUMSUB_ADMIN_KEY,
      })
    : null;
const ingestDelivery = new IngestDelivery(
  config,
  db.antifraud,
  app.log,
);
const dashboardOpsTick = new DashboardOpsTick(config, app.log);
const fiatAccessControl = new FiatDepositAccessControl(
  db,
  new FiatDepositAccessClient(config),
  app.log,
  Boolean(
    config.ADMIN_API_KEY &&
      (config.xbypasssecret || config.XBYPASSSECRET),
  ),
);
const engine = new MonitorEngine(
  config,
  db,
  live,
  scoreWeights,
  app.log,
  (userId) => networkRisk.enqueueAccount(userId).then(() => undefined),
  fiatAccessControl,
  fiatRisk,
);
let shuttingDown = false;
let maxmindReportTimer: NodeJS.Timeout | null = null;

// Cross-replica cache invalidation: rule and score-weight mutations committed
// on OTHER replicas arrive here as live frames; drop the local caches so this
// replica converges immediately instead of waiting out its cache TTL. The
// publishing replica already invalidated locally — a second drop is harmless.
live.onFrame((type) => {
  if (type === "rule.created" || type === "rule.updated") {
    engine.invalidateRules();
  } else if (type === "score_weight.updated") {
    scoreWeights.invalidate();
  }
});

/** Lookback that bounds the resolved tail of the case list. */
const CASES_RECENT_DAYS = 30;
/** Fallback audit actor when a caller does not identify the human operator. */
const SERVICE_ACTOR_ID = "service:admin-api";
/** Hard cap on rule_definitions rows; the engine loads them all per pass. */
const RULE_LIMIT = 200;
/**
 * Create-scoped advisory lock (transaction-scoped, constant key) serializing
 * concurrent rule creates so MAX(priority)+10 cannot be computed twice.
 */
const RULE_CREATE_LOCK_KEY = "antifraud:rules:create";
/** Postgres unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = "23505";
const TOP_RAIN_CACHE_MS = 30_000;
/** Stale window served from cache when a top-rain refresh fails. */
const TOP_RAIN_STALE_ON_ERROR_MS = 30_000;
const OVERVIEW_CACHE_MS = 10_000;
/** Lookback bounding the /v1/overview blocked-IP metric. */
const BLOCKED_IP_CATCH_DAYS = 90;
/** /v1/monitors/live page bound (fetches one extra row to compute hasMore). */
const MONITORS_LIVE_LIMIT = 200;
/** Unseen-count polling window cap: reject ranges over 31 days. */
const UNSEEN_COUNT_MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;
/**
 * Per-IP floor beneath the actor-keyed ticket limiter: rotating actorIds gets
 * a fresh actor bucket per request, but never a fresh IP. Generous because
 * every admin shares the Vercel egress IP.
 */
const ticketIpFloorAllows = createFixedWindowIpLimiter(
  config.WS_TICKET_RATE_LIMIT_PER_MINUTE * 10,
  60_000,
);

function pgErrorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

/**
 * Serialize concurrent transactions that share a logical key (idempotency
 * retries, the rule-create priority computation). Transaction-scoped: the
 * lock releases automatically on COMMIT/ROLLBACK.
 */
async function takeAdvisoryTxLock(
  client: { query: (text: string, values: unknown[]) => Promise<unknown> },
  key: string,
): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
    [key],
  );
}

/**
 * Millisecond-truncated timestamp equality for optimistic-concurrency guards:
 * clients echo back ISO strings with ms precision and the pg driver parses
 * timestamps to ms-precision Dates, while the column stores microseconds.
 */
function sameTimestampMs(expectedIso: string, stored: unknown): boolean {
  return stored instanceof Date && Date.parse(expectedIso) === stored.getTime();
}

type TopRainRow = Awaited<ReturnType<typeof topRainWinners>>[number];
const cachedTopRain = createPromiseCache<string, TopRainRow[]>(
  (key) => {
    const [limit = 10, days = 365] = key.split(":").map(Number);
    return topRainWinners(db.source, limit, days);
  },
  TOP_RAIN_CACHE_MS,
  Date.now,
  { staleOnErrorMs: TOP_RAIN_STALE_ON_ERROR_MS },
);
type SignupSummary = {
  total: number;
  assessed: number;
  attention: number;
  monitoring: number;
};
const cachedSignupSummary = createPromiseCache<number, SignupSummary>(
  async (attentionScore) => {
    // Independent scalar aggregates instead of the old whole-table join with
    // an EXISTS probe per subject: assessed/attention come straight from
    // signup_assessments and "monitoring" is the count of active monitor
    // sessions, each a plain (indexed) aggregate.
    const result = await db.antifraud.query<SignupSummary>(
      `
        SELECT
          (SELECT COUNT(*) FROM subjects)::int AS total,
          (SELECT COUNT(*) FROM signup_assessments)::int AS assessed,
          (
            SELECT COUNT(*) FROM signup_assessments WHERE score >= $1
          )::int AS attention,
          (
            SELECT COUNT(*) FROM monitor_sessions WHERE status = 'active'
          )::int AS monitoring
      `,
      [attentionScore],
    );
    return result.rows[0] ?? {
      total: 0,
      assessed: 0,
      attention: 0,
      monitoring: 0,
    };
  },
  30_000,
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
  type: LiveEventType,
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
/**
 * Grace given to live websocket clients to acknowledge the 1001 close frame on
 * shutdown before they are terminated. Must stay well below the 25s shutdown
 * watchdog: ws' default close timeout (30s per client) would otherwise push a
 * redeploy past the watchdog and exit(1).
 */
const WS_SHUTDOWN_TERMINATE_MS = 3_000;
/** Lame-duck window so load balancers see /health 503 before the listener dies. */
const SHUTDOWN_DRAIN_MS = 2_000;
await app.register(websocket, {
  options: {
    maxPayload: 128 * 1024,
    perMessageDeflate: false,
  },
  // The plugin's default preClose sends a bare close() (no code → clients see
  // 1005) before any onClose hook runs, which made live.close()'s 1001 a
  // no-op. Send the going-away code here, with a bounded terminate fallback.
  preClose(done) {
    const server = app.websocketServer;
    for (const client of server.clients) {
      try {
        client.close(1001, "server_shutdown");
      } catch {
        client.terminate();
      }
    }
    const deadline = setTimeout(() => {
      for (const client of server.clients) {
        try {
          client.terminate();
        } catch {
          // The peer may already have completed teardown.
        }
      }
    }, WS_SHUTDOWN_TERMINATE_MS);
    deadline.unref();
    server.close(() => {
      clearTimeout(deadline);
      done();
    });
  },
});

app.addHook("onSend", async (request, reply, payload) => {
  reply.header("x-correlation-id", request.id);
  // Default no-store, but let routes that opted into caching (the static
  // event catalog, top-rain) keep their own Cache-Control.
  if (
    (request.url === "/health" || request.url.startsWith("/v1/")) &&
    !reply.getHeader("Cache-Control")
  ) {
    reply.header("Cache-Control", "no-store");
  }
  return payload;
});

app.addHook("onRequest", async (request, reply) => {
  const requestPathname = request.url.split("?", 1)[0];
  // Probe carve-out FIRST: platform healthchecks send no Origin but may send
  // fetch metadata, and must never be blocked by the origin gate or auth.
  // Both payloads are trimmed to status-only shapes (full detail lives on the
  // authenticated /v1/operations/* routes).
  if (
    requestPathname === "/health"
    || requestPathname === "/ready"
    || requestPathname === "/v1/providers/maxmind/alerts"
  ) {
    return;
  }
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

  const pathname = requestPathname;
  if (request.method === "GET" && pathname === "/v1/live") {
    return;
  }
  // Deliberately unauthenticated testing endpoint. It only reads public EOS
  // chain data and remains covered by the service-wide rate limiter.
  if (isUnauthenticatedEosRandomBlockRequest(request.method, pathname)) {
    return;
  }
  const authorization = request.headers.authorization ?? "";
  if (request.method === "POST" && pathname === FIAT_ELIGIBILITY_PATH) {
    const authentication = authenticateFiatEligibilityRequest(
      fiatEligibilityAccess,
      {
        authorization,
      },
    );
    if (!authentication.authorized) {
      request.log.warn(
        {
          event: "fiat_eligibility.authentication_rejected",
          requestId: request.id,
          reason: authentication.error,
          statusCode: authentication.status,
        },
        "Fiat eligibility request rejected by pre-authentication",
      );
      return reply
        .code(authentication.status)
        .send({ error: authentication.error });
    }
    return;
  }
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";
  if (!serviceRequestAuthorized(request.method, pathname ?? "", token, config)) {
    return reply.code(401).send({ error: "unauthorized" });
  }
});

// Probe routes are unauthenticated (see the onRequest carve-out), so their
// payloads stay trimmed to status shapes — internal poller/webapp detail is
// served by the authenticated /v1/operations/* routes instead. They are also
// exempt from the global rate limiter: a platform probing aggressively (or
// sharing an IP with a noisy client) must never be banned away from its own
// healthcheck.
app.get("/health", {
  config: { rateLimit: false },
}, async (_request, reply) => {
  // Lame-duck: a draining process must fail its checks immediately so the
  // platform stops routing to it before the listener closes.
  if (shuttingDown) {
    return reply.code(503).send({ status: "draining" });
  }
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
  };
  // A wedged engine must fail the platform healthcheck so the process is
  // restarted instead of serving a permanently silent monitor.
  if (stalledForMs !== null) return reply.code(503).send(body);
  return body;
});
/**
 * `/ready` is unauthenticated (probes must stay so) but it is the only probe
 * that touches the databases: `assertDatabaseConnections` issues `SELECT 1` on
 * three pools. Left unmetered, any anonymous caller could turn one HTTP request
 * into three DB round-trips at unlimited rate and starve the poller out of the
 * pools — while the resulting 503 is exactly the signal that tells the platform
 * to restart us. Two brakes: a never-banning per-IP limiter (the platform probe
 * must never be banned away from its own healthcheck) and a ~1s memo of the
 * probe result so a burst collapses onto a single set of queries.
 */
const READY_DB_PROBE_TTL_MS = 1_000;
let readyDbProbe: { at: number; ok: boolean } | null = null;

async function readyDatabasesOk(): Promise<boolean> {
  const now = Date.now();
  if (readyDbProbe && now - readyDbProbe.at < READY_DB_PROBE_TTL_MS) {
    return readyDbProbe.ok;
  }
  let ok: boolean;
  try {
    await assertDatabaseConnections(db);
    ok = true;
  } catch {
    ok = false;
  }
  readyDbProbe = { at: Date.now(), ok };
  return ok;
}

app.get("/ready", {
  config: {
    rateLimit: {
      max: 60,
      timeWindow: "1 minute",
      ban: -1,
    },
  },
}, async (_request, reply) => {
  if (shuttingDown) {
    return reply.code(503).send({ status: "draining", reason: "draining" });
  }
  if (!(await readyDatabasesOk())) {
    return reply
      .code(503)
      .send({ status: "not_ready", reason: "database_unavailable" });
  }
  const poller = engine.healthSnapshot();
  const liveStatus = live.stats();
  const webappMonitor = dashboardOpsTick.status();
  // Readiness gates only on HARD poller faults: no successful tick yet,
  // repeated tick failures, or a stale tick. The snapshot also reports
  // "degraded" for pending signup dead-letters awaiting STAFF review —
  // an operator queue item, not an infrastructure fault; a service that
  // ticks cleanly must stay ready while one sits in the queue.
  const lastTickMs = poller.lastSuccessfulTickAt
    ? Date.parse(poller.lastSuccessfulTickAt)
    : Number.NaN;
  const pollerStale =
    !Number.isFinite(lastTickMs) || Date.now() - lastTickMs > 5 * 60_000;
  const pollerBroken =
    poller.status === "starting" ||
    poller.consecutiveFailures > 0 ||
    (poller.status === "degraded" && pollerStale);
  // Readiness gates ONLY on this service's own hard dependencies. The webapp
  // monitor deliberately does NOT gate: it probes an external Vercel app, so
  // letting it 503 us would convert a dashboard outage into a fraud-ingestion
  // outage — and the alert for that outage routes through the same webapp, so
  // it would silence its own alarm. It stays reported, never gating.
  const reason = pollerBroken
    ? `poller_${poller.status}`
    : !liveStatus.subscribed
      ? "live_unsubscribed"
      : null;
  if (reason !== null) {
    return reply
      .code(503)
      .send({ status: "not_ready", reason, webappMonitor: webappMonitor.status });
  }
  return { status: "ready", webappMonitor: webappMonitor.status };
});

app.get("/v1/operations/poller", async () => ({
  data: engine.healthSnapshot(),
}));

/** Live transport observability: clients, per-actor counts, outbox depth. */
app.get("/v1/operations/live", async () => ({
  data: live.stats(),
}));

/**
 * Dashboard-delivery observability: queue age and pending counts, attempt and
 * failure counters, last successful delivery, containment backlog, and the
 * retry backoff. Until this route existed those counters were written and
 * never read, so a delivery outage — including containment commands aging out
 * unsent — was visible only to whoever was tailing the logs.
 *
 * Authentication is the same gate every other /v1/operations/* read uses: the
 * global onRequest hook rejects anything without a valid bearer token, and
 * this path is not in the probe carve-out. It stays off the admin-only list in
 * auth.ts alongside /v1/operations/poller because, like the poller snapshot,
 * the payload is counts and timestamps only — no user ids, addresses,
 * fingerprints, connection strings or secrets.
 */
app.get("/v1/operations/delivery", async () => ({
  data: await ingestDelivery.snapshot(),
}));

/**
 * Authoritative deployed configuration for admin status surfaces. This is
 * intentionally presence-only except for recipient ids compiled into this
 * service; URLs, tokens, provider keys and webhook secrets never leave Railway.
 */
app.get("/v1/operations/config", async () => ({
  data: sanitizedRuntimeConfig(config, allowedOrigins.size),
}));

const fiatAccessControlBody = z.object({
  enabled: z.boolean(),
  actorId: z.string().trim().min(1).max(200),
});

app.get("/v1/fiat-deposit-access/config", async () => ({
  data: await fiatAccessControl.status(),
}));

app.put("/v1/fiat-deposit-access/config/existing-accounts", async (request) => {
  const input = fiatAccessControlBody.parse(request.body);
  return {
    data: await fiatAccessControl.setExistingAccounts(
      input.enabled,
      input.actorId,
    ),
  };
});

app.put("/v1/fiat-deposit-access/config/new-signups", async (request) => {
  const input = fiatAccessControlBody.parse(request.body);
  return {
    data: await fiatAccessControl.setNewSignups(input.enabled, input.actorId),
  };
});

app.get("/v1/operations/notifications", async () => ({
  data: {
    routes: notificationRouteStatuses(config),
  },
}));

app.get("/v1/monitors/live", async () => {
  const [result, totals] = await Promise.all([
    db.antifraud.query(
      `
        SELECT
          ms.id AS session_id, ms.case_id, ms.user_id, s.username,
          ms.started_at, ms.ends_at,
          LEAST(100, GREATEST(0, ms.current_score))::int AS current_score,
          LEAST(100, GREATEST(0, ms.peak_score))::int AS peak_score,
          ms.event_count, c.severity,
          -- Signal projection: the console only reads each signal's key plus
          -- payload.type / payload.detectionTypes on proxycheck_anonymous;
          -- shipping full provider payloads ballooned this hot response.
          (
            SELECT COALESCE(
              (
                SELECT jsonb_agg(
                  jsonb_strip_nulls(jsonb_build_object(
                    'key', sig->>'key',
                    'payload',
                    CASE WHEN sig->>'key' = 'proxycheck_anonymous'
                      THEN jsonb_strip_nulls(jsonb_build_object(
                        'type', sig#>'{payload,type}',
                        'detectionTypes', sig#>'{payload,detectionTypes}'
                      ))
                    END
                  ))
                )
                FROM jsonb_array_elements(pc.signals) AS sig
              ),
              '[]'::jsonb
            )
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
        LIMIT ${MONITORS_LIVE_LIMIT + 1}
      `,
    ),
    db.antifraud.query<{ active_total: number }>(
      `SELECT COUNT(*)::int AS active_total
         FROM monitor_sessions
        WHERE status = 'active'`,
    ),
  ]);
  return {
    data: result.rows.slice(0, MONITORS_LIVE_LIMIT),
    activeTotal: totals.rows[0]?.active_total ?? 0,
    hasMore: result.rows.length > MONITORS_LIVE_LIMIT,
  };
});

/**
 * Bounded data used by the Fraud Dashboard and Live Events surfaces.
 *
 * This endpoint intentionally owns only Antifraud-DB facts. MAIN-derived
 * signup, lock and payment totals stay on the dashboard's read-only mirror so
 * the two database boundaries remain explicit and independently degradable.
 */
type OverviewPayload = {
  data: Record<string, unknown>;
};
/**
 * Keyed on the serialized ignore list so the cache stays shared for identical
 * scopes instead of leaking one caller's exclusions into another's numbers.
 */
const cachedOverview = createPromiseCache<string, OverviewPayload>(
  (key) => loadOverview(JSON.parse(key) as string[]),
  OVERVIEW_CACHE_MS,
);

async function loadOverview(
  ignoredFiatUsers: string[],
): Promise<OverviewPayload> {
  const [reviewCounts, blacklistCounts, recentSessions, fiatFraud] =
    await Promise.allSettled([
    db.antifraud.query<{
      signup_reviews_left: number;
      fiat_reviews_left: number;
    }>(
      `
        SELECT
          (
            -- The join is 1:1 (signup_assessments is keyed by user_id and
            -- cases.id is the outer PK), so no DISTINCT de-dup pass is needed.
            SELECT COUNT(*)::int
            FROM cases c
            JOIN signup_assessments sa ON sa.user_id = c.user_id
            WHERE c.status IN ('open','monitoring','in_review','escalated')
          ) AS signup_reviews_left,
          (
            SELECT COUNT(*)::int
            FROM fiat_deposit_assessments
            WHERE verdict IN ('review','bad')
              AND review_status IN (
                'unreviewed','in_review','escalated','hold_recommended'
              )
          ) AS fiat_reviews_left
      `,
    ),
    db.antifraud.query<{
      active_domains: number;
      blocked_ip_catches: number;
    }>(
      `
        SELECT
          (
            SELECT COUNT(*)::int
            FROM fiat_email_domain_blacklist
            WHERE enabled
              AND (expires_at IS NULL OR expires_at > now())
          ) AS active_domains,
          (
            SELECT COUNT(DISTINCT history.user_id)::int
            FROM profile_assessment_signals signal
            JOIN profile_assessment_history history
              ON history.id = signal.assessment_id
            WHERE signal.hard_policy = 'blocklist.ip'
              AND history.assessed_at >=
                now() - (${BLOCKED_IP_CATCH_DAYS} * interval '1 day')
          ) AS blocked_ip_catches
      `,
    ),
    db.antifraud.query(
      `
        SELECT
          ms.id AS session_id,
          ms.case_id,
          ms.user_id,
          s.username,
          ms.status,
          ms.started_at,
          ms.ends_at,
          ms.ended_at,
          LEAST(100, GREATEST(0, ms.current_score))::int AS current_score,
          LEAST(100, GREATEST(0, ms.peak_score))::int AS peak_score,
          ms.event_count,
          c.status AS case_status,
          c.severity
        FROM monitor_sessions ms
        JOIN cases c ON c.id = ms.case_id
        JOIN subjects s ON s.user_id = ms.user_id
        WHERE ms.started_at >= now() - interval '30 days'
        ORDER BY ms.started_at DESC, ms.id DESC
        LIMIT 40
      `,
    ),
    db.antifraud.query<{
      legitimate_lifetime_cents: number;
      fraudulent_lifetime_cents: number;
      legitimate_last_24_hours_cents: number;
      fraudulent_last_24_hours_cents: number;
      refunded_lifetime_cents: number;
      fraudulent_refunded_lifetime_cents: number;
      days: Array<{
        date: string;
        legitimateCents: number;
        fraudulentCents: number;
      }>;
    }>(
      `
        WITH scoped_rollups AS (
          SELECT
            bucket_date,
            verdict = 'bad' AS is_fraud,
            status IN ('refunded', 'partially_refunded') AS is_refunded,
            credited_amount_usd AS amount_usd
          FROM fiat_deposit_dashboard_rollups
          WHERE status = ANY($1::text[])
            AND user_id <> ALL($2::text[])
        ),
        daily AS (
          SELECT
            bucket_date AS bucket,
            COALESCE(
              ROUND(SUM(amount_usd) FILTER (
                WHERE NOT is_fraud AND NOT is_refunded
              ) * 100),
              0
            )::float8 AS legitimate_cents,
            COALESCE(
              ROUND(SUM(amount_usd) FILTER (
                WHERE is_fraud AND NOT is_refunded
              ) * 100),
              0
            )::float8 AS fraudulent_cents
          FROM scoped_rollups
          WHERE bucket_date >=
              (now() AT TIME ZONE 'UTC')::date - 29
            AND bucket_date <= (now() AT TIME ZONE 'UTC')::date
          GROUP BY 1
          ORDER BY 1
        ),
        lifetime AS (
          SELECT
            COALESCE(ROUND(SUM(amount_usd) FILTER (
              WHERE NOT is_fraud AND NOT is_refunded
            ) * 100), 0)::float8 AS legitimate_cents,
            COALESCE(ROUND(SUM(amount_usd) FILTER (
              WHERE is_fraud AND NOT is_refunded
            ) * 100), 0)::float8 AS fraudulent_cents,
            COALESCE(ROUND(SUM(amount_usd) FILTER (
              WHERE is_refunded
            ) * 100), 0)::float8 AS refunded_cents,
            COALESCE(ROUND(SUM(amount_usd) FILTER (
              WHERE is_refunded AND is_fraud
            ) * 100), 0)::float8 AS fraudulent_refunded_cents
          FROM scoped_rollups
        ),
        recent AS (
          -- The rollup is day-granular. Keep the rolling 24-hour slice exact
          -- with one bounded index-range scan over the canonical table.
          SELECT
            verdict = 'bad' AS is_fraud,
            status IN ('refunded', 'partially_refunded') AS is_refunded,
            credited_amount_usd AS amount_usd
          FROM fiat_deposit_assessments
          WHERE status = ANY($1::text[])
            AND user_id <> ALL($2::text[])
            AND occurred_at >= now() - interval '24 hours'
            AND occurred_at < now()
        )
        SELECT
          lifetime.legitimate_cents AS legitimate_lifetime_cents,
          lifetime.fraudulent_cents AS fraudulent_lifetime_cents,
          COALESCE((SELECT ROUND(SUM(amount_usd) FILTER (
            WHERE NOT is_fraud AND NOT is_refunded
          ) * 100)::float8 FROM recent), 0) AS legitimate_last_24_hours_cents,
          COALESCE((SELECT ROUND(SUM(amount_usd) FILTER (
            WHERE is_fraud AND NOT is_refunded
          ) * 100)::float8 FROM recent), 0) AS fraudulent_last_24_hours_cents,
          lifetime.refunded_cents AS refunded_lifetime_cents,
          lifetime.fraudulent_refunded_cents
            AS fraudulent_refunded_lifetime_cents,
          COALESCE((
            SELECT json_agg(json_build_object(
              'date', bucket::text,
              'legitimateCents', legitimate_cents,
              'fraudulentCents', fraudulent_cents
            ) ORDER BY bucket)
            FROM daily
          ), '[]'::json)::json AS days
        FROM lifetime
      `,
      [FIAT_ASSESSMENT_STATUSES, ignoredFiatUsers],
    ),
  ]);

  // Per-section degradation: one failed aggregate nulls its own fields (and
  // is listed under `degraded`) instead of turning the whole overview into a
  // 500. Field names are unchanged; failed sections carry null values.
  const degraded: Record<string, true> = {};
  const section = <T>(
    name: string,
    settled: PromiseSettledResult<{ rows: T[] }>,
  ): T[] | null => {
    if (settled.status === "fulfilled") return settled.value.rows;
    degraded[name] = true;
    app.log.error(
      { err: settled.reason, section: name },
      "Antifraud overview section failed",
    );
    return null;
  };
  const reviewRows = section("reviews", reviewCounts);
  const blacklistRows = section("blacklists", blacklistCounts);
  const sessionRows = section("recentSessions", recentSessions);
  const fiatRows = section("fiat", fiatFraud);
  const reviews = reviewRows?.[0];
  const blacklists = blacklistRows?.[0];
  const fiat = fiatRows?.[0];
  return {
    data: {
      signupReviewsLeft: reviewRows
        ? reviews?.signup_reviews_left ?? 0
        : null,
      fiatReviewsLeft: reviewRows ? reviews?.fiat_reviews_left ?? 0 : null,
      activeDomainBlacklist: blacklistRows
        ? blacklists?.active_domains ?? 0
        : null,
      blockedIpCatches: blacklistRows
        ? blacklists?.blocked_ip_catches ?? 0
        : null,
      recentSessions: sessionRows,
      fiat: fiatRows
        ? {
          legitimateLifetimeCents: fiat?.legitimate_lifetime_cents ?? 0,
          fraudulentLifetimeCents: fiat?.fraudulent_lifetime_cents ?? 0,
          legitimateLast24HoursCents:
            fiat?.legitimate_last_24_hours_cents ?? 0,
          fraudulentLast24HoursCents:
            fiat?.fraudulent_last_24_hours_cents ?? 0,
          refundedLifetimeCents: fiat?.refunded_lifetime_cents ?? 0,
          fraudulentRefundedLifetimeCents:
            fiat?.fraudulent_refunded_lifetime_cents ?? 0,
          days: fiat?.days ?? [],
        }
        : null,
      /** Kept for dashboard builds deployed before the two-leg fiat split. */
      fraudulentFiat: fiatRows
        ? {
          lifetimeCents: fiat?.fraudulent_lifetime_cents ?? 0,
          last24HoursCents: fiat?.fraudulent_last_24_hours_cents ?? 0,
          days: (fiat?.days ?? []).map((day) => ({
            date: day.date,
            amountCents: day.fraudulentCents,
          })),
        }
        : null,
      ...(Object.keys(degraded).length > 0 ? { degraded } : {}),
    },
  };
}

app.get("/v1/overview", async (request) => {
  // The dashboard KPI has to reconcile with /v1/fiat-deposits, so the fiat
  // split uses that route's scope: settled-or-paid assessments only, refunds
  // kept out of both legs, creators and excluded users ignored. The refunded
  // money is now reported on its own leg instead of vanishing, so the KPI can
  // say how much of the fraud volume was already given back. A partially
  // refunded row counts at its full credited value because the assessment
  // stores no partial refund amount; there are none in production today.
  const ignoredFiatUsers = [
    ...new Set([
      ...(request.headers["x-antifraud-excluded-users"] === undefined
        ? []
        : excludedUserIds(request.headers)),
      ...(await cachedCreatorUserIds(db.source)),
    ]),
  ].sort();
  return cachedOverview(JSON.stringify(ignoredFiatUsers));
});

app.get("/v1/signups", async (request) => {
  const query = z.object({
    page: z.coerce.number().int().min(1).max(1_000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }).parse(request.query);
  const offset = (query.page - 1) * query.limit;
  const [rowsSettled, summarySettled] = await Promise.allSettled([
    db.antifraud.query(
      `
        -- Page-then-join: resolve the page of subjects FIRST (bounded
        -- ORDER BY/LIMIT/OFFSET over one table), then run the lateral
        -- provider/case probes against only those rows instead of the whole
        -- subjects table.
        WITH page AS (
          SELECT
            user_id, username, email, avatar_url, signup_ip::text AS signup_ip,
            country, country_code, state, city, affiliate_code,
            referred_by, source_created_at
          FROM subjects
          ORDER BY source_created_at DESC, user_id DESC
          LIMIT $1 OFFSET $2
        )
        SELECT
          s.user_id, s.username, s.email, s.avatar_url, s.signup_ip,
          s.country, s.country_code, s.state, s.city, s.affiliate_code,
          s.referred_by, s.source_created_at,
          LEAST(100, GREATEST(0, COALESCE(sa.score, 0)))::int AS score,
          COALESCE(sa.severity, 'low') AS severity,
          COALESCE(sa.signals, '[]'::jsonb) AS signals,
          sa.assessed_at,
          fingerprint.status AS fingerprint_status,
          fingerprint.score AS fingerprint_score,
          COALESCE(fingerprint.signals, '[]'::jsonb) AS fingerprint_signals,
          proxycheck.status AS proxycheck_status,
          proxycheck.score AS proxycheck_score,
          COALESCE(proxycheck.signals, '[]'::jsonb) AS proxycheck_signals,
          abstract_ip.status AS abstract_ip_status,
          abstract_ip.score AS abstract_ip_score,
          COALESCE(abstract_ip.signals, '[]'::jsonb) AS abstract_ip_signals,
          abstract_email.status AS abstract_email_status,
          abstract_email.score AS abstract_email_score,
          COALESCE(abstract_email.signals, '[]'::jsonb)
            AS abstract_email_signals,
          latest_case.id AS case_id,
          latest_case.status AS case_status,
          latest_case.severity AS case_severity,
          latest_monitor.status AS monitor_status,
          latest_monitor.ends_at AS monitor_ends_at
        FROM page s
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
          SELECT status, score::float8 AS score, signals
          FROM provider_checks
          WHERE user_id = s.user_id AND provider = 'abstract_ip'
          ORDER BY checked_at DESC
          LIMIT 1
        ) abstract_ip ON true
        LEFT JOIN LATERAL (
          SELECT status, score::float8 AS score, signals
          FROM provider_checks
          WHERE user_id = s.user_id AND provider = 'abstract_email'
          ORDER BY checked_at DESC
          LIMIT 1
        ) abstract_email ON true
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
      `,
      [query.limit, offset],
    ),
    cachedSignupSummary(config.MONITOR_START_SCORE),
  ]);
  // The page itself is the route's contract — a failure there still 500s.
  // The summary is decoration: degrade it to null instead of failing the list.
  if (rowsSettled.status === "rejected") throw rowsSettled.reason;
  const rows = rowsSettled.value.rows;
  const summary =
    summarySettled.status === "fulfilled" ? summarySettled.value : null;
  if (summarySettled.status === "rejected") {
    request.log.error(
      { err: summarySettled.reason },
      "Antifraud signup summary failed; serving the page without it",
    );
  }
  // Without the summary the true total is unknown; a lower bound derived from
  // the page keeps the pagination fields present and numerically sane.
  const total = summary ? summary.total : offset + rows.length;
  return {
    data: rows,
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      pages: Math.max(
        1,
        Math.ceil(total / query.limit),
      ),
    },
    summary,
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
    .refine(
      ({ since, until }) =>
        Date.parse(until) - Date.parse(since) <= UNSEEN_COUNT_MAX_WINDOW_MS,
      { message: "window must not exceed 31 days" },
    )
    .parse(request.query);
  // first_seen_at is the INGESTION clock: a subject ingested late (e.g. after
  // a poller recovery) still counts as newly seen, whereas filtering on
  // source_created_at silently loses it forever. The LIMIT inside the
  // subselect bounds the count work itself — the badge caps at 100 anyway.
  const result = await db.antifraud.query<{ count: number }>(
    `
      SELECT COUNT(*)::int AS count
      FROM (
        SELECT 1
        FROM subjects
        WHERE first_seen_at > $1::timestamptz
          AND first_seen_at <= $2::timestamptz
        LIMIT 100
      ) bounded
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
      "resolved",
    ]).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }).parse(request.query);
  // `cases` grows one row per monitored signup and is never pruned, so the list
  // is always bounded: live cases plus anything touched in the recent window.
  // The ordering matches the cases_severity_rank_updated_idx expression index.
  const values: unknown[] = [CASES_RECENT_DAYS];
  const conditions = [
    `(c.status <> 'resolved' OR c.updated_at >= now() - ($1 * interval '1 day'))`,
  ];
  if (query.status) {
    if (query.status === "in_review") {
      conditions.push(`c.status IN ('in_review','escalated')`);
    } else {
      values.push(query.status);
      conditions.push(`c.status = $${values.length}`);
    }
  }
  values.push(query.limit + 1);
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
        c.updated_at DESC,
        c.id DESC
      LIMIT $${values.length}
    `,
    values,
  );
  return {
    data: result.rows.slice(0, query.limit).map((row) => ({
      ...row,
      score: clampRiskScore(Number(row.score)),
      peak_score: clampRiskScore(Number(row.peak_score)),
      status: row.status === "escalated" ? "in_review" : row.status,
    })),
    pagination: {
      limit: query.limit,
      hasMore: result.rows.length > query.limit,
    },
  };
});

app.get("/v1/cases/:id", async (request, reply) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
  // Existence first: an unknown id 404s after ONE query instead of paying for
  // the six evidence queries below.
  const caseResult = await db.antifraud.query(
    `
      SELECT
        c.id, c.user_id, c.status, c.severity,
        LEAST(100, GREATEST(0, c.score))::int AS score,
        LEAST(100, GREATEST(0, c.peak_score))::int AS peak_score,
        c.summary, c.assigned_to, c.resolution, c.opened_at, c.updated_at,
        c.resolved_at, c.subject_type, c.network_key, c.network_snapshot_id,
        s.username, s.email, s.signup_ip::text,
        s.country_code, s.state, s.city, s.source_created_at
      FROM cases c JOIN subjects s ON s.user_id = c.user_id
      WHERE c.id = $1
    `,
    [id],
  );
  if (!caseResult.rows[0]) return reply.code(404).send({ error: "not_found" });
  // Fan-out is capped at 4 concurrent connections per request. The antifraud
  // pool is shared with the poller and the outbox drains; a single request
  // that grabbed 7 slots meant two staff opening cases at once could push the
  // poller past connectionTimeoutMillis and degrade ingestion.
  const [events, checks, sessions, actions] = await Promise.all([
    db.antifraud.query(
      `SELECT id, case_id, session_id, user_id, event_type, source, source_ref,
              score_delta,
              LEAST(100, GREATEST(0, score_after))::int AS score_after,
              title, detail, occurred_at, recorded_at
         FROM risk_events
        WHERE case_id=$1
          AND event_type <> ALL($2::text[])
        ORDER BY occurred_at, recorded_at
        LIMIT 500`,
      [id, [...NON_ACTIONABLE_REWARD_ENROLLMENT_EVENTS]],
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
              LEAST(100, GREATEST(0, initial_score))::int AS initial_score,
              LEAST(100, GREATEST(0, current_score))::int AS current_score,
              LEAST(100, GREATEST(0, peak_score))::int AS peak_score,
              event_count
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
  // Second wave: members and its total collapse into ONE query via
  // COUNT(*) OVER (), so the whole route now peaks at 4 connections.
  const [members, matches] = await Promise.all([
    db.antifraud.query<{
      user_id: string;
      is_root: boolean;
      username: string | null;
      avatar_url: string | null;
      members_total: number;
    }>(
      `SELECT ncm.user_id, ncm.is_root, s.username, s.avatar_url,
              (COUNT(*) OVER ())::int AS members_total
         FROM network_case_members ncm
         LEFT JOIN subjects s ON s.user_id=ncm.user_id
        WHERE ncm.case_id=$1
        ORDER BY ncm.is_root DESC, COALESCE(s.username, ncm.user_id)
        LIMIT 101`,
      [id],
    ),
    db.antifraud.query(
      `SELECT
          rm.id, rm.session_id, rd.key AS rule_key,
          COALESCE(rm.evidence->>'ruleName', rd.name) AS rule_name,
          COALESCE((rm.evidence->>'scoreDelta')::int, rd.score_delta) AS score_delta,
          'manual_review'::text AS action_type,
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
  return {
    data: {
      case: {
        ...caseResult.rows[0],
        status:
          caseResult.rows[0].status === "escalated"
            ? "in_review"
            : caseResult.rows[0].status,
      },
      events: events.rows,
      providerChecks: checks.rows,
      sessions: sessions.rows,
      actions: actions.rows,
      // `members_total` is the windowed count carried on every row; it is
      // stripped here so the wire shape stays byte-identical to the two-query
      // version that preceded it.
      members: members.rows
        .slice(0, 100)
        .map(({ members_total: _total, ...member }) => member),
      membersTotal: members.rows[0]?.members_total ?? 0,
      matches: matches.rows,
    },
  };
});

// The event catalog is compiled into the binary and cannot change without a
// deploy: precompute the body and a strong ETag once, serve 304s on match and
// allow shared caching for five minutes.
const MONITOR_EVENTS_BODY = JSON.stringify({ data: MONITOR_EVENT_CATALOG });
const MONITOR_EVENTS_ETAG = `"${createHash("sha256")
  .update(MONITOR_EVENTS_BODY)
  .digest("base64url")}"`;
app.get("/v1/events", async (request, reply) => {
  reply.header("Cache-Control", "public, max-age=300");
  reply.header("ETag", MONITOR_EVENTS_ETAG);
  if (request.headers["if-none-match"] === MONITOR_EVENTS_ETAG) {
    return reply.code(304).send();
  }
  return reply.type("application/json; charset=utf-8").send(MONITOR_EVENTS_BODY);
});

app.get("/v1/rules", async () => {
  const result = await db.antifraud.query(
    "SELECT * FROM rule_definitions ORDER BY priority, name",
  );
  return {
    data: result.rows.map((row) => ({
      ...row,
      action_type: "manual_review",
    })),
  };
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
  if (!body.actorId) {
    request.log.warn(
      { route: "POST /v1/rules" },
      "Mutation without actorId; audit falls back to the service actor",
    );
  }
  const {
    idempotencyKey: _idempotencyKey,
    actorId: _actorId,
    actorUsername: _actorUsername,
    ...changes
  } = body;
  const requestIdentity = { actorId, actorUsername, changes };
  /**
   * Idempotent-replay resolution shared by the pre-insert check and the 23505
   * recovery path. Replays return the rule's CURRENT state (the creation-time
   * snapshot in after_state can be stale after later edits) and 404 when the
   * rule was deleted since.
   */
  const resolveReplay = async (queryable: {
    query: typeof db.antifraud.query;
  }): Promise<
    | { kind: "none" }
    | { kind: "conflict" }
    | { kind: "gone" }
    | { kind: "replay"; rule: Record<string, unknown> }
  > => {
    const duplicate = await queryable.query<{
      action: string;
      actor_id: string;
      actor_username: string | null;
      target_id: string;
      request_state: unknown;
      after_state: Record<string, unknown> | null;
    }>(
      `SELECT action, actor_id, actor_username, target_id, request_state,
              after_state
         FROM service_audit_events
        WHERE idempotency_key=$1`,
      [body.idempotencyKey],
    );
    const existing = duplicate.rows[0];
    if (!existing) return { kind: "none" };
    if (
      existing.action !== "rule.create" ||
      existing.actor_id !== actorId ||
      existing.actor_username !== actorUsername ||
      !isDeepStrictEqual(existing.request_state, requestIdentity) ||
      !existing.after_state
    ) {
      return { kind: "conflict" };
    }
    const current = await queryable.query(
      "SELECT * FROM rule_definitions WHERE id=$1",
      [existing.target_id],
    );
    const rule = current.rows[0] as Record<string, unknown> | undefined;
    return rule ? { kind: "replay", rule } : { kind: "gone" };
  };

  const client = await db.antifraud.connect();
  let created: Record<string, unknown>;
  try {
    await client.query("BEGIN");
    // Serialize concurrent retries of the SAME idempotency key: without this
    // both miss the SELECT and one dies on the unique index as a 500.
    await takeAdvisoryTxLock(client, body.idempotencyKey);
    const replay = await resolveReplay(client);
    if (replay.kind !== "none") {
      await client.query("COMMIT");
      if (replay.kind === "conflict") {
        return reply.code(409).send({ error: "idempotency_conflict" });
      }
      if (replay.kind === "gone") {
        return reply.code(404).send({ error: "not_found" });
      }
      return { data: replay.rule, idempotent: true };
    }
    // Create-scoped lock: serializes the rule count, the duplicate probe and
    // MAX(priority)+10 across concurrent creates.
    await takeAdvisoryTxLock(client, RULE_CREATE_LOCK_KEY);
    const ruleCount = await client.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM rule_definitions",
    );
    if ((ruleCount.rows[0]?.count ?? 0) >= RULE_LIMIT) {
      await client.query("ROLLBACK");
      return reply.code(409).send({ error: "rule_limit_reached" });
    }
    const duplicateRule = await client.query<{ id: string }>(
      `SELECT id
         FROM rule_definitions
        WHERE sequence = $1::jsonb
          AND exclude_before = $2::jsonb
          AND window_seconds = $3
        LIMIT 1`,
      [
        JSON.stringify(body.sequence),
        JSON.stringify(body.excludeBefore),
        body.windowSeconds,
      ],
    );
    if (duplicateRule.rows[0]) {
      await client.query("ROLLBACK");
      return reply.code(409).send({
        error: "duplicate_rule",
        existingId: duplicateRule.rows[0].id,
      });
    }
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
  } catch (error) {
    // Swallow the ROLLBACK's own failure so the ORIGINAL error propagates.
    await client.query("ROLLBACK").catch(() => undefined);
    // A same-key commit raced past the lock: resolve it as the replay it is.
    if (pgErrorCode(error) === UNIQUE_VIOLATION) {
      const replay = await resolveReplay(db.antifraud);
      if (replay.kind === "replay") {
        return { data: replay.rule, idempotent: true };
      }
      if (replay.kind === "gone") {
        return reply.code(404).send({ error: "not_found" });
      }
      return reply.code(409).send({ error: "idempotency_conflict" });
    }
    throw error;
  } finally {
    client.release();
  }
  engine.invalidateRules();
  await publishCommittedMutation("rule.created", { rule: created });
  return { data: created, idempotent: false };
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
  if (!body.actorId) {
    request.log.warn(
      { route: "PUT /v1/rules/:id", ruleId: id },
      "Mutation without actorId; audit falls back to the service actor",
    );
  }
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
  /** Replay resolution shared by the pre-check and the 23505 recovery path. */
  const resolveReplay = async (queryable: {
    query: typeof db.antifraud.query;
  }): Promise<
    | { kind: "none" }
    | { kind: "conflict" }
    | { kind: "gone" }
    | { kind: "replay"; rule: Record<string, unknown> }
  > => {
    const duplicate = await queryable.query<StoredRuleUpdateIdentity>(
      `SELECT action, target_id, actor_id, actor_username, request_state
         FROM service_audit_events
        WHERE idempotency_key=$1`,
      [body.idempotencyKey],
    );
    const existing = duplicate.rows[0];
    if (!existing) return { kind: "none" };
    if (!sameRuleUpdateIdentity(existing, requestIdentity)) {
      return { kind: "conflict" };
    }
    const current = await queryable.query(
      "SELECT * FROM rule_definitions WHERE id=$1",
      [id],
    );
    const rule = current.rows[0] as Record<string, unknown> | undefined;
    return rule ? { kind: "replay", rule } : { kind: "gone" };
  };

  const client = await db.antifraud.connect();
  let updated: Record<string, unknown>;
  try {
    await client.query("BEGIN");
    // Serialize concurrent retries of the SAME idempotency key (see POST).
    await takeAdvisoryTxLock(client, body.idempotencyKey);
    const replay = await resolveReplay(client);
    if (replay.kind !== "none") {
      await client.query("COMMIT");
      if (replay.kind === "conflict") {
        return reply.code(409).send({ error: "idempotency_conflict" });
      }
      if (replay.kind === "gone") {
        return reply.code(404).send({ error: "not_found" });
      }
      return { data: replay.rule, idempotent: true };
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
    // Optimistic concurrency: with the row lock held, the stored updated_at is
    // authoritative — a mismatch means someone saved after the caller loaded.
    if (
      body.expectedUpdatedAt !== undefined &&
      !sameTimestampMs(body.expectedUpdatedAt, currentRule.updated_at)
    ) {
      await client.query("ROLLBACK");
      return reply.code(409).send({
        error: "stale_rule",
        currentUpdatedAt:
          currentRule.updated_at instanceof Date
            ? currentRule.updated_at.toISOString()
            : null,
      });
    }
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
    // Swallow the ROLLBACK's own failure so the ORIGINAL error propagates.
    await client.query("ROLLBACK").catch(() => undefined);
    // A same-key commit raced past the lock: resolve it as the replay it is.
    if (pgErrorCode(error) === UNIQUE_VIOLATION) {
      const replay = await resolveReplay(db.antifraud);
      if (replay.kind === "replay") {
        return { data: replay.rule, idempotent: true };
      }
      if (replay.kind === "gone") {
        return reply.code(404).send({ error: "not_found" });
      }
      return reply.code(409).send({ error: "idempotency_conflict" });
    }
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
  const actorId = body.actorId ?? SERVICE_ACTOR_ID;
  const actorUsername = body.actorUsername ?? null;
  if (!body.actorId) {
    request.log.warn(
      { route: "POST /v1/cases/:id/decision", caseId: id },
      "Mutation without actorId; audit falls back to the service actor",
    );
  }
  const decisionIdentity = {
    caseId: id,
    decision: body.decision,
    actorId,
    actorUsername,
    reason: body.reason,
  };
  /** Replay resolution shared by both in-lock checks and 23505 recovery. */
  const resolveReplay = async (queryable: {
    query: typeof db.antifraud.query;
  }): Promise<"none" | "replay" | "conflict"> => {
    const duplicate = await queryable.query<StoredDecisionIdentity>(
      `SELECT case_id, action_type, actor_id, actor_username, reason
         FROM staff_actions
        WHERE idempotency_key=$1`,
      [body.idempotencyKey],
    );
    const existing = duplicate.rows[0];
    if (!existing) return "none";
    return sameDecisionIdentity(existing, decisionIdentity)
      ? "replay"
      : "conflict";
  };
  const client = await db.antifraud.connect();
  let userId: string;
  try {
    await client.query("BEGIN");
    // Serialize concurrent retries of the SAME idempotency key (see rules).
    await takeAdvisoryTxLock(client, body.idempotencyKey);
    const early = await resolveReplay(client);
    if (early !== "none") {
      await client.query("COMMIT");
      return early === "replay"
        ? { success: true, idempotent: true }
        : reply.code(409).send({ error: "idempotency_conflict" });
    }
    const current = await client.query<{
      user_id: string;
      status: string;
      resolution: string | null;
    }>(
      "SELECT user_id, status, resolution FROM cases WHERE id=$1 FOR UPDATE",
      [id],
    );
    const row = current.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return reply.code(404).send({ error: "not_found" });
    }
    // Re-run the idempotency lookup INSIDE the row lock: a concurrent retry
    // that committed between the early check and the FOR UPDATE must replay
    // idempotently — the status check below would misreport the caller's own
    // completed decision as a 409 case_already_resolved.
    const inLock = await resolveReplay(client);
    if (inLock !== "none") {
      await client.query("COMMIT");
      return inLock === "replay"
        ? { success: true, idempotent: true }
        : reply.code(409).send({ error: "idempotency_conflict" });
    }
    if (row.status === "resolved") {
      await client.query("ROLLBACK");
      return reply.code(409).send({ error: "case_already_resolved" });
    }
    // Decision → status: resolved_* resolves; a non-resolving decision keeps
    // an escalated case escalated instead of silently de-escalating it (the
    // staff action below is still recorded either way).
    const status = body.decision.startsWith("resolved_")
      ? "resolved"
      : row.status === "escalated"
        ? "escalated"
        : "in_review";
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
    // Durable audit copy: staff_actions rows are ON DELETE CASCADE with the
    // case, so a deleted case would erase the only record of the decision.
    // service_audit_events has no such cascade and shares the idempotency key.
    await client.query(
      `INSERT INTO service_audit_events(
         idempotency_key, actor_id, actor_username, action, target_type,
         target_id, request_state, before_state, after_state
       ) VALUES (
         $1,$2,$3,'case.decision','case',$4,$5::jsonb,$6::jsonb,$7::jsonb
       )`,
      [
        body.idempotencyKey,
        actorId,
        actorUsername,
        id,
        JSON.stringify(decisionIdentity),
        JSON.stringify({ status: row.status, resolution: row.resolution }),
        JSON.stringify({ status, resolution: body.decision }),
      ],
    );
    if (body.decision === "resolved_safe" || body.decision === "resolved_fraud") {
      await maxmind.queueCaseFeedback(client, {
        caseId: id,
        userId,
        decision: body.decision,
      });
    }
    await client.query("COMMIT");
  } catch (error) {
    // Swallow the ROLLBACK's own failure so the ORIGINAL error propagates.
    await client.query("ROLLBACK").catch(() => undefined);
    // A same-key commit raced past the lock: resolve it as the replay it is.
    if (pgErrorCode(error) === UNIQUE_VIOLATION) {
      const replay = await resolveReplay(db.antifraud);
      if (replay === "replay") return { success: true, idempotent: true };
      return reply.code(409).send({ error: "idempotency_conflict" });
    }
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

app.get("/v1/top-rain", async (request, reply) => {
  const { limit, days } = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(10),
    days: z.coerce.number().int().min(1).max(365).default(365),
  }).parse(request.query);
  // Client-side freshness hint; the promise cache already bounds MAIN reads.
  reply.header("Cache-Control", "private, max-age=15");
  return { data: await cachedTopRain(`${limit}:${days}`) };
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
}, async (request, reply) => {
  // Per-IP floor: the actor-keyed limiter above is defeated by rotating the
  // caller-chosen actorId, so the source IP gets its own (generous) cap.
  if (!ticketIpFloorAllows(request.ip)) {
    request.log.warn(
      { route: "POST /v1/ws/tickets" },
      "Websocket ticket request rejected by the per-IP rate floor",
    );
    return reply.code(429).send({ error: "rate_limited" });
  }
  const actor = z.object({
    actorId: z.string().min(1).max(100),
    actorUsername: z.string().trim().min(1).max(100).optional(),
  }).strict().parse(request.body);
  const ticket = await live.createTicket(actor);
  return {
    data: {
      ticket,
      websocketUrl: `${config.PUBLIC_BASE_URL.replace(/^http/, "ws")}/v1/live`,
      expiresInSeconds: TICKET_TTL_SECONDS,
    },
  };
});

/**
 * Bounded catch-up for a client that missed frames (the admin SSE proxy is torn
 * down at least every 5 minutes by its serverless duration cap). `after` is the
 * last live-frame id the client saw; omit it for the most recent events.
 */
app.get("/v1/live/replay", {
  config: {
    rateLimit: {
      // Generous per-IP bound (every admin shares the Vercel egress IP) that
      // never bans — same reasoning as the /v1/live upgrade limiter.
      max: 120,
      timeWindow: "1 minute",
      ban: -1,
    },
  },
}, async (request) => {
  const query = z.object({
    after: z.string().regex(STREAM_ID_PATTERN).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(200),
  }).parse(request.query);
  const result = await live.replay(query.after ?? null, query.limit);
  // The cursor is the last SCANNED stream id (not the last parsed envelope) so
  // unparseable entries cannot stall the caller's pagination loop. `truncated`
  // tells the proxy the stream was trimmed past its cursor and it must resync.
  // `scanned` lets the pager tell end-of-stream (0) apart from parse-skips.
  return {
    data: result.events,
    cursor: result.cursor ?? query.after ?? null,
    truncated: result.truncated,
    scanned: result.scanned,
  };
});

app.get("/v1/live", {
  websocket: true,
  config: {
    rateLimit: {
      // Every admin arrives via the same Vercel egress IP, so the global
      // IP-keyed limiter (with its 5-strike ban) would let one reconnect
      // storm ban the whole team. The real admission controls here are the
      // single-use ticket and the per-actor/global connection caps; this
      // per-route limiter only blunts raw upgrade floods and never bans.
      max: 120,
      timeWindow: "1 minute",
      ban: -1,
    },
  },
}, async (socket, request) => {
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
  let ticket: { actorId: string; actorUsername: string | null } | null = null;
  try {
    ticket = parsed.success ? await live.consumeTicket(parsed.data) : null;
  } catch (error) {
    // Redis being down is a capacity problem, not an auth failure: 1013 tells
    // the proxy to take its backoff instead of discarding the session as
    // unauthorized.
    request.log.error(
      { err: error },
      "Antifraud live websocket ticket lookup failed",
    );
    socket.close(1013, "unavailable");
    return;
  }
  if (!ticket) {
    socket.close(1008, "invalid_ticket");
    return;
  }
  // The peer may have disconnected during the ticket round-trip; its `close`
  // event already fired, so registering it would leak the connection slot.
  if (socket.readyState !== socket.OPEN) return;
  if (!live.addClient(socket, ticket.actorId)) {
    request.log.warn(
      { actorId: ticket.actorId, actorUsername: ticket.actorUsername },
      "Rejected antifraud live websocket: actor connection capacity reached",
    );
    socket.close(1013, "connection_capacity");
    return;
  }
  request.log.info(
    { actorId: ticket.actorId, actorUsername: ticket.actorUsername },
    "Antifraud live websocket connected",
  );
});

app.get("/v1/scoring", async () => {
  const [rules, weights] = await Promise.all([
    db.antifraud.query(
      `SELECT id, key, name, description, enabled, trigger, sequence,
              exclude_before, window_seconds, score_delta,
              'manual_review'::text AS action_type, priority,
              updated_at
         FROM rule_definitions
        ORDER BY priority, name`,
    ),
    scoreWeights.get(),
  ]);
  // Additive per-weight `updatedAt` (null for keys still on their catalog
  // default) so the dashboard can drive optimistic-concurrency updates.
  const weightUpdatedAt = await scoreWeights.getUpdatedAt();
  const withUpdatedAt = (definitions: ScoreDefinition[]) =>
    definitions.map((definition) => ({
      ...definition,
      options: definition.options.map((item) => ({
        ...item,
        updatedAt: weightUpdatedAt[item.key] ?? null,
      })),
    }));
  return {
    data: {
      monitorStartScore: config.MONITOR_START_SCORE,
      monitorDurationSeconds: config.MONITOR_DURATION_SECONDS,
      severityBands: SEVERITY_BANDS,
      signupSignals: withUpdatedAt(signupScoreDefinitions(weights)),
      providerSignals: withUpdatedAt(providerScoreDefinitions(weights)),
      activitySignals: withUpdatedAt(activityScoreDefinitions(weights)),
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
  if (!body.actorId) {
    request.log.warn(
      { route: "PUT /v1/scoring/:key", weightKey: key },
      "Mutation without actorId; audit falls back to the service actor",
    );
  }
  try {
    const updated = await scoreWeights.update({
      key,
      points: body.points,
      actorId: body.actorId ?? SERVICE_ACTOR_ID,
      actorUsername: body.actorUsername ?? null,
      idempotencyKey: body.idempotencyKey,
      expectedUpdatedAt: body.expectedUpdatedAt,
    });
    if (!updated.idempotent) {
      // Other replicas drop their score-weight caches on this frame, exactly
      // like rules already do.
      await publishCommittedMutation("score_weight.updated", {
        key: updated.key,
        points: updated.points,
        updatedAt: updated.updatedAt,
      });
    }
    return { data: updated };
  } catch (error) {
    if (error instanceof ScoreWeightConflictError) {
      return reply.code(409).send({ error: "idempotency_conflict" });
    }
    if (error instanceof ScoreWeightStaleError) {
      return reply.code(409).send({
        error: "stale_weight",
        currentUpdatedAt: error.currentUpdatedAt,
      });
    }
    throw error;
  }
});

await registerNetworkRoutes(app, db, networkRisk, config);
await registerFiatEmailDomainRoutes(app, db);
await registerIdentifierBlocklistRoutes(app, db);
await registerProfileRoutes(app, db);
await registerSignupFailureRoutes(app, db);
await registerRiskyLocationRoutes(app, db, engine.riskyLocations);
await registerFiatRoutes(app, db, fiatRisk);
registerMaxMindAlertRoute(app, maxmind);
await registerSumsubRoutes(
  app,
  sumsub,
  sumsub
    ? new KycCountryReviewService(
        db.antifraud,
        sumsub,
        () => new Date(),
        async (review) => {
          const url = new URL("/kyc", config.ANTIFRAUD_DASHBOARD_URL);
          url.searchParams.set("user", review.userId);
          await discordAlerts.sendSumsubReady(
            `sumsub-ready:${review.applicantId}:${review.providerReviewedAt}`,
            {
              title: "Sumsub result ready",
              description:
                "A Sumsub result is ready for immediate staff review.",
              userId: review.userId,
              severity: review.reviewAnswer === "RED" ? "high" : "medium",
              outcome: review.reviewAnswer ?? review.reviewStatus ?? "ready",
              occurredAt: review.providerReviewedAt
                ? new Date(review.providerReviewedAt)
                : new Date(),
              url: url.toString(),
            },
          );
        },
      )
    : undefined,
);
await registerFiatEligibilityRoutes(app, {
  config,
  access: fiatEligibilityAccess,
  service: fiatEligibility,
});
await registerFiatEligibilityOverrideRoutes(app, db);
await registerEosRandomBlockRoutes(
  app,
  undefined,
  db.battleTestDevSource && config.BATTLE_TEST_DEV_SERVER_SEED_PEPPER
    ? new DevBattleOutcomeSimulator(
        db.battleTestDevSource,
        config.BATTLE_TEST_DEV_SERVER_SEED_PEPPER,
      )
    : undefined,
  battleTestConfig,
);

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
  const route = request.routeOptions.url ?? "unknown";
  observe(() => {
    Sentry.logger.error("Unhandled antifraud request error", {
      http_method: request.method,
      http_route: route,
    });
    Sentry.metrics.count("http.server_errors", 1, {
      attributes: { method: request.method, route },
    });
  });
  Sentry.withScope((scope) => {
    scope.setTag("service", "antifraud-monitor");
    scope.setTag("http.method", request.method);
    scope.setTag("http.route", request.routeOptions.url ?? "unknown");
    Sentry.captureException(error);
  });
  return reply.code(500).send({ error: "internal_error" });
});

app.addHook("onClose", async () => {
  shuttingDown = true;
  dashboardOpsTick.stop();
  if (maxmindReportTimer) clearInterval(maxmindReportTimer);
  // Each teardown step is isolated: one failing subsystem must never abort the
  // hook before closeDatabases() runs, which would leak the pools (and, on
  // Railway, hold source-mirror connections until the process is killed).
  const teardown = async (step: string, run: () => Promise<void>) => {
    await run().catch((error: unknown) => {
      app.log.error({ err: error, step }, "Antifraud shutdown step failed");
    });
  };
  // Serialized, these three drains summed their individual budgets and the
  // total sat right under the 25 second watchdog below, which exits(1) into an
  // ON_FAILURE restart policy — a clean deploy would be counted as a crash.
  // They share no state: each only clears its own timer and awaits its own
  // in-flight promise, and all three still hold open database pools.
  await Promise.all([
    teardown("ingest_delivery", () => ingestDelivery.stop()),
    teardown("engine", () => engine.stop()),
    teardown("network_risk", () => networkRisk.stop()),
  ]);
  // Strictly after the engine: an in-flight tick still publishes to the live
  // bus, and closing it early would drop those broadcasts. Databases last of
  // all — every step above still queries them.
  await teardown("live", () => live.close());
  await teardown("databases", () => closeDatabases(db));
  await teardown("sentry", async () => {
    await Sentry.close(2_000);
  });
});

let shutdownPromise: Promise<void> | null = null;
function requestShutdown(signal: NodeJS.Signals): void {
  if (shutdownPromise) return;
  // Flip into lame-duck first: /health and /ready go 503 immediately and the
  // short drain window lets the platform stop routing before the close starts.
  shuttingDown = true;
  app.log.info({ signal }, "Antifraud service shutdown requested");
  const warning = setTimeout(() => {
    app.log.error({ signal }, "Antifraud service shutdown exceeded 25 seconds");
    process.exit(1);
  }, 25_000);
  warning.unref();
  shutdownPromise = new Promise<void>((resolve) => {
    setTimeout(resolve, SHUTDOWN_DRAIN_MS);
  })
    .then(() => app.close())
    .catch((error: unknown) => {
      process.exitCode = 1;
      app.log.error({ err: error, signal }, "Antifraud service shutdown failed");
    })
    .finally(() => clearTimeout(warning));
}
process.once("SIGTERM", () => requestShutdown("SIGTERM"));
process.once("SIGINT", () => requestShutdown("SIGINT"));

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
maxmindReportTimer = setInterval(() => {
  void maxmind.drainReports().catch((error) => {
    app.log.warn({ err: error }, "MaxMind feedback outbox drain failed");
  });
}, 30_000);
maxmindReportTimer.unref();
// Same guarded shape as the interval above: drainReports() opens with a pool
// query, and an unhandled rejection here (the DB is coldest right at boot)
// would kill the process under Node's default --unhandled-rejections=throw.
void maxmind.drainReports().catch((error) => {
  app.log.warn({ err: error }, "MaxMind feedback outbox drain failed");
});
await app.listen({ port: config.PORT, host: "0.0.0.0" });
app.log.info(
  {
    event: "fiat_eligibility.endpoint_ready",
    method: "POST",
    endpoint: new URL(FIAT_ELIGIBILITY_PATH, config.PUBLIC_BASE_URL).toString(),
    environments: fiatEligibilityAccess.configuredEnvironments(),
    globallyEnabled: config.FIAT_ELIGIBILITY_GLOBALLY_ENABLED,
    rateLimitPerMinute: config.FIAT_ELIGIBILITY_RATE_LIMIT_PER_MINUTE,
  },
  "Fiat eligibility endpoint ready for dev and prod traffic",
);
dashboardOpsTick.start();

// The MAIN mirror role is shared with other read-only consumers and can
// temporarily exhaust its connection allowance during a rolling deployment.
// Keep the API and durable Antifraud DB online while the poller retries. The
// /ready route remains 503 until both databases and the poller are healthy.
void (async () => {
  let failures = 0;
  while (!shuttingDown) {
    try {
      await engine.start();
      // SIGTERM can land WHILE start() is in flight: onClose already ran
      // engine.stop() against an engine that had not installed its interval
      // yet, so the interval start() just installed would outlive the pools
      // closeDatabases() is about to end. Stop it again now that it exists.
      if (shuttingDown) {
        await engine.stop();
        app.log.info(
          "Antifraud source poller start raced shutdown; stopped again",
        );
        return;
      }
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
