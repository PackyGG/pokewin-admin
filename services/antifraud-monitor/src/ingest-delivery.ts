import { createHmac } from "node:crypto";

import type { FastifyBaseLogger } from "fastify";
import type pg from "pg";

import type { Config } from "./config.js";
import { severity } from "./scoring.js";

const CURSOR = "admin-dashboard";
const LEADER_LOCK = 841_772_993;
// Containment signals perform an idempotent MAIN lock before acknowledgement.
// Keep each signed request below the dashboard's function timeout even when
// an entire batch contains withdrawal-lock commands.
const BATCH_SIZE = 10;
const DELIVERY_INTERVAL_MS = 5_000;
const DELIVERY_TIMEOUT_MS = 10_000;
const MAX_BACKOFF_MS = 60_000;
const MAX_EVIDENCE_PAYLOAD_BYTES = 3 * 1024;

export type RiskEventRow = {
  id: string;
  case_id: string | null;
  session_id: string | null;
  user_id: string;
  username: string | null;
  event_type: string;
  source: string;
  source_ref: string | null;
  score_delta: number;
  score_after: number;
  title: string;
  detail: string | null;
  payload: unknown;
  occurred_at: Date;
  recorded_at: Date;
};

type IngestEvent = {
  type: "signal";
  id: string;
  kind: string;
  severity: "low" | "medium" | "high" | "critical";
  riskScore: number;
  userId: string;
  username: string | null;
  summary: string;
  payload: Record<string, unknown>;
  at: string;
};

type IngestResponse = {
  ok?: unknown;
  accepted?: unknown;
  duplicates?: unknown;
};

export type IngestDeliverySnapshot = {
  running: boolean;
  consecutiveFailures: number;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastDeliveredCount: number;
};

function objectPayload(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const payload = value as Record<string, unknown>;
  return Buffer.byteLength(JSON.stringify(payload), "utf8") <=
    MAX_EVIDENCE_PAYLOAD_BYTES
    ? payload
    : { deliveryPayloadTruncated: true };
}

function blacklistedSourceEventIds(events: RiskEventRow[]): string[] {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.event_type !== "fiat_blacklisted_email_domain") continue;
    const sourceRef = event.source_ref;
    if (!sourceRef) continue;
    for (const prefix of ["blacklisted-signup:", "blacklisted-checkout:"]) {
      if (sourceRef.startsWith(prefix) && sourceRef.length > prefix.length) {
        ids.add(sourceRef.slice(prefix.length));
        break;
      }
    }
  }
  return [...ids];
}

export function signIngest(
  secret: string,
  timestamp: string,
  rawBody: string,
): string {
  return (
    "sha256=" +
    createHmac("sha256", secret)
      .update(`${timestamp}.${rawBody}`)
      .digest("hex")
  );
}

export function ingestEvent(row: RiskEventRow): IngestEvent {
  const summary =
    row.detail && row.detail !== row.title
      ? `${row.title} — ${row.detail}`
      : row.title;
  return {
    type: "signal",
    id: row.id,
    kind: row.event_type,
    severity: severity(row.score_after),
    riskScore: row.score_after,
    userId: row.user_id,
    username: row.username,
    summary: summary.slice(0, 500),
    payload: {
      ...objectPayload(row.payload),
      caseId: row.case_id,
      sessionId: row.session_id,
      source: row.source,
      sourceRef: row.source_ref,
      scoreDelta: row.score_delta,
      scoreAfter: row.score_after,
    },
    at: row.occurred_at.toISOString(),
  };
}

export function deliveryBackoffMs(consecutiveFailures: number): number {
  const exponent = Math.max(0, consecutiveFailures - 1);
  return Math.min(
    MAX_BACKOFF_MS,
    DELIVERY_INTERVAL_MS * 2 ** Math.min(exponent, 10),
  );
}

export class IngestDelivery {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private consecutiveFailures = 0;
  private nextAttemptAt = 0;
  private lastAttemptAt: string | null = null;
  private lastSuccessAt: string | null = null;
  private lastDeliveredCount = 0;

  constructor(
    private readonly config: Config,
    private readonly pool: pg.Pool,
    private readonly log: FastifyBaseLogger,
    private readonly send: typeof fetch = fetch,
  ) {}

  async start(): Promise<void> {
    await this.tick();
    this.timer = setInterval(() => void this.tick(), DELIVERY_INTERVAL_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const deadline = Date.now() + DELIVERY_TIMEOUT_MS;
    while (this.running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  snapshot(): IngestDeliverySnapshot {
    return {
      running: this.running,
      consecutiveFailures: this.consecutiveFailures,
      lastAttemptAt: this.lastAttemptAt,
      lastSuccessAt: this.lastSuccessAt,
      lastDeliveredCount: this.lastDeliveredCount,
    };
  }

  async flushOnce(): Promise<number> {
    const client = await this.pool.connect();
    let leader = false;
    try {
      const lock = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock($1) AS acquired",
        [LEADER_LOCK],
      );
      leader = lock.rows[0]?.acquired === true;
      if (!leader) return 0;

      const cursor = await client.query<{
        recorded_at: Date;
        event_id: string;
      }>(
        `
          SELECT recorded_at, event_id
          FROM ingest_delivery_cursors
          WHERE sink = $1
        `,
        [CURSOR],
      );
      const current = cursor.rows[0];
      if (!current) {
        throw new Error("Antifraud ingest delivery cursor is missing");
      }

      const events = await client.query<RiskEventRow>(
        `
          SELECT
            re.id, re.case_id, re.session_id, re.user_id, s.username,
            re.event_type, re.source, re.source_ref, re.score_delta,
            re.score_after, re.title, re.detail, re.payload,
            re.occurred_at, re.recorded_at
          FROM risk_events re
          JOIN subjects s ON s.user_id = re.user_id
          WHERE (re.recorded_at, re.id) > ($1, $2::uuid)
          ORDER BY re.recorded_at, re.id
          LIMIT $3
        `,
        [current.recorded_at, current.event_id, BATCH_SIZE],
      );
      if (events.rows.length === 0) return 0;

      const rawBody = JSON.stringify({
        events: events.rows.map(ingestEvent),
      });
      const timestamp = String(Date.now());
      const response = await this.send(this.config.ANTIFRAUD_INGEST_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-antifraud-timestamp": timestamp,
          "x-antifraud-signature": signIngest(
            this.config.ANTIFRAUD_INGEST_SECRET,
            timestamp,
            rawBody,
          ),
        },
        body: rawBody,
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`Dashboard ingest returned HTTP ${response.status}`);
      }
      const result = (await response.json()) as IngestResponse;
      const confirmed =
        Number(result.accepted ?? 0) + Number(result.duplicates ?? 0);
      if (result.ok !== true || confirmed !== events.rows.length) {
        throw new Error(
          `Dashboard ingest confirmed ${confirmed}/${events.rows.length} events`,
        );
      }

      const lockedSourceEventIds = blacklistedSourceEventIds(events.rows);
      if (lockedSourceEventIds.length > 0) {
        await client.query(
          `
            WITH confirmed_matches AS (
              UPDATE fiat_email_domain_matches
              SET
                lock_delivered_at = COALESCE(lock_delivered_at, now()),
                next_attempt_at = now(),
                last_error = NULL,
                updated_at = now()
              WHERE source_event_id = ANY($1::text[])
              RETURNING source_event_id, match_source, domain
            )
            UPDATE fiat_problem_alert_outbox AS alert
            SET next_attempt_at = now(), updated_at = now()
            FROM confirmed_matches AS match
            WHERE alert.source_kind = CASE
                WHEN match.match_source = 'signup' THEN 'signup'
                ELSE 'payment_webhook'
              END
              AND alert.source_id =
                match.source_event_id || ':blacklisted_email_domain:' || match.domain
              AND alert.discord_delivered_at IS NULL
          `,
          [lockedSourceEventIds],
        );
      }

      const last = events.rows.at(-1);
      if (!last) return 0;
      await client.query(
        `
          UPDATE ingest_delivery_cursors
          SET recorded_at = $2, event_id = $3, updated_at = now()
          WHERE sink = $1
        `,
        [CURSOR, last.recorded_at, last.id],
      );
      return events.rows.length;
    } finally {
      if (leader) {
        await client
          .query("SELECT pg_advisory_unlock($1)", [LEADER_LOCK])
          .catch((error) =>
            this.log.warn(
              { err: error },
              "Antifraud ingest delivery lock release failed",
            ),
          );
      }
      client.release();
    }
  }

  private async tick(): Promise<void> {
    if (this.running || Date.now() < this.nextAttemptAt) return;
    this.running = true;
    this.lastAttemptAt = new Date().toISOString();
    try {
      const delivered = await this.flushOnce();
      this.lastDeliveredCount = delivered;
      this.lastSuccessAt = new Date().toISOString();
      this.consecutiveFailures = 0;
      this.nextAttemptAt = 0;
      if (delivered === BATCH_SIZE) {
        setImmediate(() => void this.tick());
      }
    } catch (error) {
      this.consecutiveFailures += 1;
      this.nextAttemptAt =
        Date.now() + deliveryBackoffMs(this.consecutiveFailures);
      this.log.warn(
        {
          err:
            error instanceof Error
              ? { name: error.name, message: error.message }
              : { name: "Error", message: "unknown delivery failure" },
          consecutiveFailures: this.consecutiveFailures,
        },
        "Antifraud dashboard ingest delivery failed",
      );
    } finally {
      this.running = false;
    }
  }
}
