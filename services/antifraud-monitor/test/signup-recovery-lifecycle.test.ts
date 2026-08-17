import assert from "node:assert/strict";
import test from "node:test";

import type { FastifyBaseLogger } from "fastify";
import type pg from "pg";

import type { Config } from "../src/config.js";
import type { Databases } from "../src/db.js";
import { MonitorEngine } from "../src/monitor.js";
import { defaultScoreWeights } from "../src/score-catalog.js";
import type { Signup } from "../src/types.js";

type FailureRow = {
  user_id: string;
  payload: unknown;
  error_text: string;
  failure_kind: string;
  failure_count: number;
  next_retry_at: Date | null;
  resolved_at: Date | null;
};

type RecoveryState = {
  failure: FailureRow | null;
  assessmentUserId: string | null;
  caseUserId: string | null;
  sessionUserId: string | null;
  cursorUserId: string | null;
  recommendationPayload: Record<string, unknown> | null;
};

const signup: Signup = {
  id: "recovery-user-1",
  username: "recovery-player",
  email: "player@example.com",
  image: null,
  signup_ip: null,
  country: null,
  country_code: null,
  continent_code: null,
  state: null,
  city: null,
  affiliate_code: null,
  referred_by: null,
  is_suspected_alt: false,
  created_at: new Date("2026-08-07T00:00:00.000Z"),
  fingerprint_request_id: null,
  visitor_id: null,
  fingerprint_confidence: null,
  fingerprint_ip: null,
  user_agent: null,
};

const quietLogger = {
  error() {},
  warn() {},
  info() {},
} as unknown as FastifyBaseLogger;

function normalized(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function recoveryDatabase(state: RecoveryState): Databases {
  const query = async (text: string, values?: unknown[]) => {
    const sql = normalized(text);

    if (sql.includes("INSERT INTO signup_ingestion_failures")) {
      const delaySeconds = values?.[5] as number | null;
      state.failure = {
        user_id: String(values?.[0]),
        payload: JSON.parse(String(values?.[2])),
        error_text: String(values?.[3]),
        failure_kind: String(values?.[4]),
        failure_count: 1,
        next_retry_at: delaySeconds === null
          ? null
          : new Date(Date.now() + delaySeconds * 1_000),
        resolved_at: null,
      };
      return { rows: [], rowCount: 1 };
    }

    if (
      sql.includes("SELECT user_id, payload")
      && sql.includes("FROM signup_ingestion_failures")
    ) {
      const failure = state.failure;
      const eligible = failure
        && failure.resolved_at === null
        && failure.next_retry_at !== null
        && failure.next_retry_at.getTime() <= Date.now();
      return {
        rows: eligible
          ? [{ user_id: failure.user_id, payload: failure.payload }]
          : [],
        rowCount: eligible ? 1 : 0,
      };
    }

    if (sql.startsWith("DELETE FROM signup_ingestion_failures")) {
      const failure = state.failure;
      const deleted = Boolean(
        failure
          && failure.user_id === values?.[0]
          && failure.resolved_at === null,
      );
      if (deleted) state.failure = null;
      return { rows: [], rowCount: deleted ? 1 : 0 };
    }

    if (sql.includes("SELECT COUNT(*)::int AS count")) {
      return {
        rows: [{ count: state.failure?.resolved_at === null ? 1 : 0 }],
        rowCount: 1,
      };
    }

    if (
      sql.includes("SELECT occurred_at, source_id")
      && sql.includes("stream = 'signups'")
    ) {
      return {
        rows: [{
          occurred_at: new Date("2026-08-07T00:00:00.000Z"),
          source_id: signup.id,
        }],
        rowCount: 1,
      };
    }

    if (sql.includes("INSERT INTO signup_assessments")) {
      state.assessmentUserId = String(values?.[0]);
    }
    if (
      sql.includes("'signup_policy_recommendation'")
      && typeof values?.[5] === "string"
    ) {
      state.recommendationPayload = JSON.parse(values[5]) as Record<
        string,
        unknown
      >;
    }
    if (sql.includes("INSERT INTO cases(")) {
      state.caseUserId = String(values?.[0]);
      return { rows: [{ id: "case-recovered" }], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO monitor_sessions")) {
      state.sessionUserId = String(values?.[1]);
      return { rows: [{ id: "session-recovered" }], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO profile_assessment_history")) {
      return { rows: [{ id: "assessment-recovered" }], rowCount: 1 };
    }
    if (
      sql.includes("UPDATE source_cursors")
      && sql.includes("stream = 'signups'")
    ) {
      state.cursorUserId = String(values?.[1]);
    }

    return { rows: [], rowCount: 1 };
  };

  const client = {
    query,
    release() {},
  };
  const antifraud = {
    query,
    connect: async () => client,
  } as unknown as pg.Pool;
  const source = {
    query: async () => ({ rows: [], rowCount: 0 }),
  } as unknown as pg.Pool;
  return { antifraud, source, fiatDevSource: null };
}

type EngineTestSeams = {
  deadLetterSignup(signup: Signup, error: unknown): Promise<void>;
  scanSignups(): Promise<{
    processed: number;
    recovered: number;
    failuresPending: number;
    backlogPossible: boolean;
    cursorLagMs: number | null;
  }>;
  prepareSignup: (signup: Signup) => Promise<unknown>;
  evaluateRules: () => Promise<void>;
  health: {
    tickStarted(): void;
    leaderAcquired(): void;
    tickSucceeded(metrics: {
      signupsProcessed: number;
      signupsRecovered: number;
      signupFailuresPending: number;
      activitiesProcessed: number;
      signupBacklogPossible: boolean;
      signupCursorLagMs: number | null;
    }): void;
  };
};

test("a failed signup is durably scheduled, assessed on retry, and clears recovery health", async () => {
  const state: RecoveryState = {
    failure: null,
    assessmentUserId: null,
    caseUserId: null,
    sessionUserId: null,
    cursorUserId: null,
    recommendationPayload: null,
  };
  const db = recoveryDatabase(state);
  const config = {
    POLL_SIGNUP_BATCH_SIZE: 100,
    POLL_MAX_SIGNUP_BATCHES: 1,
    POLL_STALE_AFTER_MS: 15_000,
    MONITOR_DURATION_SECONDS: 180,
    FINGERPRINT_SECRET_API_KEY: "fixture-fingerprint-key",
    FINGERPRINT_REGION: "eu",
    PROXYCHECK_API_KEY: "",
    API_TOKEN: "",
    API_ADMIN_TOKEN: "",
    SOURCE_DATABASE_URL: "",
    ANTIFRAUD_DATABASE_URL: "",
    REDIS_URL: "",
    ANTIFRAUD_INGEST_SECRET: "",
  } as unknown as Config;
  const liveEvents: string[] = [];
  const engine = new MonitorEngine(
    config,
    db,
    {
      publish: async (type: string) => {
        liveEvents.push(type);
      },
    } as never,
    { get: async () => defaultScoreWeights() } as never,
    quietLogger,
  );
  const seams = engine as unknown as EngineTestSeams;

  await seams.deadLetterSignup(signup, new Error("database temporarily busy"));

  assert.ok(state.failure, "the failure must survive beyond the failed attempt");
  assert.equal(state.failure.failure_kind, "transient");
  assert.equal(state.failure.failure_count, 1);
  assert.ok(
    state.failure.next_retry_at
      && state.failure.next_retry_at.getTime() > Date.now(),
    "a transient failure must receive a future retry time",
  );
  assert.equal(state.cursorUserId, signup.id);

  // Move the in-memory database clock past the durable schedule. The engine's
  // replay query, rather than an in-process timer, now makes the row eligible.
  state.failure.next_retry_at = new Date(Date.now() - 1);
  seams.prepareSignup = async () => ({
    context: {
      sameIp10m: 0,
      sameIp30m: 0,
      sameExactIp30d: 0,
      sameIpv6Subnet30m: 0,
      sameDeviceAllTime: 0,
      sameDevice30d: 0,
      sameDeviceDistinctIps30d: 0,
      sameAffiliate30m: 0,
      sameAffiliateIp30m: 0,
      sameCountry15m: 0,
    },
    fingerprint: successfulProvider("fingerprint"),
    proxycheck: successfulProvider("proxycheck"),
    abstractIp: successfulProvider("abstract_ip"),
    abstractEmail: successfulProvider("abstract_email"),
    maxmind: successfulProvider("maxmind"),
    weights: defaultScoreWeights(),
    identifierBlocklistSignals: [{
      key: "identifier_blocklist_email",
      title: "Blocked signup identifier",
      detail: "Fixture creates a reviewable score and case.",
      points: 70,
    }],
  });
  seams.evaluateRules = async () => {};

  const metrics = await seams.scanSignups();

  assert.deepEqual(metrics, {
    processed: 0,
    recovered: 1,
    failuresPending: 0,
    backlogPossible: false,
    cursorLagMs: 0,
  });
  assert.equal(state.assessmentUserId, signup.id);
  assert.equal(state.caseUserId, signup.id);
  assert.equal(state.sessionUserId, signup.id);
  assert.equal(state.failure, null, "success must delete the durable queue row");
  assert.equal(
    state.recommendationPayload?.reviewOnly,
    true,
    "ordinary signup recommendations must bypass containment validation",
  );
  assert.ok(liveEvents.includes("signup.assessed"));
  assert.ok(liveEvents.includes("monitor.started"));

  seams.health.tickStarted();
  seams.health.leaderAcquired();
  seams.health.tickSucceeded({
    signupsProcessed: metrics.processed,
    signupsRecovered: metrics.recovered,
    signupFailuresPending: metrics.failuresPending,
    activitiesProcessed: 0,
    signupBacklogPossible: metrics.backlogPossible,
    signupCursorLagMs: metrics.cursorLagMs,
  });
  const health = engine.healthSnapshot();
  assert.equal(health.status, "healthy");
  assert.equal(health.signupsRecovered, 1);
  assert.equal(health.signupFailuresPending, 0);
});

function successfulProvider(provider: string) {
  return {
    provider,
    status: "success",
    lookupKey: `${provider}:fixture`,
    score: 0,
    signals: [],
    response: {},
    completeness: "complete",
  };
}
