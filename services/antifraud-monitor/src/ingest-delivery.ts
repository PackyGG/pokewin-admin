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
// Containment admission may trigger several bounded downstream lock calls in
// the dashboard. Keep those requests single-account so one slow target cannot
// push an otherwise healthy batch past the end-to-end delivery deadline.
const CONTAINMENT_BATCH_SIZE = 1;
const DELIVERY_INTERVAL_MS = 5_000;
const DELIVERY_TIMEOUT_MS = 10_000;
const DELIVERY_MAX_AGE_SQL = "1 hour";
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
  stale?: unknown;
  // The dashboard answers HTTP 200 with locksSkipped > 0 when containment
  // validation rejected the command or runDeferredContainment did not return
  // "locked" (including "failed"). Delivery succeeded; the LOCK did not. This
  // must be read, or a lock that never happened gets a lock receipt.
  locksSkipped?: unknown;
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
  "whop_history_auto_ban",
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
  // EVERY key any dashboard containment validator reads must appear here. A
  // missing key does not degrade gracefully: the validator returns null, the
  // dashboard records the alert and skips containment permanently, and no
  // outbox row is written so nothing ever retries. `riskBand`, `reasonCode`
  // (SINGULAR — distinct from the plural `reasonCodes` below) and `actions`
  // were absent, which silently disabled critical-signup containment for
  // exactly the 70-100 score accounts whose evidence is large enough to
  // truncate. Guarded by the CONTAINMENT_PAYLOAD_KEYS fixture.
  const preservedKeys = [
    "containmentRequired",
    "containmentAction",
    "reviewOnly",
    "environment",
    "intentId",
    "reasonCode",
    "reasonCodes",
    "reviewCodes",
    "watchCodes",
    "riskBand",
    "actions",
    "matchSource",
    "matchCount",
    "qualifyingBattleCount",
    "distinctFlaggedCreators",
    "emailRiskType",
    "refundedAmountClusterActiveUntil",
    "provider",
    "paymentId",
    "depositIntentId",
    "priorDisputeCount",
    "priorRefundCount",
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

function byContainmentDeliveryOrder(
  left: RiskEventRow,
  right: RiskEventRow,
): number {
  const leftPriority = left.event_type === "whop_history_auto_ban" ? 0 : 1;
  const rightPriority = right.event_type === "whop_history_auto_ban" ? 0 : 1;
  return leftPriority - rightPriority || byRecordedOrder(left, right);
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
    let transactionOpen = false;
    try {
      // The leader lease must be transaction-scoped. A session advisory lock
      // can survive an interrupted cleanup while the pg Pool keeps that
      // physical connection alive. Once that poisoned connection goes idle,
      // every other pool checkout sees the lock as held and silently returns
      // without delivering anything. The transaction lock is released by
      // PostgreSQL on COMMIT, ROLLBACK, connection loss, or process exit.
      await client.query("BEGIN");
      transactionOpen = true;
      const lock = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_xact_lock($1) AS acquired",
        [LEADER_LOCK],
      );
      if (lock.rows[0]?.acquired !== true) {
        await client.query("ROLLBACK");
        transactionOpen = false;
        return 0;
      }

      // Account Review is an operational queue, not a historical event
      // archive. If delivery was unavailable for longer than one hour, close
      // the old dashboard receipts without replaying stale cases or automatic
      // containment. Discord has its own durable receipt and is unaffected.
      await client.query(
        `
          UPDATE risk_events
          SET dashboard_delivered_at = COALESCE(dashboard_delivered_at, now())
          WHERE dashboard_delivered_at IS NULL
            AND occurred_at < now() - $1::interval
        `,
        [DELIVERY_MAX_AGE_SQL],
      );

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
            AND re.occurred_at >= now() - $2::interval
            AND (
              re.event_type = 'abstract_email_catchall'
              OR re.event_type = 'behavioral_withdrawal_containment'
              OR re.event_type = 'critical_risk_signup'
              OR re.event_type = 'fiat_deposit_identity_containment'
              OR re.event_type = 'fiat_eligibility_containment'
              OR re.event_type = 'whop_history_auto_ban'
            )
          -- A provider-confirmed prior dispute/refund is an account-access
          -- decision, so it must not wait behind historical review/lock
          -- receipts. Preserve FIFO inside each priority band.
          ORDER BY
            CASE WHEN re.event_type = 'whop_history_auto_ban' THEN 0 ELSE 1 END,
            re.recorded_at,
            re.id
          LIMIT $1
        `,
        [CONTAINMENT_BATCH_SIZE, DELIVERY_MAX_AGE_SQL],
      );

      // The blacklist half keeps the original LEFT JOIN and its exact ON
      // predicate — an event whose match row is missing entirely still has to
      // be delivered, which an inner join would silently drop. The added
      // `source_event_id` equality is what makes the join an index probe on the
      // unique key. Source event IDs can themselves contain colons (for
      // example `signup:<user-id>`), so remove only the delivery prefix rather
      // than using split_part(..., 2), which truncates those IDs to `signup`.
      // The concatenation predicate stays as an exact-semantics filter on top.
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
            match.source_event_id = substring(
              re.source_ref FROM position(':' IN re.source_ref) + 1
            )
            AND (
              re.source_ref = 'blacklisted-signup:' || match.source_event_id
              OR re.source_ref =
                'blacklisted-checkout:' || match.source_event_id
            )
          WHERE re.event_type = 'fiat_blacklisted_email_domain'
            AND re.occurred_at >= now() - $2::interval
            -- An event with NO match row can never be ACKed here:
            -- confirmContainmentEvents joins through the same match row, so it
            -- updates zero rows, the lock_delivered_at IS NULL test stays
            -- true, and this branch re-selects the same event forever. Because
            -- containment branch returns before the ordinary stream is reached
            -- and CONTAINMENT_BATCH_SIZE is 1, one unmatched row starved
            -- Account Review delivery completely and spun at the poll rate.
            -- Requiring the match row keeps the fast path to events it can
            -- actually confirm; unmatched ones still deliver (and DO get a
            -- receipt) through the general query below, which filters only on
            -- dashboard_delivered_at and the same one-hour window.
            AND match.source_event_id IS NOT NULL
            -- Gate on the DELIVERY receipt, not the LOCK receipt. These are two
            -- different facts: dashboard_delivered_at means the dashboard
            -- received this event, lock_delivered_at means the withdrawal
            -- lock is provably present on MAIN. Gating delivery on the lock
            -- receipt forced the delivery path to stamp lock_delivered_at just
            -- to stop re-selecting the row — which marked locks the dashboard
            -- had actually SKIPPED as delivered and removed them from
            -- confirmLocks()'s pending set, permanently disabling the only
            -- check that verifies the lock against MAIN.
            AND re.dashboard_delivered_at IS NULL
            AND re.payload ->> 'reviewOnly' IS DISTINCT FROM 'true'
          ORDER BY re.recorded_at, re.id
          LIMIT $1
        `,
        [CONTAINMENT_BATCH_SIZE, DELIVERY_MAX_AGE_SQL],
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
        .sort(byContainmentDeliveryOrder)
        .slice(0, CONTAINMENT_BATCH_SIZE);
      if (containmentRows.length > 0) {
        const containmentDelivery = await this.deliverEvents(containmentRows);
        await this.confirmDashboardEvents(client, containmentRows);
        await this.confirmContainmentEvents(
          client,
          containmentRows,
          containmentDelivery.locksSkipped,
        );
        await client.query("COMMIT");
        transactionOpen = false;
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
            AND re.occurred_at >= now() - $2::interval
          ORDER BY re.recorded_at, re.id
          LIMIT $1
        `,
        [BATCH_SIZE, DELIVERY_MAX_AGE_SQL],
      );
      if (events.rows.length === 0) {
        await client.query("COMMIT");
        transactionOpen = false;
        return 0;
      }

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
      await client.query("COMMIT");
      transactionOpen = false;
      return events.rows.length;
    } catch (error) {
      if (transactionOpen) {
        await client.query("ROLLBACK").catch((rollbackError) =>
          this.log.warn(
            { err: rollbackError },
            "Antifraud ingest delivery rollback failed",
          ),
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async deliverEvents(
    events: RiskEventRow[],
  ): Promise<{ locksSkipped: number }> {
    const target = signedIngestTarget(this.config);
    if (!target) {
      throw new Error("Dashboard ingest is not configured");
    }
    const rawBody = JSON.stringify({
      events: events.map(ingestEvent),
    });
    const timestamp = String(Date.now());
    const controller = new AbortController();
    let timeout: NodeJS.Timeout | null = null;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error("Dashboard ingest timed out"));
      }, DELIVERY_TIMEOUT_MS);
      timeout.unref();
    });
    let result: IngestResponse;
    try {
      // Race the complete response-body read, not only the initial fetch.
      // Some runtimes resolve fetch after headers and then ignore an abort
      // while a streamed body stalls; the explicit deadline still releases
      // the database lease and lets the durable event retry.
      result = await Promise.race([
        (async () => {
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
            signal: controller.signal,
          });
          if (!response.ok) {
            throw new Error(
              `Dashboard ingest returned HTTP ${response.status}`,
            );
          }
          return (await response.json()) as IngestResponse;
        })(),
        deadline,
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    const confirmed =
      Number(result.accepted ?? 0) +
      Number(result.duplicates ?? 0) +
      Number(result.stale ?? 0);
    if (result.ok !== true || confirmed !== events.length) {
      throw new Error(
        `Dashboard ingest confirmed ${confirmed}/${events.length} events`,
      );
    }
    const locksSkipped = Number(result.locksSkipped ?? 0);
    if (Number.isFinite(locksSkipped) && locksSkipped > 0) {
      // Not an error: the batch WAS delivered and is correctly acknowledged.
      // But the lock did not happen, so it must stay visible to confirmLocks()
      // instead of being silently written off.
      this.log.warn(
        { locksSkipped, batchSize: events.length },
        "dashboard accepted delivery but skipped containment locks",
      );
    }
    return {
      locksSkipped: Number.isFinite(locksSkipped) ? locksSkipped : 0,
    };
  }

  private async confirmContainmentEvents(
    client: pg.PoolClient,
    events: RiskEventRow[],
    locksSkipped = 0,
  ): Promise<void> {
    const eventIds = events
      .filter(
        (event) =>
          event.event_type === "fiat_blacklisted_email_domain"
          && objectPayload(event.payload).reviewOnly !== true,
      )
      .map((event) => event.id);
    if (eventIds.length === 0) return;
    // Stamping the lock receipt on a CLEAN success is deliberate: confirmLocks()
    // verifies against the MAIN *mirror*, which lags, so waiting for it would
    // leave freshly-locked accounts pending and re-alerting.
    //
    // But the dashboard also answers HTTP 200 with locksSkipped > 0 when the
    // lock did NOT happen. Stamping then recorded a lock that never existed and
    // removed the row from confirmLocks()'s pending set — the only code that
    // checks user_feature_locks on MAIN — so nothing ever retried or verified
    // it. When a skip is reported we leave lock_delivered_at NULL and let
    // confirmLocks() prove the state against MAIN with its own backoff.
    if (locksSkipped > 0) {
      this.log.warn(
        { eventIds: eventIds.length },
        "containment lock receipt withheld; leaving rows for MAIN verification",
      );
      return;
    }
    await client.query(
      `
        WITH confirmed_matches AS (
          UPDATE fiat_email_domain_matches AS match
          SET
            lock_delivered_at = COALESCE(match.lock_delivered_at, now()),
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
        SELECT count(*) FROM confirmed_matches
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
      if (delivered > 0 && !this.stopped) {
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
