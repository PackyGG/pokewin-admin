import { createHmac } from "node:crypto";

import type { FastifyBaseLogger } from "fastify";
import type pg from "pg";

import type { Config } from "./config.js";
import { signedIngestTarget } from "./notification-routes.js";
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

// Containment signals that are gated purely on `dashboard_delivered_at`.
// `fiat_blacklisted_email_domain` is deliberately absent: it is gated on the
// blacklist match row instead and is read by its own query below.
const DASHBOARD_CONTAINMENT_EVENT_TYPES: ReadonlySet<string> = new Set([
  "abstract_email_catchall",
  "behavioral_withdrawal_containment",
  "critical_risk_signup",
  "fiat_deposit_identity_containment",
  "fiat_eligibility_containment",
]);

function objectPayload(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const payload = value as Record<string, unknown>;
  if (
    Buffer.byteLength(JSON.stringify(payload), "utf8") <=
    MAX_EVIDENCE_PAYLOAD_BYTES
  ) {
    return payload;
  }

  // Large evidence blobs must not erase the small command envelope that the
  // dashboard validates before applying containment. The former all-or-
  // nothing truncation reduced an otherwise valid Fiat identity command to
  // `{ deliveryPayloadTruncated: true }`, so the dashboard stored the alert
  // but correctly refused to lock the account. Preserve only the reviewed
  // admission fields; bulky provider/network evidence remains available in
  // the Antifraud database and webapp.
  const preservedKeys = [
    "containmentRequired",
    "containmentAction",
    "reviewOnly",
    "environment",
    "intentId",
    "reasonCodes",
    "reviewCodes",
    "watchCodes",
    "refundedAmountClusterActiveUntil",
  ] as const;
  const compact: Record<string, unknown> = {
    deliveryPayloadTruncated: true,
  };
  for (const key of preservedKeys) {
    if (payload[key] !== undefined) compact[key] = payload[key];
  }
  return compact;
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

function byRecordedOrder(left: RiskEventRow, right: RiskEventRow): number {
  const delta = left.recorded_at.getTime() - right.recorded_at.getTime();
  return delta !== 0 ? delta : left.id.localeCompare(right.id);
}

export class IngestDelivery {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private running = false;
  private consecutiveFailures = 0;
  private nextAttemptAt = 0;
  // Delivery telemetry. `snapshot()` and `IngestDeliverySnapshot` were removed
  // because nothing repo-wide ever read them; the counters stay so wiring an
  // operations route later needs an accessor and nothing else.
  private lastAttemptAt: string | null = null;
  private lastSuccessAt: string | null = null;
  private lastDeliveredCount = 0;

  constructor(
    private readonly config: Config,
    private readonly pool: pg.Pool,
    private readonly log: FastifyBaseLogger,
    private readonly send: typeof fetch = fetch,
  ) {}

  // `stop()` is terminal — the process owns exactly one IngestDelivery and
  // never restarts it — so `stopped` is only ever set, never cleared here.
  async start(): Promise<void> {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), DELIVERY_INTERVAL_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    // Set before the timer is cleared: a `setImmediate` continuation queued by
    // a full batch must not open a fresh connection on a pool that shutdown is
    // already ending, which surfaced as a delivery error on every clean deploy.
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const deadline = Date.now() + DELIVERY_TIMEOUT_MS;
    while (this.running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
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

      // Split deliberately into two indexable reads instead of one six-branch
      // disjunction over a post-join column. The old shape referenced
      // `match.lock_delivered_at` inside the OR, so the whole predicate had to
      // be evaluated after a join whose ON clause concatenated a literal onto a
      // column — no index could serve it and the planner could not BitmapOr the
      // partial indexes that already exist. Both halves below drive off a
      // partial index and are merged in JS, preserving the original
      // "containment first, then general stream" ordering.
      const dashboardContainment = await client.query<RiskEventRow>(
        `
          SELECT
            re.id, re.case_id, re.session_id, re.user_id, s.username,
            re.event_type, re.source, re.source_ref, re.score_delta,
            re.score_after, re.title, re.detail, re.payload,
            re.occurred_at, re.recorded_at
          FROM risk_events re
          JOIN subjects s ON s.user_id = re.user_id
          WHERE re.dashboard_delivered_at IS NULL
            AND (
              re.event_type = 'abstract_email_catchall'
              OR re.event_type = 'behavioral_withdrawal_containment'
              OR re.event_type = 'critical_risk_signup'
              OR re.event_type = 'fiat_deposit_identity_containment'
              OR re.event_type = 'fiat_eligibility_containment'
            )
          ORDER BY re.recorded_at, re.id
          LIMIT $1
        `,
        [BATCH_SIZE],
      );

      // The blacklist half keeps the original LEFT JOIN and its exact ON
      // predicate — an event whose match row is missing entirely still has to
      // be delivered, which an inner join would silently drop. The added
      // `source_event_id` equality is what makes the join an index probe on the
      // unique key; the concatenation predicate stays as an exact-semantics
      // filter on top of it.
      const blacklistContainment = await client.query<RiskEventRow>(
        `
          SELECT
            re.id, re.case_id, re.session_id, re.user_id, s.username,
            re.event_type, re.source, re.source_ref, re.score_delta,
            re.score_after, re.title, re.detail, re.payload,
            re.occurred_at, re.recorded_at
          FROM risk_events re
          JOIN subjects s ON s.user_id = re.user_id
          LEFT JOIN fiat_email_domain_matches match ON
            match.source_event_id = split_part(re.source_ref, ':', 2)
            AND (
              re.source_ref = 'blacklisted-signup:' || match.source_event_id
              OR re.source_ref =
                'blacklisted-checkout:' || match.source_event_id
            )
          WHERE re.event_type = 'fiat_blacklisted_email_domain'
            AND match.lock_delivered_at IS NULL
            AND re.payload ->> 'reviewOnly' IS DISTINCT FROM 'true'
          ORDER BY re.recorded_at, re.id
          LIMIT $1
        `,
        [BATCH_SIZE],
      );

      // The two reads are disjoint on `event_type` in SQL; re-asserting it in
      // JS keeps the merge correct no matter which half a row came back from.
      const containmentRows = [
        ...dashboardContainment.rows.filter((event) =>
          DASHBOARD_CONTAINMENT_EVENT_TYPES.has(event.event_type),
        ),
        ...blacklistContainment.rows.filter(
          (event) =>
            event.event_type === "fiat_blacklisted_email_domain"
            && objectPayload(event.payload).reviewOnly !== true,
        ),
      ]
        .sort(byRecordedOrder)
        .slice(0, BATCH_SIZE);
      if (containmentRows.length > 0) {
        await this.deliverEvents(containmentRows);
        await this.confirmDashboardEvents(client, containmentRows);
        await this.confirmContainmentEvents(client, containmentRows);
        return containmentRows.length;
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
          -- A tuple cursor alone can skip a transaction that started earlier
          -- but committed after the cursor advanced. This receipt is written
          -- only after the dashboard confirms the complete signed batch.
          WHERE re.dashboard_delivered_at IS NULL
          ORDER BY re.recorded_at, re.id
          LIMIT $1
        `,
        [BATCH_SIZE],
      );
      if (events.rows.length === 0) return 0;

      await this.deliverEvents(events.rows);
      await this.confirmDashboardEvents(client, events.rows);

      const last = events.rows.at(-1);
      if (!last) return 0;
      await client.query(
        `
          UPDATE ingest_delivery_cursors
          SET recorded_at = $2, event_id = $3, updated_at = now()
          WHERE sink = $1
            AND (recorded_at, event_id) < ($2, $3::uuid)
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

  private async deliverEvents(events: RiskEventRow[]): Promise<void> {
    const target = signedIngestTarget(this.config);
    if (!target) {
      throw new Error("Dashboard ingest is not configured");
    }
    const rawBody = JSON.stringify({
      events: events.map(ingestEvent),
    });
    const timestamp = String(Date.now());
    const response = await this.send(target.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-antifraud-timestamp": timestamp,
        "x-antifraud-signature": signIngest(
          target.secret,
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
    if (result.ok !== true || confirmed !== events.length) {
      throw new Error(
        `Dashboard ingest confirmed ${confirmed}/${events.length} events`,
      );
    }
  }

  private async confirmContainmentEvents(
    client: pg.PoolClient,
    events: RiskEventRow[],
  ): Promise<void> {
    const eventIds = events
      .filter(
        (event) =>
          event.event_type === "fiat_blacklisted_email_domain"
          && objectPayload(event.payload).reviewOnly !== true,
      )
      .map((event) => event.id);
    if (eventIds.length === 0) return;
    await client.query(
      `
        WITH confirmed_matches AS (
          UPDATE fiat_email_domain_matches AS match
          SET
            lock_delivered_at = COALESCE(match.lock_delivered_at, now()),
            next_attempt_at = now(),
            last_error = NULL,
            updated_at = now()
          FROM risk_events AS event
          WHERE event.id = ANY($1::uuid[])
            AND (
              event.source_ref = 'blacklisted-signup:' || match.source_event_id
              OR event.source_ref =
                'blacklisted-checkout:' || match.source_event_id
            )
          RETURNING match.source_event_id, match.match_source, match.domain
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
      [eventIds],
    );
  }

  private async confirmDashboardEvents(
    client: pg.PoolClient,
    events: RiskEventRow[],
  ): Promise<void> {
    const eventIds = events.map((event) => event.id);
    if (eventIds.length === 0) return;
    await client.query(
      `
        UPDATE risk_events
        SET dashboard_delivered_at =
          COALESCE(dashboard_delivered_at, now())
        WHERE id = ANY($1::uuid[])
      `,
      [eventIds],
    );
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.running || Date.now() < this.nextAttemptAt) return;
    this.running = true;
    this.lastAttemptAt = new Date().toISOString();
    try {
      const delivered = await this.flushOnce();
      this.lastDeliveredCount = delivered;
      this.lastSuccessAt = new Date().toISOString();
      this.consecutiveFailures = 0;
      this.nextAttemptAt = 0;
      if (delivered === BATCH_SIZE && !this.stopped) {
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
